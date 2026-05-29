/**
 * v1.17.0 — Learning loop math + dimension extraction + prompt-block
 * builder + confidence-adjustment helpers.
 *
 * This is phase 2 of the three-phase learning architecture:
 *   - v1.16.0 captured outcomes into opportunity_events (append-only log).
 *   - v1.17.0 (this file) reads those outcomes, aggregates them into
 *     `learning_signals` rows, and feeds the aggregates back into Stage 2
 *     qualification scoring.
 *   - v1.18+ will add cross-tenant aggregation (external_priors).
 *
 * The five cold-start safeguards from the v1.16 design proposal are all
 * exercised here:
 *
 *   1. Sample floor — `meetsLearningThreshold` requires ≥5 closed_won AND
 *      ≥5 closed_lost for a dimension value before any signal influences
 *      scoring. Rows below the floor exist in the table (we still want to
 *      see counts in the UI) but `meets_threshold=0` excludes them from
 *      both `buildLearningPriorsBlock` and `applyPriorAdjustment`.
 *
 *   2. Bayesian smoothing — `smoothedCloseRate` pulls every estimate
 *      toward a prior of 20% (α=1, β=4) so "1/1 closed_won = 100%" never
 *      shows up as a real signal. The smoothing strength is fixed.
 *
 *   3. Confidence intervals — `wilsonScoreInterval` returns the 95% CI on
 *      the raw close rate. UI surfaces the CI width so the user can see
 *      which dimensions are still statistically thin.
 *
 *   4. Magnitude cap — `applyPriorAdjustment` clamps the per-candidate
 *      confidence delta to ±MAX_PRIOR_ADJUSTMENT (default 0.15). Learning
 *      nudges, never overrides. Even if every learned dimension says
 *      "reject," the candidate can lose at most 15 confidence points.
 *
 *   5. Explicit UI surface — `buildLearningStatusSummary` produces the
 *      data structure the Dashboard's "Learning status" card renders.
 *      User can always see "Learning from N closed deals across M
 *      dimensions, K informing scoring."
 *
 * Pure functions. Byte-identical copies inlined in
 * `scripts/smoke-perplexity.mjs` per the established convention.
 */

// ────────────────────────────────────────────────────────────────────────
// Tunables
// ────────────────────────────────────────────────────────────────────────

/** Bayesian prior — alpha. Pseudo-count of prior wins. */
export const DEFAULT_BAYESIAN_ALPHA = 1;

/**
 * Bayesian prior — beta. Pseudo-count of prior losses.
 * α=1 + β=4 → prior close rate = 1/(1+4) = 20%, weighted with 5 pseudo-
 * observations. So "1 won, 0 lost" smooths to (1+1)/(1+4+1+0) = 33%
 * instead of the raw 100%.
 */
export const DEFAULT_BAYESIAN_BETA = 4;

/**
 * Minimum closed-won AND closed-lost samples per dimension value before
 * the row's smoothed rate is allowed to influence scoring. Below this
 * floor the row is still recorded (and shown to the user as "too thin to
 * weigh in") but is excluded from the priors block and from
 * applyPriorAdjustment.
 */
export const MIN_SAMPLES_FOR_THRESHOLD = 5;

/**
 * The maximum magnitude of confidence adjustment that learning is allowed
 * to apply to any single candidate. Even if every learned dimension says
 * "this will close" (smoothed_close_rate=1.0) the candidate's confidence
 * can rise by AT MOST this much. The cap is symmetric for downward.
 *
 * Picked 0.15 because: confidence scores cluster in [0.55, 0.85]. A 0.15
 * adjustment can shift a borderline candidate across the minConfidence
 * threshold (default 0.55) but can't override a 0.30-confidence
 * candidate into qualified, nor a 0.85-confidence into rejected.
 * Learning nudges. The model still leads.
 */
export const MAX_PRIOR_ADJUSTMENT = 0.15;

/**
 * Baseline prior close rate used by `buildLearningPriorsBlock` and
 * `applyPriorAdjustment` to decide whether a learned rate is "above" or
 * "below" what an un-informed model would assume. Matches the Bayesian
 * prior mean (α / (α + β) = 1 / 5 = 0.2).
 */
export const BASELINE_CLOSE_RATE = 0.2;

/**
 * Cap on how many learned rows appear in the priors block sent to Stage 2.
 * Top-K by absolute distance from baseline so the most informative rows
 * surface first. Keeps the prompt block bounded; v1.16 design noted this
 * is the principal context-bloat guard for the learning prompt.
 */
export const MAX_PRIOR_ROWS_IN_PROMPT = 10;

// ────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────

export type DimensionKind = 'product_id' | 'industry' | 'matched_signal' | 'confidence_bucket';

