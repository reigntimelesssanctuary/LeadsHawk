/**
 * v1.10.2 — Stage 4 of brand/product dossier research: fact-check.
 *
 * Fetches up to N citation URLs from Stage 1, extracts source text via the
 * existing fetchUrl() helper, then asks Claude Opus to verify the verified
 * dossier's claims against the actual source content. Closes the loop on
 * "zero hallucination as we can defensibly achieve" — Stages 2+3 can only
 * reason about what Stage 1 surfaced; Stage 4 actually checks Stage 1's
 * claims against fetched evidence.
 *
 * Failure modes (all handled gracefully):
 *   • URL blocks bots / paywall / JS-rendered SPA → source skipped with error
 *   • All sources fail → Stage 4 skipped with "partial: 0/N" status
 *   • Opus call fails → standard discriminated-union return
 *
 * The fact-check report does NOT modify the canonical dossier columns —
 * it's additive metadata persisted to fact_check_report. Users see the
 * report in a dedicated UI section; downstream consumers (scanner, deep
 * scan) still read the Stage 2 dossier as-is.
 */

import { complete } from '../llm.js';
import { tryParseJson } from '../perplexity.js';
import { fetchUrl } from '../knowledge.js';
import type { StageResult } from './dossier-verify.js';
import type { FactCheckReport } from '@shared/types';

const SOURCE_TEXT_CAP_CHARS = 8000;
const PER_FETCH_TIMEOUT_MS = 15_000;

export type FactCheckInput = {
  targetKind: 'brand' | 'product';
  targetId: number;
  targetName: string;
  verifiedDossier: Record<string, string>;     // section_name → text
  citationUrls: string[];
  maxSources: number;
};

const FACTCHECK_SYSTEM = `You are a senior fact-checking editor. You receive
a verified dossier plus the actual text of up to a dozen sources that the
upstream research consulted. Your job: for each section of the dossier,
verify whether the claims are supported by the cited sources.

Be honest. If a source doesn't actually support a claim the dossier makes,
flag it. If a source contradicts the dossier, flag it more strongly. If a
section is mostly inferred rather than evidence-backed, mark it
"inconclusive" rather than guessing.

You do NOT do web search. You work only with the source texts provided.
Many sources may be incomplete (paywall stubs, navigation pages, etc.) —
don't penalise the dossier for what's not in your sample.

Respond with strictly valid JSON only, no prose, no code fences.`;

function renderSection(name: string, text: string): string {
  return `## ${name}\n${text}`;
}

async function fetchWithTimeout(url: string): Promise<{ url: string; text: string | null; error: string | null }> {
  let timeoutId: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('fetch timeout')), PER_FETCH_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([
      fetchUrl(url),
      timeoutPromise
    ]);
    if (timeoutId) clearTimeout(timeoutId);
    const text = (result?.content || '').slice(0, SOURCE_TEXT_CAP_CHARS);
    if (!text || text.length < 50) {
      return { url, text: null, error: 'no usable text extracted' };
    }
    return { url, text, error: null };
  } catch (e: any) {
    if (timeoutId) clearTimeout(timeoutId);
    return { url, text: null, error: String(e?.message || e).slice(0, 200) };
  }
}

export type FactCheckResult =
  | { kind: 'completed'; report: FactCheckReport }
  | { kind: 'partial'; report: FactCheckReport; warning: string }
  | { kind: 'skipped'; reason: string }
  | { kind: 'failed'; error: string };

