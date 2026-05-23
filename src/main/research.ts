import { getDb } from './db.js';
import { completePerplexity } from './perplexity.js';
import { getSettings } from './settings.js';
import { embedSignalsForProduct } from './monitor/embed.js';
import type { Product, Brand, KnowledgeItem } from '@shared/types';

const SYSTEM = `You are a senior B2B competitive-intelligence analyst conducting
deep web research on a specific product and its brand. You have live search;
USE IT. Pull from analyst reports, vendor docs, customer reviews (G2, Gartner
Peer Insights, TrustRadius), news, security disclosures, and forum discussions.

Your deliverable is a sharp dossier a sales team can act on:
- The job-to-be-done the product solves
- Concrete trigger events / situations that create buying intent (outages,
  incidents, executive changes, regulatory pressure, growth milestones, etc.)
- The honest competitive landscape (direct, indirect, status-quo)
- The product's clearest differentiators and its weaknesses
- Specific signals a sales team should watch for in news and the open web

Be specific. Cite real competitor names, real customers when known, real
events. Avoid generic marketing language.`;

type ResearchOutput = {
  description: string;
  category: string;
  use_cases: string;
  competitors: string;
  differentiators: string;
  signals: string;
  research_summary: string;
};

const RESEARCH_SCHEMA = {
  type: 'object',
  required: [
    'description', 'category', 'use_cases', 'competitors',
    'differentiators', 'signals', 'research_summary'
  ],
  properties: {
    description: { type: 'string', description: '1-paragraph crisp description of the product' },
    category: { type: 'string', description: 'Short market category, e.g. SD-WAN, EDR, observability' },
    use_cases: { type: 'string', description: 'Markdown bulleted list of high-fit customer situations (lines starting with -)' },
    competitors: { type: 'string', description: 'Markdown bulleted list. Each line: "Competitor — short positioning"' },
    differentiators: { type: 'string', description: 'Markdown bulleted list of this product\'s unique angles vs competitors' },
    signals: { type: 'string', description: 'Markdown bulleted list of concrete news/event signals that indicate a buying opportunity' },
    research_summary: { type: 'string', description: '300-500 word holistic narrative tying the above together' }
  }
};

