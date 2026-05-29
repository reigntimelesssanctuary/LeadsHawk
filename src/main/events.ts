/**
 * v1.16.0 — opportunity event log + state cache module.
 *
 * Responsibilities:
 *   - Append lifecycle events (with validation, optional embedding, and
 *     atomic state-cache rebuild + legacy-status sync).
 *   - List events for an opportunity (timeline view).
 *   - Backfill synthetic 'created' events at app startup for any
 *     opportunity that pre-dates v1.16.
 *   - Provide pipeline-summary read paths used by the Dashboard.
 *
 * Architecture rules (see src/shared/lifecycle.ts for the reducer):
 *   - opportunity_events is APPEND-ONLY. No update/delete paths exist in
 *     this module.
 *   - opportunity_state_cache is a derived projection. The only producer
 *     is rebuildStateCache below; it reads the full event log and runs
 *     projectOpportunityState.
 *   - opportunities.status (the legacy column) is kept in sync with the
 *     projected stage by syncOpportunityStatus so existing UI that reads
 *     .status keeps working unchanged.
 */

import { getDb } from './db.js';
import { embedText } from './monitor/embed.js';
import { recomputeAllLearningSignals } from './learning-signals.js';
import {
  projectOpportunityState,
  eventValidator,
  stageToLegacyStatus,
  type EventType,
  type OpportunityEvent,
  type ActorKind
} from '@shared/lifecycle.js';

// v1.17.0: events that resolve (or unresolve) an outcome trigger a
// learning_signals recompute. recomputeAllLearningSignals is cheap
// (~50ms even on portfolios with hundreds of closed deals) so we don't
// bother with incremental updates.
const RECOMPUTE_LEARNING_TYPES: EventType[] = ['closed_won', 'closed_lost', 'reopened'];

// Events that get embedded at record time so v1.17 RAG retrieval can
// later find semantically similar past outcomes when scoring a new
// candidate. Free + on-device (MiniLM); non-fatal if it errors out.
const EMBED_EVENT_TYPES: EventType[] = ['closed_won', 'closed_lost'];

export type AppendEventInput = {
  opportunityId: number;
  eventType: EventType;
  payload?: any;
  actorKind?: ActorKind;
  actorId?: string | null;
  provenance?: string | null;
  occurredAt?: string; // ISO timestamp; defaults to now()
};

export async function appendEvent(input: AppendEventInput): Promise<OpportunityEvent> {
  const db = getDb();

  // Validate against controlled vocab.
  const err = eventValidator(input.eventType, input.payload);
  if (err) throw new Error(err);

  // Confirm parent opportunity exists. SQL FK enforcement would catch
  // this too but the error message would be cryptic; surface a clean one.
  const opp = db.prepare('SELECT * FROM opportunities WHERE id = ?').get(input.opportunityId);
  if (!opp) throw new Error(`Opportunity ${input.opportunityId} not found`);

  // Embed outcome events for v1.17 RAG. Non-fatal: if embedding errors
  // out (model not ready, etc.), the event still records.
  let embedding: string | null = null;
  if (EMBED_EVENT_TYPES.includes(input.eventType)) {
    try {
      const text = buildEventEmbeddingText(opp as any, input.eventType, input.payload);
      if (text) {
        const vec = await embedText(text);
        embedding = JSON.stringify(vec);
      }
    } catch (e: any) {
      console.warn(`[events:append] embedding failed for ${input.eventType}: ${e?.message || e}`);
    }
  }

  const now = new Date().toISOString();
  const occurredAt = input.occurredAt || now;

  const result = db.prepare(`
    INSERT INTO opportunity_events
      (tenant_id, opportunity_id, event_type, payload_json, occurred_at, recorded_at, actor_kind, actor_id, provenance, embedding)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.opportunityId,
    input.eventType,
    input.payload ? JSON.stringify(input.payload) : null,
    occurredAt,
    now,
    input.actorKind || 'user',
    input.actorId || null,
    input.provenance || null,
    embedding
  );

  const eventId = Number(result.lastInsertRowid);

  // Rebuild derived state + sync the legacy opportunities.status.
  rebuildStateCache(input.opportunityId);
  syncOpportunityStatus(input.opportunityId);

  // v1.17.0: recompute the learning aggregates when an outcome resolves
  // or unresolves. Non-fatal: if the recompute throws, the event is
  // still persisted and the state cache is consistent — just the
  // learning_signals table is stale until the next trigger.
  if (RECOMPUTE_LEARNING_TYPES.includes(input.eventType)) {
    try {
      const n = recomputeAllLearningSignals();
      console.log(`[learning] recomputed ${n} dimension/value rows after ${input.eventType}`);
    } catch (e: any) {
      console.warn('[learning] recompute failed:', e?.message || e);
    }
  }

  return db.prepare('SELECT * FROM opportunity_events WHERE id = ?').get(eventId) as OpportunityEvent;
}

function buildEventEmbeddingText(opp: any, eventType: EventType, payload: any): string {
  const parts: string[] = [];
  if (opp.company) parts.push(opp.company);
  if (opp.industry) parts.push(opp.industry);
  if (opp.signal_summary) parts.push(opp.signal_summary);
  if (eventType === 'closed_won' && payload?.primary_factor) {
    parts.push(`won via ${payload.primary_factor}`);
  }
  if (eventType === 'closed_lost' && payload?.reason_code) {
    parts.push(`lost due to ${payload.reason_code}`);
  }
  return parts.join(' — ').trim();
}

export function listEvents(opportunityId: number): OpportunityEvent[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM opportunity_events
    WHERE opportunity_id = ?
    ORDER BY occurred_at ASC, id ASC
  `).all(opportunityId) as OpportunityEvent[];
}