export const DIMENSION_LABELS: Record<DimensionKind, string> = {
  product_id:         'Product',
  industry:           'Industry',
  matched_signal:     'Signal type',
  confidence_bucket:  'Initial confidence'
};

export type LearningSignalRow = {
  dimension: string;
  dimension_value: string;
  n_closed_won: number;
  n_closed_lost: number;
  sum_close_value: number;
  smoothed_close_rate: number;
  raw_close_rate: number;
  ci_low: number;
  ci_high: number;
  meets_threshold: boolean;
};

export type CandidateForAdjustment = {
  product_id?: number | null;
  industry?: string | null;
  confidence?: number;
  matched_signal?: string | null;
};

export type AdjustmentResult = {
  adjusted: number;       // final confidence in [0, 1]
  rawAdjustment: number;  // pre-cap delta (may exceed ±cap)
  capped: number;         // post-cap delta (what was actually applied)
  matches: LearningSignalRow[]; // which learned rows fired
};

// ────────────────────────────────────────────────────────────────────────
// Math
// ────────────────────────────────────────────────────────────────────────

/**
 * Beta-Bernoulli smoothing. Returns the posterior mean given α/β prior
 * and observed counts. With α=1, β=4 (defaults) and zero observations,
 * returns 0.2. As n grows, the prior weight fades and the estimate
 * approaches the raw rate.
 */
export function smoothedCloseRate(
  nWon: number,
  nLost: number,
  alpha: number = DEFAULT_BAYESIAN_ALPHA,
  beta: number = DEFAULT_BAYESIAN_BETA
): number {
  if (alpha < 0 || beta < 0 || nWon < 0 || nLost < 0) return 0;
  const denom = alpha + beta + nWon + nLost;
  if (denom === 0) return 0;
  return (alpha + nWon) / denom;
}

/**
 * Wilson score interval — a better confidence interval for proportion
 * estimates than the naive normal-approximation, especially for small
 * samples or rates near 0 or 1. Returns [lower, upper] bounds at the
 * specified confidence (default 95%).
 */
export function wilsonScoreInterval(
  nWon: number,
  nTotal: number,
  confidence: number = 0.95
): { lower: number; upper: number } {
  if (nTotal === 0) return { lower: 0, upper: 1 };
  if (nWon < 0 || nWon > nTotal) return { lower: 0, upper: 1 };

  // z for two-tailed at the given confidence. Hardcoded common values to
  // keep this self-contained; only 0.95 is currently used by callers.
  const z = confidence >= 0.99 ? 2.576
          : confidence >= 0.95 ? 1.96
          : confidence >= 0.90 ? 1.645
          : 1.96;

  const p = nWon / nTotal;
  const z2 = z * z;
  const denominator = 1 + z2 / nTotal;
  const centre = (p + z2 / (2 * nTotal)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p) + z2 / (4 * nTotal)) / nTotal)) / denominator;
  return {
    lower: Math.max(0, centre - margin),
    upper: Math.min(1, centre + margin)
  };
}

export function meetsLearningThreshold(row: {
  n_closed_won: number;
  n_closed_lost: number;
}): boolean {
  return (
    row.n_closed_won >= MIN_SAMPLES_FOR_THRESHOLD &&
    row.n_closed_lost >= MIN_SAMPLES_FOR_THRESHOLD
  );
}

// ────────────────────────────────────────────────────────────────────────
// Dimension extraction — given an opportunity (or candidate), produce
// the (dimension, value) pairs that the learning loop can score against.
// ────────────────────────────────────────────────────────────────────────

export function extractDimensions(input: {
  product_id?: number | null;
  industry?: string | null;
  confidence?: number;
  raw_signal?: string | null;          // JSON blob from opportunities.raw_signal
  matched_signal?: string | null;      // direct field for candidate-time use
}): Array<{ dimension: DimensionKind; dimension_value: string }> {
  const dims: Array<{ dimension: DimensionKind; dimension_value: string }> = [];

  if (typeof input.product_id === 'number' && input.product_id > 0) {
    dims.push({ dimension: 'product_id', dimension_value: String(input.product_id) });
  }

  if (typeof input.industry === 'string' && input.industry.trim()) {
    dims.push({ dimension: 'industry', dimension_value: input.industry.trim() });
  }

  // Confidence bucket. Three coarse bands based on the model's initial
  // confidence at qualification time.
  const conf = typeof input.confidence === 'number' ? input.confidence : 0;
  let bucket: string;
  if (conf >= 0.75) bucket = 'high';
  else if (conf >= 0.55) bucket = 'medium';
  else bucket = 'low';
  dims.push({ dimension: 'confidence_bucket', dimension_value: bucket });

  // Matched signal — prefer the explicit field, fall back to raw_signal JSON.
  let matched = typeof input.matched_signal === 'string' ? input.matched_signal.trim() : '';
  if (!matched && typeof input.raw_signal === 'string') {
    try {
      const parsed = JSON.parse(input.raw_signal);
      if (parsed && typeof parsed.matched_signal === 'string') {
        matched = parsed.matched_signal.trim();
      }
    } catch { /* malformed — skip */ }
  }
  if (matched) {
    dims.push({ dimension: 'matched_signal', dimension_value: matched });
  }

  return dims;
}

