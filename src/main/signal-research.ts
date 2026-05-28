/**
 * v1.9.2 — Signal research as a separate job, decoupled from dossier research.
 * v1.9.3 — Shape-tolerant JSON-field extraction + bullet-list fallback +
 *          retry-once + diagnostic logging. Still failed in practice.
 * v1.9.4 — Drop `response_format: json_schema` entirely for signal research.
 *          sonar-pro + json_schema was returning empty content payloads
 *          even with the v1.9.3 fallbacks in place. The architecture is
 *          cleaner without it anyway — signals are inherently a markdown
 *          bullet list, the JSON wrapper added nothing useful. Bullets are
 *          now the primary expected output; extractSignalsField stays as
 *          a secondary fallback in case the model wraps in JSON anyway.
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
import { embedSignalsForProduct } from './monitor/embed.js';
import { addFeedback, buildFeedbackBlock, markFeedbackApplied } from './feedback.js';
import type { Brand, Product } from '@shared/types';

// v1.9.4: Ask for bullets directly. No JSON wrapper. The model returns a
// markdown bulleted list — that's the data; no transformation needed.
//
// Quality guidance (minimum 1, no upper cap, quality over quantity) is now
// embedded in the prompt text rather than a schema description, since
// without json_schema the description field doesn't reach the model.
const SIGNAL_RESEARCH_SYSTEM =
  'You are a senior B2B competitive-intelligence analyst. You produce sharp, concrete buying-signal lists for sales teams.\n\nRespond ONLY with a markdown bulleted list — one signal per line, each line starting with "- ". No preamble. No commentary. No closing remarks. Just the bullets.';

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
 * Two-tier extractor: v1.9.4 expects raw markdown bullets, but tries a
 * JSON-field extraction first in case the model wraps the output in
 * JSON anyway (some sonar variants do this even without json_schema).
 * Returns null only when both shapes fail.
 */
function extractSignalsAnyShape(r: PplxResponse<unknown>): string | null {
  // Bullets directly out of the text is now the primary expected shape.
  const fromText = extractBulletsFromText(r.text);
  if (fromText) return fromText;
  // Fall back: if the model wrapped output in JSON despite our request,
  // tryParseJson would have populated r.json — even without jsonSchema set,
  // extractFromCompletion in perplexity.ts only parses when jsonSchema is
  // set, so r.json will be null here. Try parsing raw text as JSON ourselves.
  if (r.text) {
    try {
      const parsed = JSON.parse(r.text.trim());
      const fromJson = extractSignalsField(parsed);
      if (fromJson) return fromJson;
    } catch {
      // Not JSON. Already tried text bullets above.
    }
  }
  return null;
}

/**
 * Run a signal-research Perplexity call with one retry on parse failure.
 * v1.9.4: no jsonSchema — we ask for markdown bullets directly.
 * Both attempts log a head/tail preview on failure so the main-process
 * console captures what Perplexity actually returned.
 */
async function callWithRetry(
  system: string,
  prompt: string,
  opts: {
    model: string;
    stage: 'brand_signals' | 'product_signals';
    relatedId: number;
  }
): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await completePerplexity<unknown>(system, prompt, {
      model: opts.model,
      maxTokens: 2500,
      temperature: 0.2,
      // v1.9.4: NO jsonSchema. sonar-pro + json_schema was returning empty
      // payloads. Markdown bullets out of free-form text is far more
      // reliable.
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
the last few weeks.

Output format: a markdown bulleted list, one signal per line starting
with "- ". Minimum 1 bullet, no upper cap. Each signal should describe a
concrete observable event a salesperson could literally Google-alert for
(e.g. "Company announces multi-year office expansion", "CISO appointment
or departure"). Avoid generic statements ("company in growth mode",
"industry trend toward digital transformation"). Quality over quantity:
one sharp signal beats ten generic ones.

No preamble, no commentary, no closing remarks. Bullets only.

If reviewer feedback above directs specific changes (focus areas, signals
to drop, signals to add), apply it — feedback outranks your own judgment
for items it covers.`;

  // v1.14.0: model picker removed from Settings — sonar-pro hardcoded.
  const signals = await callWithRetry(SIGNAL_RESEARCH_SYSTEM, prompt, {
    model: 'sonar-pro',
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

Output format: a markdown bulleted list, one signal per line starting
with "- ". Minimum 1 bullet, no upper cap. Each signal should describe a
concrete observable event a salesperson could literally Google-alert for
(e.g. "Company announces APAC HQ expansion", "Lease renewal due",
"Post-acquisition consolidation"). Avoid generic statements. Quality over
quantity: one sharp signal beats ten generic ones.

No preamble, no commentary, no closing remarks. Bullets only.

If reviewer feedback above directs specific changes, apply it — feedback
outranks your own judgment for items it covers.`;

  // v1.14.0: model picker removed from Settings — sonar-pro hardcoded.
  const signals = await callWithRetry(SIGNAL_RESEARCH_SYSTEM, prompt, {
    model: 'sonar-pro',
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