export function rebuildStateCache(opportunityId: number): void {
  const db = getDb();
  const events = listEvents(opportunityId);
  const state = projectOpportunityState(events);
  if (!state) {
    db.prepare('DELETE FROM opportunity_state_cache WHERE opportunity_id = ?').run(opportunityId);
    return;
  }
  db.prepare(`
    INSERT INTO opportunity_state_cache (
      opportunity_id, current_stage, delivered_at, accepted_at, closed_at,
      close_value, close_currency, cycle_days, primary_factor,
      is_closed_won, is_closed_lost, effective_close_event_id,
      last_event_id, last_event_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(opportunity_id) DO UPDATE SET
      current_stage = excluded.current_stage,
      delivered_at = excluded.delivered_at,
      accepted_at = excluded.accepted_at,
      closed_at = excluded.closed_at,
      close_value = excluded.close_value,
      close_currency = excluded.close_currency,
      cycle_days = excluded.cycle_days,
      primary_factor = excluded.primary_factor,
      is_closed_won = excluded.is_closed_won,
      is_closed_lost = excluded.is_closed_lost,
      effective_close_event_id = excluded.effective_close_event_id,
      last_event_id = excluded.last_event_id,
      last_event_at = excluded.last_event_at
  `).run(
    opportunityId,
    state.current_stage,
    state.delivered_at,
    state.accepted_at,
    state.closed_at,
    state.close_value,
    state.close_currency,
    state.cycle_days,
    state.primary_factor,
    state.is_closed_won ? 1 : 0,
    state.is_closed_lost ? 1 : 0,
    state.effective_close_event_id,
    state.last_event_id,
    state.last_event_at
  );
}

function syncOpportunityStatus(opportunityId: number): void {
  const db = getDb();
  const row = db.prepare(
    'SELECT current_stage FROM opportunity_state_cache WHERE opportunity_id = ?'
  ).get(opportunityId) as { current_stage: any } | undefined;
  if (!row) return;
  const legacy = stageToLegacyStatus(row.current_stage);
  db.prepare('UPDATE opportunities SET status = ? WHERE id = ?').run(legacy, opportunityId);
}

/**
 * Sync helper called by the scanner immediately after inserting a new
 * opportunity row. The 'created' event doesn't need embedding (only
 * closed_won / closed_lost do), so we skip the async path and INSERT
 * inline. Keeps the scanner hot path fast and avoids leaking async
 * through insertCandidates' signature.
 *
 * Idempotent: if a 'created' event already exists for this opportunity,
 * this is a no-op (defensive — should never happen during a normal scan).
 */
