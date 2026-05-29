/**
 * v1.17.0 — learning-signals recompute + read paths.
 *
 * Strategy: full rebuild from the event log + state cache. The aggregate
 * table (learning_signals) is small enough — bounded by the cardinality
 * of (dimension × dimension_value), which is at most a few hundred
 * entries even for a large portfolio — that rebuilding it from scratch
 * after every outcome event is cheap (~50ms on a 1000-opportunity DB)
 * and much simpler than maintaining incremental deltas.
 *
 * Triggers:
 *   1. App startup (idempotent — handles any events that landed between
 *      sessions)
 *   2. After every appendEvent that resolves a closed_won / closed_lost /
 *      reopened — wired in src/main/events.ts
 *
 * Stage 2 reads via getLearningSignals(); it stays a synchronous read
 * against the precomputed table so the scan hot path isn't gated on
 * recompute timing.
 */

import { getDb } from './db.js';
import {
  smoothedCloseRate,
  wilsonScoreInterval,
  meetsLearningThreshold,
  extractDimensions,
  buildLearningStatusSummary,
  type LearningSignalRow,
  type LearningStatusSummary
} from '@shared/learning.js';

type ClosedOppRow = {
  id: number;
  product_id: number | null;
  industry: string | null;
  confidence: number;
  raw_signal: string | null;
  is_closed_won: number;
  is_closed_lost: number;
  close_value: number | null;
};

/**
 * Rebuild the learning_signals table for tenant_id=1 from scratch by
 * scanning every opportunity whose state_cache indicates it has a
 * resolved close (closed_won or closed_lost, with a current effective
 * close event — so reopens that haven't re-closed don't count).
 *
 * Idempotent. Cheap. Returns the row count after rebuild so callers can
 * log the size.
 */
export function recomputeAllLearningSignals(): number {
  const db = getDb();

  const closedOpps = db.prepare(`
    SELECT o.id, o.product_id, o.industry, o.confidence, o.raw_signal,
           s.is_closed_won, s.is_closed_lost, s.close_value
    FROM opportunities o
    JOIN opportunity_state_cache s ON s.opportunity_id = o.id
    WHERE (s.is_closed_won = 1 OR s.is_closed_lost = 1)
      AND s.effective_close_event_id IS NOT NULL
      AND o.tenant_id = 1
  `).all() as ClosedOppRow[];

  // Aggregate per (dimension, dimension_value).
  type Agg = { n_won: number; n_lost: number; sum_value: number };
  const agg = new Map<string, Agg>();

  for (const opp of closedOpps) {
    const dims = extractDimensions({
      product_id: opp.product_id,
      industry: opp.industry,
      confidence: opp.confidence,
      raw_signal: opp.raw_signal
    });
    for (const d of dims) {
      const key = `${d.dimension}::${d.dimension_value}`;
      const a = agg.get(key) || { n_won: 0, n_lost: 0, sum_value: 0 };
      if (opp.is_closed_won === 1) {
        a.n_won++;
        if (typeof opp.close_value === 'number') a.sum_value += opp.close_value;
      }
      if (opp.is_closed_lost === 1) {
        a.n_lost++;
      }
      agg.set(key, a);
    }
  }

  // Wipe + repopulate in a transaction so a partial recompute can't leave
  // the table in an inconsistent state.
  const wipe = db.prepare('DELETE FROM learning_signals WHERE tenant_id = 1');
  const insert = db.prepare(`
    INSERT INTO learning_signals
      (tenant_id, dimension, dimension_value, n_closed_won, n_closed_lost,
       sum_close_value, smoothed_close_rate, raw_close_rate,
       ci_low, ci_high, meets_threshold, last_recomputed_at)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  const txn = db.transaction(() => {
    wipe.run();
    for (const [key, a] of agg) {
      const sep = key.indexOf('::');
      const dimension = key.slice(0, sep);
      const dimension_value = key.slice(sep + 2);
      const total = a.n_won + a.n_lost;
      const smoothed = smoothedCloseRate(a.n_won, a.n_lost);
      const raw = total > 0 ? a.n_won / total : 0;
      const ci = wilsonScoreInterval(a.n_won, total);
      const meets = meetsLearningThreshold({ n_closed_won: a.n_won, n_closed_lost: a.n_lost });
      insert.run(
        dimension,
        dimension_value,
        a.n_won,
        a.n_lost,
        a.sum_value,
        smoothed,
        raw,
        ci.lower,
        ci.upper,
        meets ? 1 : 0
      );
    }
  });
  txn();

  return agg.size;
}

/**
 * Read all learning_signals rows for tenant_id=1. Used by Stage 2 to
 * build the priors prompt block + the per-candidate confidence
 * adjustment, and by the Dashboard "Learning status" card.
 */
export function getLearningSignals(): LearningSignalRow[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT dimension, dimension_value, n_closed_won, n_closed_lost,
           sum_close_value, smoothed_close_rate, raw_close_rate,
           ci_low, ci_high, meets_threshold
    FROM learning_signals
    WHERE tenant_id = 1
  `).all() as Array<{
    dimension: string;
    dimension_value: string;
    n_closed_won: number;
    n_closed_lost: number;
    sum_close_value: number;
    smoothed_close_rate: number;
    raw_close_rate: number;
    ci_low: number;
    ci_high: number;
    meets_threshold: number;
  }>;
  return rows.map((r) => ({
    dimension: r.dimension,
    dimension_value: r.dimension_value,
    n_closed_won: r.n_closed_won,
    n_closed_lost: r.n_closed_lost,
    sum_close_value: r.sum_close_value,
    smoothed_close_rate: r.smoothed_close_rate,
    raw_close_rate: r.raw_close_rate,
    ci_low: r.ci_low,
    ci_high: r.ci_high,
    meets_threshold: r.meets_threshold === 1
  }));
}

/**
 * Read path for the Dashboard "Learning status" card. Combines counts
 * across all dimensions into the structured summary that
 * buildLearningStatusSummary produces from the shared module.
 */
export function getLearningStatusSummary(): LearningStatusSummary {
  const db = getDb();
  const rows = getLearningSignals();
  const totalClosed = (db.prepare(`
    SELECT COUNT(*) AS n
    FROM opportunity_state_cache
    WHERE (is_closed_won = 1 OR is_closed_lost = 1)
      AND effective_close_event_id IS NOT NULL
  `).get() as { n: number }).n;
  return buildLearningStatusSummary(rows, totalClosed);
}
