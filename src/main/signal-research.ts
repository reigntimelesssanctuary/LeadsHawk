/**
 * v1.9.2 — Signal research as a separate job, decoupled from dossier research.
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
 *
 * Replaces v1.8.x `refreshProductSignals` (lifted out of research.ts).
 */

import { getDb } from './db.js';
import { completePerplexity } from './perplexity.js';
import { getSettings } from './settings.js';
import { embedSignalsForProduct } from './monitor/embed.js';
import { addFeedback, buildFeedbackBlock, markFeedbackApplied } from './feedback.js';
import type { Brand, Product } from '@shared/types';

const SIGNAL_RESEARCH_SYSTEM = `You are a senior B2B competitive-intelligence
analyst. You produce sharp, concrete buying-signal lists.

A "buying signal" is a specific, observable real-world event that indicates
a company is likely in-market for a product. Examples that are GOOD:
  - "Company announces multi-year office expansion or HQ relocation"
  - "CISO appointment or departure"
  - "Acquisition closes — IT systems consolidation phase begins"
  - "Public regulatory filing mentioning data-residency requirements"
Examples that are BAD (too generic — drop these):
  - "Company in growth mode"
  - "Industry trend toward digital transformation"
  - "Looking for innovation"

Be specific. Each signal should describe an event a salesperson could
literally Google-alert for.`;

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

/**
 * Research / refresh just the product's `signals` field. Cheap call —
 * sonar-pro with a tight token budget. Re-embeds afterwards so the
 * live-monitor pre-filter sees the new vectors immediately.
 *
 * Use this when you've added knowledge, tweaked the product description,
 * or want to re-derive signals after receiving reviewer feedback.
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
  const { json } = await completePerplexity<{ signals: string }>(
    SIGNAL_RESEARCH_SYSTEM,
    prompt,
    {
      model: perplexityScanModel || 'sonar-pro',
      maxTokens: 1500,
      temperature: 0.2,
      jsonSchema: PRODUCT_SIGNALS_SCHEMA,
      stage: 'product_signals',
      relatedId: productId
    }
  );

  if (!json || !json.signals) {
    throw new Error('Perplexity returned an unparseable signals response. Try again.');
  }

  db.prepare(
    "UPDATE products SET signals = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(json.signals, productId);

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
  const { json } = await completePerplexity<{ signals: string }>(
    SIGNAL_RESEARCH_SYSTEM,
    prompt,
    {
      model: perplexityScanModel || 'sonar-pro',
      maxTokens: 1500,
      temperature: 0.2,
      jsonSchema: BRAND_SIGNALS_SCHEMA,
      stage: 'brand_signals',
      relatedId: brandId
    }
  );

  if (!json || !json.signals) {
    throw new Error('Perplexity returned an unparseable signals response. Try again.');
  }

  db.prepare(
    "UPDATE brands SET signals = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(json.signals, brandId);

  if (pendingFeedbackId !== null) {
    markFeedbackApplied(pendingFeedbackId);
  }

  return db
    .prepare('SELECT * FROM brands WHERE id = ?')
    .get(brandId) as Brand;
}
