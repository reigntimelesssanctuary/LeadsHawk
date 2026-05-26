/**
 * v1.9.2 — Signal research as a separate job, decoupled from dossier research.
 * v1.9.3 — Hardened parsing: shape-tolerant field extraction + bullet-list
 *          fallback + retry-once + diagnostic logging. The v1.9.2 implementation
 *          consistently failed against sonar-pro because the prescriptive
 *          SYSTEM prompt (with GOOD/BAD examples) was making the model emit
 *          bullets as raw text instead of in the JSON wrapper.
 *
 * Two entrypoints:
 *   researchBrandSignals(brandId, { feedback? })
 *   researchProductSignals(productId, { feedback? })
 *
 * Each runs a single Perplexity sonar-pro call scoped to that target, with
 * the existing dossier as context. Cheap (~$0.005–0.02), fast (a few seconds),
 * accepts optional reviewer feedback that's injected via the v1.9.2
 * feedback module so prior corrections persist across iterations.
 *
 * Brand-signal writes go to `brands.signals` only.
 * Product-signal writes go to `products.signals` AND trigger a re-embed via
 * `embedSignalsForProduct()` so the Live Monitor's pre-filter stays in sync.
 */

import { getDb } from './db.js';
import { completePerplexity, type PplxResponse } from './perplexity.js';
import { getSettings } from './settings.js';
import { embedSignalsForProduct } from './monitor/embed.js';
import { addFeedback, buildFeedbackBlock, markFeedbackApplied } from './feedback.js';
import type { Brand, Product } from '@shared/types';

// v1.9.3: simplified SYSTEM prompt. The v1.9.2 version had GOOD/BAD
// examples that, against sonar-pro, frequently made the model emit a
// raw bullet list instead of structured JSON. Quality guidance now
// lives in the schema field description only.
const SIGNAL_RESEARCH_SYSTEM =
  'You are a senior B2B competitive-intelligence analyst. You produce sharp, concrete buying-signal lists. Always return strictly valid JSON matching the schema you have been given — no preamble, no closing remarks.';

const PRODUCT_SIGNALS_SCHEMA = {
  type: 'object',
  required: ['signals'],
  properties: {
    signals: {
      type: 'string',
      description:
        "Markdown bulleted list of concrete news/event signals (lines starting with '- ') that indicate a buying opportunity for THIS specific product. List as many as are GENUINELY useful — minimum 1, no upper cap. Do not pad to hit a number, and do not compress to fit one. Quality over quantity: a single sharp signal beats ten generic ones."
    }
  }
};

const BRAND_SIGNALS_SCHEMA = {
  type: 'object',
  required: ['signals'],
  properties: {
    signals: {
      type: 'string',
      description:
        "Markdown bulleted list of BRAND-LEVEL buying signals (lines starting with '- ') — events that indicate ANY product from this brand may be needed. Cross-cutting, not product-specific. List as many as are GENUINELY useful — minimum 1, no upper cap. Do not pad to hit a number, and do not compress to fit one. Quality over quantity: a single sharp signal beats ten generic ones."
    }
  }
};

// ─── v1.9.3 shape-tolerant parsing ──────────────────────────────────

/**
 * Pull the signals payload out of whatever JSON shape Perplexity returned.
 * Accepts:
 *   • { signals: "- a\n- b" }                     (canonical)
 *   • { signals: ["a", "b"] }                     (array variant — coerce to bullets)
 *   • { signal: "..." } / { bullets: "..." } / { signals_list: ... }   (key variants)
 *   • Same with array values
 * Returns null when no usable shape is found.
 */
export function extractSignalsField(json: unknown): string | null {
  if (!json || typeof json !== 'object') return null;
  const obj = json as Record<string, unknown>;
  const candidateKeys = ['signals', 'signal', 'bullets', 'signal_list', 'signals_list', 'buying_signals'];
  for (const key of candidateKeys) {
    const v = obj[key];
    if (typeof v === 'string') {
      const trimmed = v.trim();
      if (trimmed.length > 0) return trimmed;
    }
    if (Array.isArray(v)) {
      const strings = v
        .filter((x): x is string => typeof x === 'string')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (strings.length === 0) continue;
      return strings.map((s) => (/^[-•*]\s+/.test(s) ? s : `- ${s}`)).join('\n');
    }
  }
  return null;
}

