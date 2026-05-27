/**
 * v1.13.0 — Auto-discover news sources per brand.
 *
 * Parallels the v1.9.2 signal-research decoupling: instead of asking the
 * user to manually find and add RSS feeds for each brand, we use Perplexity
 * with web access to suggest brand-aligned sources. User reviews the
 * suggestions in a modal and selects which to add.
 *
 * Suggestion shape:
 *   - kind: 'rss' (specific publication feed) or 'google_news' (search query)
 *   - name: human-readable label
 *   - url: RSS feed URL (RSS only) — Perplexity is asked to verify these exist
 *   - query: search terms (Google News only) — we construct the RSS URL on add
 *   - why_relevant: 1-sentence justification anchored to the brand's signals
 *
 * Suggestions are NOT auto-added — user reviews and picks via the modal.
 * Once selected, individual sources are added via the existing
 * monitor:sources:create IPC handler.
 */

import { completePerplexity } from './perplexity.js';
import { getSettings } from './settings.js';
import { addFeedback, buildFeedbackBlock, markFeedbackApplied } from './feedback.js';
import { getDb } from './db.js';
import type { Brand, SourceSuggestion, ResearchSourcesResult } from '@shared/types';

const SOURCE_RESEARCH_SYSTEM = `You are a senior B2B sales-intelligence
analyst. You receive a brand dossier and you suggest news sources that
would surface relevant buying signals for that brand's products.

You suggest two kinds of sources:

1. **RSS feeds** from REAL publications.
   - The publication must actually exist.
   - You must provide an accurate RSS feed URL — use live web search to
     verify the URL works. Common RSS endpoints: /rss, /feed, /feed.xml,
     /rss.xml, /atom.xml.
   - Prefer industry-specific publications over generic tech press.

2. **Google News search queries** — search terms that would surface news
   items relevant to the brand's buying signals.
   - Just provide the query string. Use Boolean operators (OR, AND,
     quotes for exact phrases).
   - Aim for queries that are SPECIFIC enough to filter out noise but
     BROAD enough to catch most relevant events.
   - Bad example: "news" (too broad). Good example: "office expansion"
     OR "HQ relocation" Singapore OR APAC.

For each suggestion, provide:
- kind: "rss" or "google_news"
- name: short display name (≤40 chars)
- url (RSS only): verified RSS feed URL
- query (Google News only): the search query string
- why_relevant: 1 sentence on how this source helps find buying signals
  for THIS brand (anchor to the brand's signals + ICP)

List as many sources as are GENUINELY useful for this brand — minimum 5,
no upper cap. Quality over quantity: a few sharp, signal-aligned sources
beat dozens of generic ones. Don't pad to hit a number, and don't
artificially compress either. Mix RSS feeds + Google News queries.

Return JSON matching the schema.`;

const SOURCES_SCHEMA = {
  type: 'object',
  required: ['suggestions'],
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['kind', 'name', 'why_relevant'],
        properties: {
          kind: { type: 'string', enum: ['rss', 'google_news'] },
          name: { type: 'string' },
          url: { type: ['string', 'null'] },
          query: { type: ['string', 'null'] },
          why_relevant: { type: 'string' }
        }
      }
    }
  }
};

