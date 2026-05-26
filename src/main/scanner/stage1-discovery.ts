/**
 * v1.9.0 — Stage 1 of the two-stage deep scan: open discovery.
 *
 * Perplexity sonar-deep-research call asked to cast a wide net and return
 * a raw list of named-company candidates with citations. NO scoring, NO
 * filtering, NO ICP judgment — that's Stage 2's job.
 *
 * The split exists because the v1.8.x monolithic deep scan was over-
 * constrained — asking ONE model to research + score + filter + match
 * signals + apply ICP + apply own-brand hygiene + obey scan rules at once
 * pushed it toward safe-and-empty. Stage 1 is intentionally permissive.
 */

import { completePerplexity } from '../perplexity.js';
import { resolveScanRecency } from '../recency.js';
import { retrieveRelevantChunks, renderChunksBlock } from '../knowledge-index.js';
import type { Brand, Product, Settings } from '@shared/types';
import type { ScanLog } from '../scanner.js';

export type Stage1Candidate = {
  company: string;
  event: string;
  why_relevant?: string;
  source_url: string;
  source_title?: string;
  source_date?: string | null;
};

export type Stage1Output = {
  candidates: Stage1Candidate[];
  citations: string[];
  raw: any;
};

const STAGE1_SYSTEM = `You are a senior B2B sales-intelligence research analyst with
live web access. Your job in this stage is RESEARCH AND DISCOVERY only —
surfacing named companies that have recently shown events relevant to a
specific brand+product's target customers.

You do NOT score, filter, or judge. A separate downstream step handles that.
Your job is to cast a wide net.

Mandatory: search the live web with multiple distinct queries. Consult
multiple sources. Cite them. A response without citations will be rejected
and retried.

Be inclusive. Surface 15–30 candidates per call. Better to surface a weak
lead and let the downstream step reject it than to filter it out here and
miss it.

Return JSON in the schema you've been given. Reasoning may be extensive but
the JSON output is mandatory.`;

const STAGE1_SCHEMA = {
  type: 'object',
  required: ['candidates'],
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        required: ['company', 'event', 'source_url'],
        properties: {
          company: { type: 'string', description: 'The named organization (the prospective buyer).' },
          event: { type: 'string', description: 'What specifically happened, with date if known.' },
          why_relevant: { type: 'string', description: '1–2 sentences on why this might be a buying signal.' },
          source_url: { type: 'string', description: 'A real URL we can verify.' },
          source_title: { type: 'string', description: 'Page or article title.' },
          source_date: { type: ['string', 'null'], description: 'ISO date or "unknown".' }
        }
      }
    }
  }
};

export async function stage1Discovery(
  brand: Brand,
  product: Product,
  settings: Settings,
  log: ScanLog
): Promise<Stage1Output> {
  const recency = resolveScanRecency(product, brand, settings);
  log(`  Stage 1 recency: ${recency.value} (from ${recency.source})`);

  // Same knowledge retrieval as the monolithic scan so the model has the
  // user's own material to ground on.
  const retrievalQuery = [
    brand.name,
    brand.target_icp || '',
    product.name,
    product.description || '',
    product.signals || ''
  ].filter((s) => s).join('\n');
  const chunks = await retrieveRelevantChunks(retrievalQuery, brand.id, product.id, 5);
  if (chunks.length > 0) {
    log(`  Stage 1 retrieved ${chunks.length} knowledge chunk(s) (best sim ${chunks[0].similarity.toFixed(2)})`);
  }
  const chunksBlock = renderChunksBlock(chunks);

  const prompt = `# Brand
Name: ${brand.name}
Category: ${brand.category || '(unspecified)'}
Description: ${brand.description || '(none on file)'}
Positioning: ${brand.positioning || '(none on file)'}
Target ICP (ideal customer profile): ${brand.target_icp || '(not researched yet — fall back to general knowledge of this brand)'}
Competitive summary: ${brand.competitive_summary || '(none on file)'}
${brand.signals ? `\nBrand-level signals:\n${brand.signals}` : ''}
${brand.research_summary ? `\nBrand research summary:\n${brand.research_summary.slice(0, 1200)}${brand.research_summary.length > 1200 ? '…' : ''}` : ''}

# Product
Product: "${product.name}"
Category: ${product.category || '(unspecified)'}
Description: ${product.description || ''}

Use cases (when this product is a great fit):
${product.use_cases || ''}

Differentiators vs competitors:
${product.differentiators || ''}

Competitors:
${product.competitors || ''}
${product.research_summary ? `\nProduct research summary:\n${product.research_summary.slice(0, 1500)}${product.research_summary.length > 1500 ? '…' : ''}` : ''}

# Buying signals to orient your search (NOT a filter — just orientation)
${product.signals || '(none derived yet)'}

${chunksBlock}

# Time window
Only consider events from the last ${recency.value}.

# Task
Cast a wide net. Identify SPECIFIC NAMED COMPANIES that have recently shown
events relevant to this brand+product's target customers.

Examples of events you should surface:
- Press releases or news about expansion, M&A, lease signings, exec changes,
  capital allocations, regulatory filings, lawsuits, breaches
- Job postings indicating organizational moves
- Industry coverage of specific customers in transition

For each candidate, return:
- company: the named organization
- event: what specifically happened (with date if known)
- why_relevant: 1–2 sentences on why this might be a buying signal
- source_url: a real URL we can verify
- source_title: page or article title
- source_date: ISO date or "unknown"

Return 15–30 candidates. Do NOT filter, score, or judge. The downstream
qualifier will handle that. If a candidate seems weak, include it anyway —
the qualifier will drop it.

Empty result is only acceptable if you have genuinely researched the window
and found nothing — and even then, you must have cited the searches you tried.`;

  const model = settings.deepScanModel || 'sonar-deep-research';
  const r = await completePerplexity<{ candidates: Stage1Candidate[] }>(
    STAGE1_SYSTEM,
    prompt,
    {
      model,
      maxTokens: 24000,
      temperature: 0.2,
      searchRecency: recency.value,
      jsonSchema: STAGE1_SCHEMA,
      stage: 'deep_scan_discovery',
      relatedId: product.id
    }
  );

  const completionTokens = Number(r.usage?.completion_tokens ?? 0);
  if (!r.json) {
    const head = (r.text || '').slice(0, 800).replace(/\s+/g, ' ');
    const tail = (r.text || '').slice(-200).replace(/\s+/g, ' ');
    log(`  ! Stage 1 unparseable response (${(r.text || '').length} chars, ${completionTokens} completion tokens)`);
    log(`    head: ${head}`);
    log(`    tail: …${tail}`);
    return { candidates: [], citations: r.citations || [], raw: r.raw };
  }
  const candidates = Array.isArray(r.json.candidates) ? r.json.candidates : [];
  log(`  Stage 1 returned ${candidates.length} raw candidate(s), ${(r.citations || []).length} citation(s), ${completionTokens} completion tokens`);
  return { candidates, citations: r.citations || [], raw: r.raw };
}
