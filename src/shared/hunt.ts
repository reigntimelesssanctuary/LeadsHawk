/**
 * v1.19.0 — Hunt-list ranking helpers.
 *
 * Pure deterministic scoring of Apollo-returned contacts against the
 * Sonnet-derived contact archetype + the opportunity context. NO LLM
 * calls here — scoring runs in microseconds and is debuggable.
 *
 * Weights live as exported constants so a future re-tune is a code
 * change with smoke-test coverage rather than a runtime config knob.
 * Pattern mirrors v1.17's MAX_PRIOR_ADJUSTMENT.
 *
 * Inlined byte-identical into scripts/smoke-perplexity.mjs per the
 * established convention. When this file changes, update the smoke
 * test inline copy too.
 */

import type { ApolloSeniority, ContactArchetype } from './types';

// ─── Tunable weights ────────────────────────────────────────────────
// Sum to 1.0 across positive contributions. anti_pattern_penalty
// SUBTRACTS its weight when triggered.
export const HUNT_WEIGHT_ARCHETYPE_TITLE = 0.40;
export const HUNT_WEIGHT_SENIORITY       = 0.25;
export const HUNT_WEIGHT_DEPARTMENT      = 0.15;
export const HUNT_WEIGHT_ANTI_PATTERN    = 0.10;   // subtracted on match
export const HUNT_WEIGHT_VERIFIED_EMAIL  = 0.05;
export const HUNT_WEIGHT_SIGNAL_KEYWORD  = 0.05;

/** Minimum + maximum contacts persisted per search. */
export const HUNT_MIN_CONTACTS = 3;
export const HUNT_MAX_CONTACTS = 5;

/** Apollo per_page on the people search request. We rank these and take top. */
export const APOLLO_SEARCH_PAGE_SIZE = 25;

// ─── Tokenizer ──────────────────────────────────────────────────────
// Lowercase + strip non-alphanumerics. Common B2B title noise words are
// removed so "VP, Infrastructure & Cloud Ops" tokenizes as
// ['infrastructure', 'cloud', 'ops'] not as ['vp', 'infrastructure', '&',
// 'cloud', 'ops'] — vp is a seniority signal handled separately.
const TITLE_NOISE = new Set([
  'vp', 'vice', 'president', 'svp', 'evp', 'avp',
  'chief', 'head', 'director', 'senior', 'sr', 'junior', 'jr',
  'manager', 'mgr', 'lead', 'principal', 'staff',
  'of', 'the', 'and', 'for', 'a', 'an', 'to',
  'global', 'regional', 'group', 'team'
]);

export function tokenizeTitle(s: string | null | undefined): string[] {
  if (!s) return [];
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0 && !TITLE_NOISE.has(t));
}

// ─── Components ─────────────────────────────────────────────────────

/**
 * Jaccard-like overlap between a contact's title tokens and the union
 * of all target-title tokens from the archetype. Returns 0..1.
 */
export function archetypeTitleMatch(
  title: string | null | undefined,
  targetTitles: string[]
): number {
  const contactTokens = new Set(tokenizeTitle(title));
  if (contactTokens.size === 0 || targetTitles.length === 0) return 0;
  const targetTokens = new Set<string>();
  for (const t of targetTitles) {
    for (const tok of tokenizeTitle(t)) targetTokens.add(tok);
  }
  if (targetTokens.size === 0) return 0;
  let intersection = 0;
  for (const t of contactTokens) if (targetTokens.has(t)) intersection++;
  // Bias slightly toward target side — we want contact-title coverage of the
  // archetype's intent, not symmetric similarity. Denominator = |target|.
  return Math.min(1, intersection / targetTokens.size);
}

/** Exact-match against the archetype's allowed seniorities. */
export function seniorityMatch(
  contactSeniority: ApolloSeniority | string | null | undefined,
  targetSeniorities: ApolloSeniority[]
): number {
  if (!contactSeniority || targetSeniorities.length === 0) return 0;
  return targetSeniorities.includes(contactSeniority as ApolloSeniority) ? 1 : 0;
}

/**
 * Substring match against any of the archetype's target departments.
 * Apollo's department field can be sparse — when missing, returns 0
 * (no penalty, just no contribution).
 *
 * Normalises separator characters (underscore, hyphen, whitespace) to
 * a single space before comparing so "it_operations" (Apollo enum
 * style) matches "IT Operations" (human-readable) and vice versa.
 */
