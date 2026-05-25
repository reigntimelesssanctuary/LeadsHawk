/**
 * URL hygiene for scanner candidates.
 *
 * Perplexity is grounded in real web search, but the LLM occasionally
 * returns a plausible-looking source_url that doesn't actually appear in
 * its own citations — either a paraphrase ("the Reuters article" →
 * https://reuters.com/some/made/up/path) or a malformed copy of a real URL
 * (trailing punctuation, surrounding parens, etc.).
 *
 * We can't verify every URL with an HTTP fetch at insert time without
 * blowing up scan duration, but we CAN:
 *   1. Sanitize obvious junk (trailing punctuation, surrounding quotes).
 *   2. Validate URL shape (http/https only, parseable).
 *   3. Cross-reference against the citations the Perplexity API returned
 *      alongside the JSON — if the LLM's claimed URL doesn't appear
 *      there, we substitute the most likely citation match.
 *
 * Anything that fails all three steps is rejected entirely (better than
 * pointing the user at a dead link).
 */

/** Hosts the LLM sometimes invents as a stand-in. */
const PLACEHOLDER_HOSTS = new Set(['example.com', 'example.org', 'example.net', 'site.com']);

/** Strip wrapping junk + trailing punctuation that gets glued onto URLs. */
export function cleanUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = String(raw).trim();
  if (!s) return null;
  // v1.8.5: iterate stripping until stable. Handles nested wrappers like
  //   "(https://example.com/path)."
  // where a single pass leaves either the closing `)` or the trailing `.`
  // attached depending on which regex runs first.
  let prev = '';
  while (prev !== s) {
    prev = s;
    // Strip wrapping quotes / parens / brackets at edges.
    s = s.replace(/^[<("'\[]+|[>)"'\]]+$/g, '');
    // Strip trailing sentence punctuation often glued by paraphrasing.
    s = s.replace(/[.,;:!?]+$/, '');
  }
  // Markdown link form: [text](url)
  const md = s.match(/\((https?:\/\/[^\s)]+)\)\s*$/);
  if (md) s = md[1];
  // Reject obvious non-URLs.
  if (!/^https?:\/\//i.test(s)) return null;
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  if (PLACEHOLDER_HOSTS.has(u.hostname.toLowerCase())) return null;
  // Drop the URL fragment — citations rarely include it and it can break matches.
  u.hash = '';
  return u.toString();
}

/** Normalised form for comparing two URLs without being thrown off by trailing slashes or query order. */
function canonicalize(s: string): string {
  try {
    const u = new URL(s);
    let host = u.hostname.toLowerCase();
    if (host.startsWith('www.')) host = host.slice(4);
    const path = u.pathname.replace(/\/+$/, '');
    return host + path + (u.search || '');
  } catch {
    return s.toLowerCase();
  }
}

/**
 * Pick the best source URL for a candidate:
 *   1. Clean the LLM's stated URL.
 *   2. If it matches a citation (canonical compare), keep it.
 *   3. Otherwise, fall back to the first citation that survives cleaning.
 *   4. If no citations at all, the LLM URL stands or falls on its own
 *      (returned if cleanable, null if not).
 *
 * Returns { url, source } so callers can log when a substitution happened.
 */
export function pickBestSourceUrl(
  llmUrl: string | null | undefined,
  citations: string[] | undefined
): { url: string | null; source: 'llm' | 'citation' | 'llm_unverified' } {
  const cleanedLlm = cleanUrl(llmUrl);
  const cleanedCites = (citations || [])
    .map((c) => cleanUrl(c))
    .filter((c): c is string => !!c);

  if (cleanedLlm && cleanedCites.length > 0) {
    const llmCanon = canonicalize(cleanedLlm);
    const match = cleanedCites.find((c) => canonicalize(c) === llmCanon);
    if (match) return { url: match, source: 'llm' };
    // No exact match — but if the host matches, the LLM probably
    // paraphrased the path; prefer the citation that shares a host.
    const llmHost = (() => { try { return new URL(cleanedLlm).hostname.replace(/^www\./, ''); } catch { return ''; } })();
    if (llmHost) {
      const hostMatch = cleanedCites.find((c) => {
        try { return new URL(c).hostname.replace(/^www\./, '') === llmHost; } catch { return false; }
      });
      if (hostMatch) return { url: hostMatch, source: 'citation' };
    }
    // Last resort — first citation.
    return { url: cleanedCites[0], source: 'citation' };
  }

  if (!cleanedLlm && cleanedCites.length > 0) {
    return { url: cleanedCites[0], source: 'citation' };
  }

  if (cleanedLlm) {
    return { url: cleanedLlm, source: 'llm_unverified' };
  }

  return { url: null, source: 'llm_unverified' };
}

/** Used by the renderer to filter the alternative-citations list. */
export function dedupeCleanCitations(citations: string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of citations || []) {
    const cleaned = cleanUrl(c);
    if (!cleaned) continue;
    const key = canonicalize(cleaned);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return out;
}
