/**
 * v1.3 — Layer A of the disqualification learning loop.
 *
 * When the user disqualifies an opportunity (optionally with a one-line
 * reason), we pull the last N rejections for that product and inject them
 * into Stage 3 (triage) and Stage 4 (qualify) prompts so the LLM mirrors
 * the user's judgment within a day or so of feedback.
 *
 * Layer B (cosine-similarity penalty in the local pre-filter) lives in
 * `monitor/embed.ts` and is gated by ≥3 disqualifications per product so it
 * doesn't fire on noise.
 */

import { getDb } from './db.js';

type DisqRow = {
  headline: string;
  signal_summary: string | null;
  disqualify_reason: string | null;
};

/**
 * Returns up to `limit` recent disqualifications for the product, formatted
 * as `- "<headline>" — reason: <reason>` lines. Most recent first.
 * If there are none, returns an empty array.
 */
export function getRecentDisqualifications(productId: number, limit = 8): string[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT headline, signal_summary, disqualify_reason
       FROM opportunities
       WHERE product_id = ?
         AND status = 'disqualified'
       ORDER BY
         CASE WHEN disqualify_reason IS NOT NULL AND length(trim(disqualify_reason)) > 0 THEN 0 ELSE 1 END,
         updated_at DESC
       LIMIT ?`
    )
    .all(productId, limit) as DisqRow[];

  return rows.map((r) => {
    const reason =
      r.disqualify_reason && r.disqualify_reason.trim().length > 0
        ? r.disqualify_reason.trim()
        : '(no reason given)';
    return `- "${r.headline}" — reason: ${reason}`;
  });
}

/**
 * Returns a prompt-ready block, or empty string if the user hasn't
 * disqualified anything for this product yet. Keep the block compact —
 * the goal is to shift behavior, not balloon token budgets.
 */
export function buildDisqualificationsBlock(productId: number, limit = 8): string {
  const lines = getRecentDisqualifications(productId, limit);
  if (lines.length === 0) return '';
  return [
    '# Previously rejected (user disqualified these — apply the same judgment)',
    'These are real items the user looked at and rejected. Mirror their reasoning:',
    ...lines,
    'If the current candidate is substantively similar to any of the above, lean toward rejecting it.'
  ].join('\n');
}

/**
 * Count of disqualifications for a product. Used by Layer B to decide
 * whether there's enough signal to apply the fingerprint penalty.
 */
export function disqualificationCount(productId: number): number {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT COUNT(*) AS c FROM opportunities WHERE product_id = ? AND status = 'disqualified'"
    )
    .get(productId) as { c: number };
  return Number(row?.c || 0);
}