/**
 * Given a candidate to score and the current learning table, returns the
 * subset of learning rows that BOTH match a dimension on the candidate
 * AND meet the sample threshold. Only these get to influence scoring.
 */
export function findRelevantLearnings(
  candidate: CandidateForAdjustment,
  learnings: LearningSignalRow[]
): LearningSignalRow[] {
  const dims = extractDimensions({
    product_id: candidate.product_id ?? null,
    industry: candidate.industry ?? null,
    confidence: candidate.confidence,
    matched_signal: candidate.matched_signal ?? null
  });
  const keys = new Set(dims.map((d) => `${d.dimension}::${d.dimension_value}`));
  return learnings.filter(
    (l) =>
      l.meets_threshold &&
      keys.has(`${l.dimension}::${l.dimension_value}`)
  );
}

// ────────────────────────────────────────────────────────────────────────
// Confidence adjustment — the safe nudge.
// ────────────────────────────────────────────────────────────────────────

/**
 * Adjusts a candidate's raw confidence based on which learned dimensions
 * fire. Each matched row contributes a vote weighted by log(1 + n_total)
 * so big samples count more than small ones. The aggregate delta is
 * clamped to ±MAX_PRIOR_ADJUSTMENT.
 *
 * Returns the adjustment metadata for inclusion in scan logs / debug UI.
 *
 * NB: if no matches fire (cold start), this is a complete no-op —
 * `adjusted` equals `rawConfidence` exactly. The learning loop degrades
 * gracefully to "do nothing" when there's no data yet.
 */
export function applyPriorAdjustment(
  rawConfidence: number,
  candidate: CandidateForAdjustment,
  learnings: LearningSignalRow[],
  cap: number = MAX_PRIOR_ADJUSTMENT
): AdjustmentResult {
  const matches = findRelevantLearnings(candidate, learnings);
  if (matches.length === 0) {
    return { adjusted: rawConfidence, rawAdjustment: 0, capped: 0, matches: [] };
  }

  // Each match contributes (smoothed_rate - baseline) * weight where
  // weight = log(1 + sample size). Then the weighted-mean delta is
  // normalized into [-1, +1] via a divisor that matches the maximum
  // plausible delta (baseline=0.2 → max +0.8 above, max -0.2 below;
  // we use 0.4 as the normalization scale so a typical +0.4 delta
  // maps to +1 → cap, and a -0.2 delta maps to -0.5 → ½ cap).
  let weightedSum = 0;
  let totalWeight = 0;
  for (const m of matches) {
    const weight = Math.log(1 + m.n_closed_won + m.n_closed_lost);
    const delta = m.smoothed_close_rate - BASELINE_CLOSE_RATE;
    weightedSum += delta * weight;
    totalWeight += weight;
  }
  const avgDelta = totalWeight > 0 ? weightedSum / totalWeight : 0;
  const normalized = Math.max(-1, Math.min(1, avgDelta / 0.4));
  const rawAdjustment = normalized * cap;
  const capped = Math.max(-cap, Math.min(cap, rawAdjustment));
  const adjusted = Math.max(0, Math.min(1, rawConfidence + capped));

  return { adjusted, rawAdjustment, capped, matches };
}

// ────────────────────────────────────────────────────────────────────────
// Prompt-block builder — injected at the top of the Stage 2 qualify call.
// ────────────────────────────────────────────────────────────────────────

/**
 * Builds the "Historical performance" block that prepends Stage 2's
 * Sonnet prompt. Surfaces only rows that meet the sample threshold and
 * caps to MAX_PRIOR_ROWS_IN_PROMPT by absolute distance from baseline.
 *
 * Returns an empty string when no rows are informing yet (cold start).
 * Stage 2 then runs unchanged — learning silently degrades to no-op.
 */