/**
 * Fallback for when JSON parsing fails entirely or the JSON has no
 * recognisable signals field — extract markdown bullets directly from
 * the response text. Useful because sonar-pro occasionally returns the
 * raw bullet list with no JSON wrapper despite the schema being set.
 *
 * Returns null when no bullets are present (so the caller can decide
 * whether to retry or surface an error).
 */
export function extractBulletsFromText(text: string): string | null {
  if (!text) return null;
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[-•*]\s+\S/.test(l));
  if (lines.length === 0) return null;
  // Normalize bullet markers to "-" so downstream parsers see consistent format.
  return lines.map((l) => l.replace(/^[•*]\s+/, '- ')).join('\n');
}

/**
 * Three-tier extractor: try JSON-field, then bullet-list fallback.
 * Returns null only when both fail.
 */
function extractSignalsAnyShape(r: PplxResponse<unknown>): string | null {
  return extractSignalsField(r.json) || extractBulletsFromText(r.text);
}

/**
 * Run a signal-research Perplexity call with one retry on parse failure.
 * Both attempts log a head/tail preview on failure so the main-process
 * console captures what Perplexity actually returned.
 */
async function callWithRetry(
  system: string,
  prompt: string,
  opts: {
    model: string;
    jsonSchema: Record<string, any>;
    stage: 'brand_signals' | 'product_signals';
    relatedId: number;
  }
): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await completePerplexity<unknown>(system, prompt, {
      model: opts.model,
      // v1.9.3: bumped 1500 → 2500. Brand-level signal lists for chunky
      // brands were tight against the 1500-token ceiling.
      maxTokens: 2500,
      temperature: 0.2,
      jsonSchema: opts.jsonSchema,
      stage: opts.stage,
      relatedId: opts.relatedId
    });
    const signals = extractSignalsAnyShape(r);
    if (signals) return signals;

    // Diagnostic preview: log head + tail so failures are inspectable.
    const head = (r.text || '').slice(0, 800).replace(/\s+/g, ' ');
    const tail = (r.text || '').slice(-200).replace(/\s+/g, ' ');
    console.warn(
      `[signal-research:${opts.stage}] attempt ${attempt + 1}/2 unparseable ` +
        `(${(r.text || '').length} chars, ${Number(r.usage?.completion_tokens ?? 0)} completion tokens)`
    );
    console.warn(`  head: ${head}`);
    console.warn(`  tail: …${tail}`);
    if (attempt === 0) {
      await new Promise((res) => setTimeout(res, 2000));
    }
  }
  throw new Error(
    'Perplexity returned an unparseable signals response twice in a row. ' +
      'Likely a transient model issue — try again. If it keeps failing, ' +
      'check Settings → Perplexity API and try a different Scan model.'
  );
}

/**
 * Research / refresh just the product's `signals` field. Cheap call —
 * sonar-pro with a tight token budget. Re-embeds afterwards so the
 * live-monitor pre-filter sees the new vectors immediately.
 */
