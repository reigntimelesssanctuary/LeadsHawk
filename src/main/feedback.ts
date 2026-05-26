/**
 * v1.9.2 — Reviewer feedback for re-research runs.
 *
 * The user (or a brand owner reviewing the dossier) can submit free-text
 * feedback that gets injected into the next research run's prompt. Feedback
 * is persisted per target so prior corrections aren't lost across iterations
 * — every re-research re-applies the full history (newest first) up to a
 * total-block cap.
 *
 * Used by:
 *   v1.9.2 — researchBrandSignals / researchProductSignals (kinds: 'brand_signals' | 'product_signals')
 *   v1.10.0 (planned) — researchBrand / researchProduct dossier work (kinds: 'brand' | 'product')
 */

import { getDb } from './db.js';

export type FeedbackTargetKind =
  | 'brand'
  | 'product'
  | 'brand_signals'
  | 'product_signals';

export type DossierFeedback = {
  id: number;
  target_kind: FeedbackTargetKind;
  target_id: number;
  feedback: string;
  applied_at: string | null;
  created_at: string;
};

/** Per-submission cap. Validated server-side so the renderer can't bypass. */
export const FEEDBACK_MAX_CHARS = 4000;

/** Total feedback-block cap when assembling for a prompt. */
export const FEEDBACK_BLOCK_MAX_CHARS = 16_000;

/** History returned, newest-first. Pass `limit` to cap. */
export function listFeedback(
  kind: FeedbackTargetKind,
  targetId: number,
  limit = 50
): DossierFeedback[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM dossier_feedback
       WHERE target_kind = ? AND target_id = ?
       ORDER BY datetime(created_at) DESC, id DESC
       LIMIT ?`
    )
    .all(kind, targetId, limit) as DossierFeedback[];
}

/**
 * Persist a new feedback submission. Throws on empty or over-cap input so
 * the IPC layer can surface a clean error to the renderer.
 *
 * Returns the inserted row's id.
 */
export function addFeedback(
  kind: FeedbackTargetKind,
  targetId: number,
  feedback: string
): number {
  const trimmed = (feedback || '').trim();
  if (!trimmed) {
    throw new Error('Feedback cannot be empty.');
  }
  if (trimmed.length > FEEDBACK_MAX_CHARS) {
    throw new Error(
      `Feedback is too long (${trimmed.length} / ${FEEDBACK_MAX_CHARS} chars). Trim it down or split across multiple submissions.`
    );
  }
  const db = getDb();
  const info = db
    .prepare(
      `INSERT INTO dossier_feedback(target_kind, target_id, feedback)
       VALUES (?, ?, ?)`
    )
    .run(kind, targetId, trimmed);
  return Number(info.lastInsertRowid);
}

/** Stamp `applied_at` on a feedback row once the research run consuming it succeeds. */
export function markFeedbackApplied(id: number): void {
  const db = getDb();
  db.prepare(
    `UPDATE dossier_feedback SET applied_at = datetime('now') WHERE id = ?`
  ).run(id);
}

/**
 * Render the feedback history as a prompt-ready block, newest-first,
 * truncated to fit FEEDBACK_BLOCK_MAX_CHARS. Returns '' when no feedback
 * exists for this target.
 *
 * Truncation strategy: include entries newest-first until the budget is
 * exhausted. Drop older entries entirely rather than partial-truncate
 * individual entries (so a half-feedback doesn't mislead the model).
 */
export function buildFeedbackBlock(
  kind: FeedbackTargetKind,
  targetId: number
): string {
  const entries = listFeedback(kind, targetId);
  if (entries.length === 0) return '';

  const header =
    '# Reviewer feedback to incorporate (apply these corrections)\n' +
    'Brand or product owners reviewed previous research output and asked for the following changes. Honour them — they outrank the model\'s own judgment for the items they cover.\n';

  const lines: string[] = [];
  let used = header.length;
  for (const entry of entries) {
    const date = entry.created_at.slice(0, 10);
    const block = `\n## Feedback from ${date}\n${entry.feedback}\n`;
    if (used + block.length > FEEDBACK_BLOCK_MAX_CHARS) break;
    lines.push(block);
    used += block.length;
  }
  if (lines.length === 0) return '';
  return header + lines.join('');
}