function normaliseDept(s: string): string {
  return s.toLowerCase().replace(/[_\-\s]+/g, ' ').trim();
}
export function departmentMatch(
  contactDept: string | null | undefined,
  targetDepts: string[]
): number {
  if (!contactDept || targetDepts.length === 0) return 0;
  const c = normaliseDept(contactDept);
  for (const t of targetDepts) {
    if (!t) continue;
    const lower = normaliseDept(t);
    if (!lower) continue;
    if (c.includes(lower) || lower.includes(c)) return 1;
  }
  return 0;
}

/**
 * Returns the raw anti-pattern weight when the contact's title matches
 * any anti-pattern term, else 0. Caller subtracts this from hunt_score.
 */
export function antiPatternPenalty(
  title: string | null | undefined,
  antiPatterns: string[]
): number {
  if (!title || antiPatterns.length === 0) return 0;
  const t = title.toLowerCase();
  for (const ap of antiPatterns) {
    if (!ap) continue;
    if (t.includes(ap.toLowerCase())) return HUNT_WEIGHT_ANTI_PATTERN;
  }
  return 0;
}

/** Flat bonus when Apollo flagged the email as verified. */
export function verifiedEmailBonus(emailStatus: string | null | undefined): number {
  return emailStatus === 'verified' ? HUNT_WEIGHT_VERIFIED_EMAIL : 0;
}

/**
 * Award the bonus when the contact's title shares ≥2 keyword tokens with
 * the opportunity's signal/headline language. Common-word noise is filtered
 * via tokenizeTitle.
 */
export function signalKeywordMatch(
  title: string | null | undefined,
  signalText: string | null | undefined
): number {
  if (!title || !signalText) return 0;
  const titleTokens = new Set(tokenizeTitle(title));
  if (titleTokens.size === 0) return 0;
  const signalTokens = tokenizeTitle(signalText);
  let hits = 0;
  for (const t of signalTokens) if (titleTokens.has(t)) hits++;
  return hits >= 2 ? HUNT_WEIGHT_SIGNAL_KEYWORD : 0;
}

// ─── Composite score ────────────────────────────────────────────────

export type RankComponents = {
  archetype_title: number;
  seniority: number;
  department: number;
  anti_pattern_penalty: number;
  verified_bonus: number;
  signal_keyword: number;
};

export type RankableContact = {
  title: string | null;
  seniority: ApolloSeniority | string | null;
  department: string | null;
  email_status: string | null;
};

/**
 * Compose the per-contact hunt score (0..1) given the archetype + the
 * opportunity's signal context. Caller persists both score + components
 * so the operator can inspect WHY a contact landed at a given rank.
 */
export function huntScore(
  contact: RankableContact,
  archetype: ContactArchetype,
  signalText: string | null
): { score: number; components: RankComponents } {
  const archetype_title = archetypeTitleMatch(contact.title, archetype.target_titles);
  const seniority      = seniorityMatch(contact.seniority, archetype.target_seniorities);
  const department     = departmentMatch(contact.department, archetype.target_departments);
  const anti_pattern_penalty = antiPatternPenalty(contact.title, archetype.anti_patterns);
  const verified_bonus = verifiedEmailBonus(contact.email_status);
  const signal_keyword = signalKeywordMatch(contact.title, signalText);

  const raw =
      HUNT_WEIGHT_ARCHETYPE_TITLE * archetype_title
    + HUNT_WEIGHT_SENIORITY       * seniority
    + HUNT_WEIGHT_DEPARTMENT      * department
    - anti_pattern_penalty
    + verified_bonus
    + signal_keyword;

  const score = Math.max(0, Math.min(1, raw));
  const components: RankComponents = {
    archetype_title,
    seniority,
    department,
    anti_pattern_penalty,
    verified_bonus,
    signal_keyword
  };
  return { score, components };
}

/**
 * Rank a batch of Apollo results. Returns the top N (clamped to
 * HUNT_MIN_CONTACTS..HUNT_MAX_CONTACTS) sorted score-descending.
 * Apollo ordering breaks ties (stable on equal scores).
 */
export function rankContacts<T extends RankableContact>(
  contacts: T[],
  archetype: ContactArchetype,
  signalText: string | null
): Array<T & { hunt_rank: number; hunt_score: number; rank_components: RankComponents }> {
  const scored = contacts.map((c, idx) => {
    const { score, components } = huntScore(c, archetype, signalText);
    return { contact: c, idx, score, components };
  });
  // Stable sort: by score desc, then by Apollo original order asc.
  scored.sort((a, b) => (b.score - a.score) || (a.idx - b.idx));
  const top = scored.slice(0, HUNT_MAX_CONTACTS);
  return top.map((s, rank) => ({
    ...s.contact,
    hunt_rank: rank + 1,
    hunt_score: Number(s.score.toFixed(4)),
    rank_components: s.components
  }));
}