export async function researchProductSignals(
  productId: number,
  options: { feedback?: string } = {}
): Promise<Product> {
  const db = getDb();
  const product = db
    .prepare('SELECT * FROM products WHERE id = ?')
    .get(productId) as Product | undefined;
  if (!product) throw new Error('Product not found');
  if (product.research_status !== 'ready') {
    throw new Error('Run full product research first before researching signals.');
  }
  const brand = db
    .prepare('SELECT * FROM brands WHERE id = ?')
    .get(product.brand_id) as Brand;

  // Persist new feedback (if any) BEFORE assembling the block, so it's
  // included in the prompt for this run.
  let pendingFeedbackId: number | null = null;
  if (options.feedback && options.feedback.trim()) {
    pendingFeedbackId = addFeedback('product_signals', productId, options.feedback);
  }
  const feedbackBlock = buildFeedbackBlock('product_signals', productId);

  const prompt = `# Brand
${brand.name} — ${brand.description || ''}

# Product
Name: ${product.name}
Category: ${product.category || ''}
Description: ${product.description || ''}

# Existing dossier context
Use cases:
${product.use_cases || '(none)'}

Differentiators:
${product.differentiators || '(none)'}

Existing signals (for reference — refresh them, don't just copy):
${product.signals || '(none)'}
${feedbackBlock ? `\n${feedbackBlock}` : ''}

# Task
Re-derive a fresh list of buying-signal bullets for THIS product. Lean on
live web search to incorporate anything that's changed in the market over
the last few weeks. Return JSON matching the schema.

If reviewer feedback above directs specific changes (focus areas, signals
to drop, signals to add), apply it — feedback outranks your own judgment
for items it covers.`;

  const { perplexityScanModel } = getSettings();
  const signals = await callWithRetry(SIGNAL_RESEARCH_SYSTEM, prompt, {
    model: perplexityScanModel || 'sonar-pro',
    jsonSchema: PRODUCT_SIGNALS_SCHEMA,
    stage: 'product_signals',
    relatedId: productId
  });

  db.prepare(
    "UPDATE products SET signals = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(signals, productId);

  // Re-embed for the live-monitor pre-filter. Fire-and-forget so the call
  // returns to the user immediately.
  embedSignalsForProduct(productId).catch((e) => {
    console.warn('[researchProductSignals] embedding failed:', e?.message || e);
  });

  if (pendingFeedbackId !== null) {
    markFeedbackApplied(pendingFeedbackId);
  }

  return db
    .prepare('SELECT * FROM products WHERE id = ?')
    .get(productId) as Product;
}

/**
 * Research / refresh just the brand's `signals` field — brand-level signals
 * are cross-cutting events that indicate ANY product of the brand may be
 * needed. Distinct from product-level signals.
 *
 * Brand signals don't need embedding (the live monitor matches on product
 * signals only).
 */
export async function researchBrandSignals(
  brandId: number,
  options: { feedback?: string } = {}
): Promise<Brand> {
  const db = getDb();
  const brand = db
    .prepare('SELECT * FROM brands WHERE id = ?')
    .get(brandId) as Brand | undefined;
  if (!brand) throw new Error('Brand not found');
  if (brand.research_status !== 'ready') {
    throw new Error('Run full brand research first before researching signals.');
  }

  let pendingFeedbackId: number | null = null;
  if (options.feedback && options.feedback.trim()) {
    pendingFeedbackId = addFeedback('brand_signals', brandId, options.feedback);
  }
  const feedbackBlock = buildFeedbackBlock('brand_signals', brandId);

  const prompt = `# Brand
Name: ${brand.name}
Category: ${brand.category || '(unspecified)'}
Description: ${brand.description || '(none on file)'}
Positioning: ${brand.positioning || '(none on file)'}
Target ICP (ideal customer profile): ${brand.target_icp || '(not researched yet)'}
Competitive summary: ${brand.competitive_summary || '(none on file)'}
${brand.research_summary ? `\nBrand research summary:\n${brand.research_summary.slice(0, 2000)}${brand.research_summary.length > 2000 ? '…' : ''}` : ''}

# Existing brand-level signals (for reference — refresh them, don't just copy)
${brand.signals || '(none)'}
${feedbackBlock ? `\n${feedbackBlock}` : ''}

# Task
Re-derive a fresh list of BRAND-LEVEL buying-signal bullets — events that
indicate ANY product from this brand may be needed. These are cross-cutting
signals, distinct from product-specific signals. Use live web search to
incorporate anything that's shifted in the market for this brand recently.

If reviewer feedback above directs specific changes, apply it — feedback
outranks your own judgment for items it covers.

Return JSON matching the schema.`;

  const { perplexityScanModel } = getSettings();
  const signals = await callWithRetry(SIGNAL_RESEARCH_SYSTEM, prompt, {
    model: perplexityScanModel || 'sonar-pro',
    jsonSchema: BRAND_SIGNALS_SCHEMA,
    stage: 'brand_signals',
    relatedId: brandId
  });

  db.prepare(
    "UPDATE brands SET signals = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(signals, brandId);

  if (pendingFeedbackId !== null) {
    markFeedbackApplied(pendingFeedbackId);
  }

  return db
    .prepare('SELECT * FROM brands WHERE id = ?')
    .get(brandId) as Brand;
}