export async function factCheckDossier(input: FactCheckInput): Promise<FactCheckResult> {
  const tag = `${input.targetKind} ${input.targetId}`;

  // Limit to maxSources, but only the unique URLs.
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const u of input.citationUrls) {
    const trimmed = (u || '').trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    urls.push(trimmed);
    if (urls.length >= input.maxSources) break;
  }

  if (urls.length === 0) {
    return { kind: 'skipped', reason: 'no citation URLs available from Stage 1' };
  }

  // Fetch all sources in parallel; failed fetches are skipped, not fatal.
  const fetchResults = await Promise.all(urls.map(fetchWithTimeout));
  const usable = fetchResults.filter((r) => r.text && !r.error);
  const sourcesAttempted = urls.length;
  const sourcesFetched = usable.length;
  const unreachableNote = sourcesFetched < sourcesAttempted
    ? `(${sourcesAttempted - sourcesFetched} of ${sourcesAttempted} sources unreachable — paywalls, JS-rendered, bot-blocked, etc.)`
    : '';

  // If we have fewer than 2 usable sources, no point spending Opus tokens.
  if (sourcesFetched < 2) {
    return {
      kind: 'partial',
      report: emptyReport(sourcesAttempted, sourcesFetched),
      warning: `only ${sourcesFetched}/${sourcesAttempted} sources reachable — skipped Opus call`
    };
  }

  const sourcesBlock = usable
    .map((s, i) => `### Source ${i + 1}\nURL: ${s.url}\n${s.text}`)
    .join('\n\n');

  const dossierBlock = Object.entries(input.verifiedDossier)
    .filter(([, v]) => !!v && v.trim())
    .map(([k, v]) => renderSection(k, v))
    .join('\n\n');

  const sectionNames = Object.keys(input.verifiedDossier)
    .filter((k) => !!input.verifiedDossier[k] && input.verifiedDossier[k].trim());

  const prompt = `# Target
${input.targetKind === 'brand' ? 'Brand' : 'Product'}: ${input.targetName}

# Verified dossier (from Stages 1-3)
${dossierBlock}

# Sources (fetched from Stage 1 citations)
${sourcesBlock}

# Task
For each dossier section listed below, return a verdict on whether the
claims are supported by the source texts:

Sections to evaluate: ${sectionNames.join(', ')}

Also produce a list of specific flagged_claims — sentences from the
dossier that look unsupported, contradicted, or thinly evidenced.

Return JSON in exactly this shape:
{
  "overall_confidence": "high" | "medium" | "low",
  "sources_attempted": ${sourcesAttempted},
  "sources_fetched": ${sourcesFetched},
  "per_section_verdicts": {
    "${sectionNames[0]}": {
      "verdict": "verified" | "partially_supported" | "unsupported" | "inconclusive",
      "reasoning": "1-3 sentence explanation",
      "supporting_source_urls": ["url", ...]
    },
    ... one entry per section ...
  },
  "flagged_claims": [
    {
      "claim": "verbatim sentence or paraphrase from the dossier",
      "status": "verified" | "unsupported" | "contradicted" | "inconclusive",
      "source_url": "url or null",
      "reason": "short explanation"
    }
  ]
}

Use "inconclusive" liberally when the sample of sources is too thin to judge
— don't penalise the dossier for what's missing from your fetched sample.`;

  let raw = '';
  try {
    raw = await complete(FACTCHECK_SYSTEM, prompt, {
      model: 'claude-opus-4-7',
      maxTokens: 6000,
      stage: input.targetKind === 'brand' ? 'brand_research_factcheck' : 'product_research_factcheck',
      relatedId: input.targetId
    });
  } catch (e: any) {
    const err = String(e?.message || e).slice(0, 300);
    console.warn(`[dossier-factcheck:${tag}] Opus error: ${err}`);
    return { kind: 'failed', error: `Opus API error: ${err}` };
  }

  const parsed = tryParseJson<FactCheckReport>(raw);
  if (!parsed || !parsed.per_section_verdicts) {
    const head = (raw || '').slice(0, 800).replace(/\s+/g, ' ');
    console.warn(`[dossier-factcheck:${tag}] unparseable Stage 4 response`);
    console.warn(`  head: ${head}`);
    return { kind: 'failed', error: 'Unparseable Stage 4 response (check console log for head/tail preview)' };
  }

  // Force-set the source counts to the actual numbers (in case the model
  // hallucinated them).
  const report: FactCheckReport = {
    overall_confidence: parsed.overall_confidence || 'medium',
    sources_attempted: sourcesAttempted,
    sources_fetched: sourcesFetched,
    per_section_verdicts: parsed.per_section_verdicts,
    flagged_claims: Array.isArray(parsed.flagged_claims) ? parsed.flagged_claims : []
  };

  if (sourcesFetched < sourcesAttempted) {
    return {
      kind: 'partial',
      report,
      warning: `${sourcesFetched}/${sourcesAttempted} sources verified ${unreachableNote}`
    };
  }
  return { kind: 'completed', report };
}

function emptyReport(attempted: number, fetched: number): FactCheckReport {
  return {
    overall_confidence: 'low',
    sources_attempted: attempted,
    sources_fetched: fetched,
    per_section_verdicts: {},
    flagged_claims: []
  };
}

/**
 * v1.10.2: shape-tolerant URL list cap. Exported for smoke testing —
 * dedupes, trims, and caps the input citation list to at most max URLs.
 */
export function clampCitationList(urls: string[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of urls || []) {
    const trimmed = (u || '').trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * v1.10.2: should we even attempt the Opus call given how many sources fetched?
 * Exported pure function for smoke testing.
 */
export function shouldAttemptOpusCall(sourcesFetched: number, minRequired = 2): boolean {
  return sourcesFetched >= minRequired;
}

// Track which Stage 1 citations were actually persisted to brand/product
// raw_dossier. v1.10.0 stored an empty `citations: []` array — this exports
// the citation URLs from raw_dossier for Stage 4 to consume.
export function extractCitationsFromRawDossier(rawDossierJson: string | null): string[] {
  if (!rawDossierJson) return [];
  try {
    const obj = JSON.parse(rawDossierJson);
    if (Array.isArray(obj?.citations)) {
      return obj.citations.filter((u: unknown): u is string => typeof u === 'string');
    }
  } catch {
    // ignore
  }
  return [];
}