export function buildLearningPriorsBlock(learnings: LearningSignalRow[]): string {
  const informing = learnings.filter((l) => l.meets_threshold);
  if (informing.length === 0) return '';

  const sorted = [...informing].sort(
    (a, b) =>
      Math.abs(b.smoothed_close_rate - BASELINE_CLOSE_RATE) -
      Math.abs(a.smoothed_close_rate - BASELINE_CLOSE_RATE)
  );
  const top = sorted.slice(0, MAX_PRIOR_ROWS_IN_PROMPT);

  const positives = top.filter((l) => l.smoothed_close_rate > 0.4);
  const negatives = top.filter((l) => l.smoothed_close_rate < 0.15);
  const neutral = top.filter(
    (l) => l.smoothed_close_rate >= 0.15 && l.smoothed_close_rate <= 0.4
  );

  if (positives.length === 0 && negatives.length === 0 && neutral.length === 0) return '';

  let block = `# Historical performance (priors from your closed deals)

These patterns come from REAL outcomes in this portfolio, not the model's
training data. Weight them heavily when deciding fit and confidence.

`;

  if (positives.length > 0) {
    block += 'Patterns that have CLOSED-WON well for this portfolio:\n';
    for (const p of positives) {
      const label = DIMENSION_LABELS[p.dimension as DimensionKind] || p.dimension;
      const pct = Math.round(p.smoothed_close_rate * 100);
      block += `  - ${label}: "${p.dimension_value}" — ${p.n_closed_won}/${p.n_closed_won + p.n_closed_lost} closed-won (${pct}% smoothed rate)\n`;
    }
    block += '\n';
  }

  if (negatives.length > 0) {
    block += 'Patterns that have CLOSED-LOST often for this portfolio:\n';
    for (const n of negatives) {
      const label = DIMENSION_LABELS[n.dimension as DimensionKind] || n.dimension;
      const pct = Math.round(n.smoothed_close_rate * 100);
      block += `  - ${label}: "${n.dimension_value}" — ${n.n_closed_won}/${n.n_closed_won + n.n_closed_lost} closed-won (${pct}% smoothed rate)\n`;
    }
    block += '\n';
  }

  block += `GUIDANCE: if the new candidate shares POSITIVE patterns above, lean toward
qualifying with confidence in the 0.65-0.85 range unless evidence is weak. If
it shares NEGATIVE patterns, lean toward rejecting unless the rest of the
evidence is exceptional. The downstream confidence adjuster will apply a
small (±0.15) correction on top of your scoring — your job is the structural
qualification call; the adjuster handles the magnitude tuning.

`;

  return block;
}

// ────────────────────────────────────────────────────────────────────────
// UI summary — what the Dashboard's "Learning status" card renders.
// ────────────────────────────────────────────────────────────────────────

export type LearningStatusSummary = {
  total_outcomes_observed: number;     // n_won + n_lost across all rows? No — distinct opportunities
  total_dimensions_tracked: number;    // distinct dimension values in the table
  informing_dimensions: number;        // count of rows where meets_threshold
  by_dimension: Array<{
    dimension: string;
    label: string;
    total_rows: number;
    informing_rows: number;
    sample_top: Array<{
      dimension_value: string;
      n_closed_won: number;
      n_closed_lost: number;
      smoothed_close_rate: number;
      meets_threshold: boolean;
    }>;
  }>;
};

export function buildLearningStatusSummary(
  learnings: LearningSignalRow[],
  totalClosedOpps: number
): LearningStatusSummary {
  const byDim = new Map<string, LearningSignalRow[]>();
  for (const row of learnings) {
    const list = byDim.get(row.dimension) || [];
    list.push(row);
    byDim.set(row.dimension, list);
  }

  const by_dimension = Array.from(byDim.entries()).map(([dimension, rows]) => {
    const informing = rows.filter((r) => r.meets_threshold);
    // Sort by absolute distance from baseline for the sample preview;
    // informing rows surface first.
    const sorted = [...rows].sort((a, b) => {
      if (a.meets_threshold !== b.meets_threshold) {
        return a.meets_threshold ? -1 : 1;
      }
      const aN = a.n_closed_won + a.n_closed_lost;
      const bN = b.n_closed_won + b.n_closed_lost;
      return bN - aN;
    });
    return {
      dimension,
      label: DIMENSION_LABELS[dimension as DimensionKind] || dimension,
      total_rows: rows.length,
      informing_rows: informing.length,
      sample_top: sorted.slice(0, 5).map((r) => ({
        dimension_value: r.dimension_value,
        n_closed_won: r.n_closed_won,
        n_closed_lost: r.n_closed_lost,
        smoothed_close_rate: r.smoothed_close_rate,
        meets_threshold: r.meets_threshold
      }))
    };
  });

  return {
    total_outcomes_observed: totalClosedOpps,
    total_dimensions_tracked: learnings.length,
    informing_dimensions: learnings.filter((l) => l.meets_threshold).length,
    by_dimension: by_dimension.sort((a, b) => b.informing_rows - a.informing_rows)
  };
}