export function recordCreatedEventForOpportunity(
  opportunityId: number,
  provenance: string
): void {
  const db = getDb();
  const existing = db.prepare(
    "SELECT 1 FROM opportunity_events WHERE opportunity_id = ? AND event_type = 'created' LIMIT 1"
  ).get(opportunityId);
  if (existing) return;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO opportunity_events
      (tenant_id, opportunity_id, event_type, payload_json, occurred_at, recorded_at, actor_kind, provenance)
    VALUES (1, ?, 'created', NULL, ?, ?, 'system', ?)
  `).run(opportunityId, now, now, provenance);
  rebuildStateCache(opportunityId);
}

/**
 * One-shot migration helper invoked at app startup. For every opportunity
 * that doesn't yet have a 'created' event, synthesize one from its
 * existing created_at timestamp so historical data shows up in the new
 * lifecycle widgets without manual intervention.
 *
 * Idempotent: re-running emits nothing once each opportunity has at least
 * one 'created' event in its log.
 *
 * Returns the number of events synthesized.
 */
export function backfillCreatedEvents(): number {
  const db = getDb();
  const rows = db.prepare(`
    SELECT o.id, o.created_at
    FROM opportunities o
    WHERE NOT EXISTS (
      SELECT 1 FROM opportunity_events e
      WHERE e.opportunity_id = o.id AND e.event_type = 'created'
    )
  `).all() as Array<{ id: number; created_at: string }>;

  const now = new Date().toISOString();
  const insertStmt = db.prepare(`
    INSERT INTO opportunity_events
      (tenant_id, opportunity_id, event_type, payload_json, occurred_at, recorded_at, actor_kind, provenance)
    VALUES (1, ?, 'created', NULL, ?, ?, 'system', 'backfill-v1.16')
  `);

  const txn = db.transaction((batch: Array<{ id: number; created_at: string }>) => {
    for (const r of batch) {
      insertStmt.run(r.id, r.created_at || now, now);
    }
  });

  if (rows.length > 0) {
    txn(rows);
    // Rebuild state cache outside the txn so each row's projection runs
    // against its fully-committed event row.
    for (const r of rows) {
      rebuildStateCache(r.id);
    }
  }

  return rows.length;
}

// ────────────────────────────────────────────────────────────────────────
// Pipeline summary + filtered listing for the Dashboard.
// ────────────────────────────────────────────────────────────────────────

export type PipelineSummaryRow = {
  by_stage: Record<string, number>;
  total_opportunities: number;
  total_won: number;
  total_lost: number;
  total_won_value: number;
  avg_cycle_days: number | null;
  win_rate: number | null;
  closed_this_month: number;
  won_this_month_value: number;
};

const MIN_DEALS_FOR_WIN_RATE = 3;

export function getPipelineSummary(): PipelineSummaryRow {
  const db = getDb();
  const rows = db.prepare(`
    SELECT current_stage, is_closed_won, is_closed_lost, close_value, cycle_days, closed_at
    FROM opportunity_state_cache
  `).all() as Array<{
    current_stage: string;
    is_closed_won: number;
    is_closed_lost: number;
    close_value: number | null;
    cycle_days: number | null;
    closed_at: string | null;
  }>;

  const by_stage: Record<string, number> = {};
  let total_won = 0;
  let total_lost = 0;
  let total_won_value = 0;
  const cycles: number[] = [];
  let closed_this_month = 0;
  let won_this_month_value = 0;

  // "This month" = same year + month as current local time.
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  for (const row of rows) {
    by_stage[row.current_stage] = (by_stage[row.current_stage] || 0) + 1;
    if (row.is_closed_won) {
      total_won++;
      if (typeof row.close_value === 'number') total_won_value += row.close_value;
      if (typeof row.cycle_days === 'number') cycles.push(row.cycle_days);
    }
    if (row.is_closed_lost) {
      total_lost++;
      if (typeof row.cycle_days === 'number') cycles.push(row.cycle_days);
    }
    if (row.closed_at && row.closed_at.startsWith(ym)) {
      closed_this_month++;
      if (row.is_closed_won && typeof row.close_value === 'number') {
        won_this_month_value += row.close_value;
      }
    }
  }

  const totalClosed = total_won + total_lost;
  const win_rate = totalClosed >= MIN_DEALS_FOR_WIN_RATE ? total_won / totalClosed : null;
  const avg_cycle_days = cycles.length > 0
    ? cycles.reduce((a, b) => a + b, 0) / cycles.length
    : null;

  return {
    by_stage,
    total_opportunities: rows.length,
    total_won,
    total_lost,
    total_won_value,
    avg_cycle_days,
    win_rate,
    closed_this_month,
    won_this_month_value
  };
}

/**
 * Returns opportunity ids whose state_cache says they're "stale": sitting
 * in a working stage with last_event_at older than `thresholdDays` days.
 */
export function getStaleOpportunityIds(thresholdDays: number): number[] {
  const db = getDb();
  const cutoff = new Date(Date.now() - thresholdDays * 86400000).toISOString();
  const rows = db.prepare(`
    SELECT opportunity_id
    FROM opportunity_state_cache
    WHERE current_stage IN ('delivered', 'accepted', 'engaged', 'proposal_sent')
      AND last_event_at < ?
  `).all(cutoff) as Array<{ opportunity_id: number }>;
  return rows.map((r) => r.opportunity_id);
}

/**
 * Returns the state_cache row for a single opportunity. Used by the
 * renderer's OpportunityDetail page to render the current stage and
 * close metadata without round-tripping through the event log.
 */
export function getOpportunityState(opportunityId: number): any {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM opportunity_state_cache WHERE opportunity_id = ?'
  ).get(opportunityId);
}
