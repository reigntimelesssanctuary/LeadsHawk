/**
 * v1.15.0 — signal manipulation helpers.
 *
 * Brand-level and product-level signals are stored as a single newline-
 * delimited text blob in `brands.signals` / `products.signals`. Each line
 * is one bullet, optionally prefixed with `- `, `* `, or `• `.
 *
 * Locked signals are tracked in a separate JSON column
 * (`brands.locked_signals` / `products.locked_signals`) as an array of
 * exact bullet-text strings. They survive re-research: the signal-research
 * pipeline prepends them to the prompt as "must include exactly as-is"
 * instructions, AND a post-LLM merge forces them into the result if the
 * model drops or paraphrases them.
 *
 * All functions in this file are PURE. The smoke test inlines byte-
 * identical copies — update both sides when changing behavior.
 */

/**
 * Parse a newline-delimited signals blob into an array of trimmed bullets,
 * stripping common bullet markers. Mirrors the `parseBullets` helper used
 * in the renderer's SignalConfig page so we have a single canonical
 * version. Empty / whitespace-only lines are dropped.
 */
export function parseSignalsBlob(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => l.replace(/^[-*•]\s*/, '').trim())
    .filter((l) => l.length > 0);
}

/**
 * Serialize a bullet array back to the newline-delimited "- bullet" format
 * that gets written to `signals`. The leading "- " marker is added back so
 * parseSignalsBlob's round-trip works and so the text reads naturally if
 * surfaced anywhere as raw.
 */
export function serializeSignals(bullets: string[]): string {
  return bullets
    .map((b) => b.trim())
    .filter((b) => b.length > 0)
    .map((b) => `- ${b}`)
    .join('\n');
}

/**
 * Parse the JSON-encoded locked_signals column into a string array.
 * Defensive: returns [] for null, malformed JSON, or non-array shapes.
 * Drops non-string entries (shouldn't happen, but defensive against
 * future schema drift).
 */
export function parseLockedSignals(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((s): s is string => typeof s === 'string' && s.trim().length > 0);
  } catch {
    return [];
  }
}

/**
 * Serialize a locked-signals array back to JSON for storage. We always
 * emit a JSON array even when empty (rather than null) for query
 * consistency — the DB column itself is nullable for first-install
 * legacy rows.
 */
export function serializeLockedSignals(locked: string[]): string {
  return JSON.stringify(locked.filter((s) => typeof s === 'string' && s.trim().length > 0));
}

/**
 * Force locked signals into a re-researched bullet list.
 *
 * Behavior:
 *   - Locked bullets ALWAYS appear, regardless of whether the LLM
 *     returned them. If the LLM dropped one, it gets force-inserted.
 *   - Locked bullets ALWAYS appear FIRST, in their stored order. The
 *     LLM's fresh discoveries follow.
 *   - Exact-match duplicates are deduped (a locked bullet that the LLM
 *     also returned only appears once). Near-duplicates are accepted —
 *     deduping by semantic similarity is fragile and risks silently
 *     dropping a legitimately different signal.
 *
 * Pure function. Used by signal-research.ts after every Perplexity call.
 */
export function mergeLockedIntoSignals(llmBullets: string[], locked: string[]): string[] {
  const cleanLocked = locked
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const lockedSet = new Set(cleanLocked);
  const fresh = llmBullets
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .filter((s) => !lockedSet.has(s));
  return [...cleanLocked, ...fresh];
}

/**
 * After a user edits a signal bullet (renames it), the locked_signals
 * array must be updated too so the lock continues to point at the right
 * text. Returns the new locked array.
 *
 * If the old text wasn't locked, returns the array unchanged. If multiple
 * entries somehow matched, all are replaced (shouldn't happen, but safe).
 */
export function renameLockedSignal(locked: string[], oldText: string, newText: string): string[] {
  const newTrim = newText.trim();
  if (!newTrim) return locked.filter((s) => s !== oldText);
  return locked.map((s) => (s === oldText ? newTrim : s));
}

/**
 * After a user deletes a signal bullet, remove it from the locked array
 * too so we don't end up with orphan locked entries that point at text
 * no longer present in `signals`.
 */
export function removeLockedSignal(locked: string[], text: string): string[] {
  return locked.filter((s) => s !== text);
}

/**
 * Build the prompt block injected into signal-research re-runs to tell
 * the LLM about locks. The block is empty when no signals are locked.
 *
 * Exported so the renderer's "Re-research with feedback" UX can preview
 * what'll be sent if needed (not currently surfaced, but cheap to keep
 * available).
 */
export function buildLockedSignalsPromptBlock(locked: string[]): string {
  const clean = locked.map((s) => s.trim()).filter((s) => s.length > 0);
  if (clean.length === 0) return '';
  const bullets = clean.map((s) => `  - ${s}`).join('\n');
  return `# Locked signals (MUST KEEP exactly as written)
The reviewer has explicitly pinned the following signals. Include each one
verbatim in your output — do not paraphrase, merge, drop, or reorder them.
After listing the locked signals, continue with any additional signals you
discover that complement them.

${bullets}

`;
}