export async function researchBrandSources(
  brandId: number,
  options: { feedback?: string } = {}
): Promise<ResearchSourcesResult> {
  const db = getDb();
  const brand = db
    .prepare('SELECT * FROM brands WHERE id = ?')
    .get(brandId) as Brand | undefined;
  if (!brand) throw new Error('Brand not found');
  if (brand.research_status !== 'ready') {
    throw new Error('Run full brand research first — source suggestions need the brand dossier as context.');
  }

  // Persist new feedback (if any) before assembling the block.
  let pendingFeedbackId: number | null = null;
  if (options.feedback && options.feedback.trim()) {
    pendingFeedbackId = addFeedback('brand_sources', brandId, options.feedback);
  }
  const feedbackBlock = buildFeedbackBlock('brand_sources', brandId);

  const prompt = `# Brand
Name: ${brand.name}
Category: ${brand.category || '(unspecified)'}
Description: ${brand.description || '(none on file)'}
Positioning: ${brand.positioning || '(none on file)'}
Target ICP: ${brand.target_icp || '(not researched)'}
Competitive summary: ${brand.competitive_summary || '(none on file)'}
${brand.signals ? `\nBrand-level signals (the events we want to catch):\n${brand.signals}` : ''}
${brand.research_summary ? `\nBrand research summary:\n${brand.research_summary.slice(0, 2000)}${brand.research_summary.length > 2000 ? '…' : ''}` : ''}
${feedbackBlock ? `\n${feedbackBlock}` : ''}

# Task
Suggest 8–15 news sources (RSS + Google News queries, mixed) that would
surface relevant buying signals for THIS brand. Anchor each suggestion
to one or more of the brand's signals above.

Use live web search to verify any RSS URLs you propose actually exist.
If you can't verify a publication's RSS URL, prefer a Google News query
covering the same topic instead.

Return JSON matching the schema.`;

  const { perplexityResearchModel } = getSettings();
  const { json } = await completePerplexity<ResearchSourcesResult>(
    SOURCE_RESEARCH_SYSTEM,
    prompt,
    {
      model: perplexityResearchModel || 'sonar-deep-research',
      maxTokens: 6000,
      temperature: 0.2,
      jsonSchema: SOURCES_SCHEMA,
      stage: 'brand_source_research',
      relatedId: brandId
    }
  );

  if (!json || !Array.isArray(json.suggestions)) {
    throw new Error('Perplexity returned an unparseable source-research response. Try again.');
  }

  // Sanitize suggestions before returning to the renderer.
  const cleaned: SourceSuggestion[] = [];
  for (const s of json.suggestions) {
    if (!s || typeof s !== 'object') continue;
    const kind = s.kind === 'rss' || s.kind === 'google_news' ? s.kind : null;
    if (!kind) continue;
    const name = (s.name || '').trim();
    if (!name) continue;
    const url = kind === 'rss' ? (s.url || '').trim() : '';
    const query = kind === 'google_news' ? (s.query || '').trim() : '';
    if (kind === 'rss' && !url) continue;
    if (kind === 'google_news' && !query) continue;
    cleaned.push({
      kind,
      name: name.slice(0, 80),
      url: url || undefined,
      query: query || undefined,
      why_relevant: (s.why_relevant || '').slice(0, 500)
    });
  }

  if (pendingFeedbackId !== null) markFeedbackApplied(pendingFeedbackId);

  // v1.13.2: persist the suggestions so closing the modal mid-research
  // doesn't waste the spend. UPSERT on brand_id (one pending result per
  // brand). consumed_at NULL means "waiting for user review".
  try {
    const db = getDb();
    db.prepare(
      `INSERT INTO pending_source_suggestions(brand_id, suggestions_json, created_at, consumed_at)
       VALUES (?, ?, datetime('now'), NULL)
       ON CONFLICT(brand_id) DO UPDATE SET
         suggestions_json = excluded.suggestions_json,
         created_at = excluded.created_at,
         consumed_at = NULL`
    ).run(brandId, JSON.stringify(cleaned));
  } catch (e: any) {
    console.warn(`[source-research] failed to persist pending suggestions for brand ${brandId}:`, e?.message || e);
  }

  return { suggestions: cleaned };
}

/**
 * Construct the Google News RSS URL from a search query. Used by the renderer
 * when adding a Google News-kind suggestion. Pure function — exported for
 * smoke testing.
 */
export function buildGoogleNewsRssUrl(query: string): string {
  const encoded = encodeURIComponent((query || '').trim());
  return `https://news.google.com/rss/search?q=${encoded}&hl=en-US&gl=US&ceid=US:en`;
}

/**
 * v1.13.1: compute the `trial_until` timestamp for a new source.
 * Returns null for 'permanent' (no trial). Otherwise a SQLite-format
 * ISO timestamp N hours from now.
 *
 * Pure function — exported for smoke testing.
 */
export function computeTrialUntil(
  period: '24h' | '48h' | '7d' | 'permanent',
  now: Date = new Date()
): string | null {
  if (period === 'permanent') return null;
  const hours = period === '24h' ? 24 : period === '48h' ? 48 : 24 * 7;
  const t = new Date(now.getTime() + hours * 3600 * 1000);
  // SQLite datetime() format: 'YYYY-MM-DD HH:MM:SS'
  return t.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}