export async function researchProduct(productId: number): Promise<Product> {
  const db = getDb();
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId) as Product | undefined;
  if (!product) throw new Error('Product not found');
  const brand = db.prepare('SELECT * FROM brands WHERE id = ?').get(product.brand_id) as Brand;

  db.prepare('UPDATE products SET research_status = ? WHERE id = ?').run('researching', productId);

  try {
    // Pull this brand's knowledge, prioritising items tied to THIS product,
    // then brand-level items, then items tied to OTHER products of the same brand.
    const knowledge = db
      .prepare(
        `SELECT * FROM knowledge_items
         WHERE (brand_id = ? OR brand_id IS NULL)
           AND status = 'indexed'
         ORDER BY
           CASE
             WHEN product_id = ? THEN 0
             WHEN product_id IS NULL THEN 1
             ELSE 2
           END,
           created_at DESC
         LIMIT 20`
      )
      .all(brand.id, productId) as KnowledgeItem[];

    const knowledgeBlob = knowledge
      .map(
        (k) =>
          `### ${k.title}\nSource: ${k.source}\n${(k.content || '').slice(0, 4000)}`
      )
      .join('\n\n')
      .slice(0, 40_000);

    const prompt = `# Brand
Name: ${brand.name}
Existing description: ${brand.description || '(none)'}

# Product
Name: ${product.name}
Existing description: ${product.description || '(none)'}
Existing category: ${product.category || '(unknown)'}

# Internal knowledge-base excerpts
${knowledgeBlob || '(no internal knowledge — rely on live web research)'}

# Task
Conduct deep web research on this product and brand. Synthesize external
sources with the internal excerpts above into a single dossier. Return the
result as JSON matching the schema you've been given.`;

    const { perplexityResearchModel } = getSettings();

    const { json } = await completePerplexity<ResearchOutput>(SYSTEM, prompt, {
      model: perplexityResearchModel || 'sonar-deep-research',
      maxTokens: 6000,
      temperature: 0.15,
      jsonSchema: RESEARCH_SCHEMA,
      stage: 'research',
      relatedId: productId
    });

    if (!json) {
      throw new Error('Perplexity returned an unparseable response. Try again or pick a different research model in Settings.');
    }

    db.prepare(
      `UPDATE products SET
         description = COALESCE(NULLIF(?, ''), description),
         category = COALESCE(NULLIF(?, ''), category),
         use_cases = ?,
         competitors = ?,
         differentiators = ?,
         signals = ?,
         research_summary = ?,
         research_status = 'ready',
         updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      json.description,
      json.category,
      json.use_cases,
      json.competitors,
      json.differentiators,
      json.signals,
      json.research_summary,
      productId
    );

    // Fire-and-forget: recompute signal embeddings for live monitor use.
    embedSignalsForProduct(productId).catch((e) => {
      console.warn('[research] signal embedding failed for product', productId, e?.message || e);
    });

    // Roll up a brand-level competitive summary using Perplexity too
    const brandPrompt = `Brand: ${brand.name}
Existing brand description: ${brand.description || '(none)'}

Based on live research and the freshly-researched product "${product.name}"
in this brand's portfolio, write a tight 150-word competitive summary for the
BRAND itself — its positioning, where it wins, where it's vulnerable. No
fluff. Plain prose, no markdown headings.`;
    try {
      const { text: brandSummary } = await completePerplexity(SYSTEM, brandPrompt, {
        model: perplexityResearchModel || 'sonar-deep-research',
        maxTokens: 700,
        temperature: 0.2,
        stage: 'brand_summary',
        relatedId: brand.id
      });
      if (brandSummary) {
        db.prepare(
          "UPDATE brands SET competitive_summary = ?, updated_at = datetime('now') WHERE id = ?"
        ).run(brandSummary, brand.id);
      }
    } catch {
      // brand summary is a nice-to-have, don't fail the whole research
    }

    return db.prepare('SELECT * FROM products WHERE id = ?').get(productId) as Product;
  } catch (e) {
    db.prepare('UPDATE products SET research_status = ? WHERE id = ?').run('error', productId);
    throw e;
  }
}

/**
 * Lightweight signals-only refresh. Reuses the existing dossier as context
 * instead of doing fresh deep web research, so it runs on the cheaper
 * `sonar-pro` model with a much smaller token budget (~10x cheaper than
 * researchProduct). Re-embeds the new signals afterwards so the live
 * monitor's pre-filter sees them immediately.
 *
 * Use this when you've tweaked the product description / category and want
 * the buying-signal list re-derived without paying for full re-research.
 */
export async function refreshProductSignals(productId: number): Promise<Product> {
  const db = getDb();
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId) as Product | undefined;
  if (!product) throw new Error('Product not found');
  if (product.research_status !== 'ready') {
    throw new Error('Run full research first before refreshing signals.');
  }
  const brand = db.prepare('SELECT * FROM brands WHERE id = ?').get(product.brand_id) as Brand;

  const SIGNALS_SCHEMA = {
    type: 'object',
    required: ['signals'],
    properties: {
      signals: {
        type: 'string',
        description:
          "Markdown bulleted list of concrete news/event signals (lines starting with '- ') that indicate a buying opportunity for this product."
      }
    }
  };

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

# Task
Re-derive a fresh list of buying-signal bullets for this product. Lean on
live web search to incorporate anything that's changed in the market over
the last few weeks. Return JSON matching the schema.`;

  const { perplexityScanModel } = getSettings();
  const { json } = await completePerplexity<{ signals: string }>(
    'You are a senior B2B competitive-intelligence analyst. You produce sharp, concrete buying-signal lists.',
    prompt,
    {
      model: perplexityScanModel || 'sonar-pro',
      maxTokens: 1500,
      temperature: 0.2,
      jsonSchema: SIGNALS_SCHEMA,
      stage: 'refresh_signals',
      relatedId: productId
    }
  );

  if (!json || !json.signals) {
    throw new Error('Perplexity returned an unparseable response. Try again.');
  }

  db.prepare(
    "UPDATE products SET signals = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(json.signals, productId);

  // Re-embed for the live monitor pre-filter.
  await embedSignalsForProduct(productId).catch((e) => {
    console.warn('[refreshProductSignals] embedding failed:', e?.message || e);
  });

  return db.prepare('SELECT * FROM products WHERE id = ?').get(productId) as Product;
}

export async function indexKnowledge(itemId: number): Promise<void> {
  const db = getDb();
  const item = db
    .prepare('SELECT * FROM knowledge_items WHERE id = ?')
    .get(itemId) as KnowledgeItem | undefined;
  if (!item) return;
  if (item.content && item.content.length > 200) {
    db.prepare("UPDATE knowledge_items SET status = 'indexed' WHERE id = ?").run(itemId);
  }
}
