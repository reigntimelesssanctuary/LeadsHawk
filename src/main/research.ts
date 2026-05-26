import { getDb } from './db.js';
import { completePerplexity } from './perplexity.js';
import { getSettings } from './settings.js';
import { chunkAndEmbedKnowledgeItem } from './knowledge-index.js';
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

// v1.9.2: `signals` is no longer part of dossier research — it's a separate
// job triggered from Signal Config (see signal-research.ts). Existing
// stored signals are preserved; re-running dossier research leaves them
// untouched.
type ResearchOutput = {
  description: string;
  category: string;
  use_cases: string;
  competitors: string;
  differentiators: string;
  research_summary: string;
  recommended_scan_recency: 'day' | 'week' | 'month' | 'year';
};

const RECENCY_DESC = 'How far back the scanner should look for buying signals for this product. "day" for hyper-time-sensitive (outages, breaches, incidents); "week" for fast-cycle (executive moves, vulnerability disclosures, product launches); "month" for medium-cycle (CIO appointments, vendor changes, hiring sprees); "year" for slow-cycle decisions (real estate, multi-year programmes, infrastructure builds, ESG commitments, capital projects, M&A). Pick based on the lead time from buying signal to vendor selection.';

const RESEARCH_SCHEMA = {
  type: 'object',
  required: [
    'description', 'category', 'use_cases', 'competitors',
    'differentiators', 'research_summary', 'recommended_scan_recency'
  ],
  properties: {
    description: { type: 'string', description: '1-paragraph crisp description of the product' },
    category: { type: 'string', description: 'Short market category, e.g. SD-WAN, EDR, observability' },
    use_cases: { type: 'string', description: 'Markdown bulleted list of high-fit customer situations (lines starting with -)' },
    competitors: { type: 'string', description: 'Markdown bulleted list. Each line: "Competitor — short positioning"' },
    differentiators: { type: 'string', description: 'Markdown bulleted list of this product\'s unique angles vs competitors' },
    research_summary: { type: 'string', description: '300-500 word holistic narrative tying the above together' },
    recommended_scan_recency: {
      type: 'string',
      enum: ['day', 'week', 'month', 'year'],
      description: RECENCY_DESC
    }
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

    // v1.9.2: signals deliberately not written here — they're managed by
    // the separate Signal Config job (see researchProductSignals in
    // signal-research.ts). Existing signals stay untouched on re-research.
    db.prepare(
      `UPDATE products SET
         description = COALESCE(NULLIF(?, ''), description),
         category = COALESCE(NULLIF(?, ''), category),
         use_cases = ?,
         competitors = ?,
         differentiators = ?,
         research_summary = ?,
         scan_recency_auto = ?,
         research_status = 'ready',
         last_researched_at = datetime('now'),
         updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      json.description,
      json.category,
      json.use_cases,
      json.competitors,
      json.differentiators,
      json.research_summary,
      json.recommended_scan_recency || null,
      productId
    );

    // v1.6: brand competitive_summary is no longer regenerated as a
    // side-effect of product research. Use `researchBrand(id)` for that —
    // see below. This stops the historical bug where the brand summary
    // got overwritten every time any product was re-researched.

    return db.prepare('SELECT * FROM products WHERE id = ?').get(productId) as Product;
  } catch (e) {
    db.prepare('UPDATE products SET research_status = ? WHERE id = ?').run('error', productId);
    throw e;
  }
}

/**
 * v1.6 — Brand becomes a first-class research subject. Generates a
 * brand-level dossier that downstream product research AND every cast-nets
 * scan can use as foundational context.
 *
 * Pulls brand-level knowledge_items (product_id IS NULL) first, then a
 * sample of cross-product knowledge to give breadth. Sends to Perplexity
 * sonar-deep-research with a schema focused on positioning + ICP +
 * brand-level signals + a narrative summary.
 *
 * Stores in brands.research_summary / target_icp / category / signals /
 * competitive_summary, and stamps last_researched_at.
 */
const BRAND_RESEARCH_SYSTEM = `You are a senior B2B competitive-intelligence
analyst conducting deep web research on a specific BRAND (a company that
sells products). Your job: produce a foundational brand-level dossier that
downstream product research and lead-finding scans can use as context.

You have live search; USE IT. Pull from the brand's own website, analyst
coverage, customer case studies, news, social media, and industry reports.

Be specific and honest. Avoid generic marketing language. The dossier is
internal — it will be invisible to the brand.`;

// v1.9.2: `signals` removed — brand-level signals are now produced by the
// separate signal-research job (researchBrandSignals in signal-research.ts).
type BrandResearchOutput = {
  category: string;
  positioning: string;
  target_icp: string;
  competitive_summary: string;
  research_summary: string;
  recommended_scan_recency: 'day' | 'week' | 'month' | 'year';
};

const BRAND_RESEARCH_SCHEMA = {
  type: 'object',
  required: ['category', 'positioning', 'target_icp', 'competitive_summary', 'research_summary', 'recommended_scan_recency'],
  properties: {
    category: { type: 'string', description: 'Short market category the brand operates in (e.g. "commercial interior design", "B2B SaaS observability", "managed network services").' },
    positioning: { type: 'string', description: 'How this brand positions itself in market — its core promise / wedge / differentiation in 2-4 sentences.' },
    target_icp: { type: 'string', description: 'The brand\'s ideal customer profile (ICP). Be specific about company size, sector, geography, maturity stage, and the buying-team persona who typically initiates the deal.' },
    competitive_summary: { type: 'string', description: 'Tight 150-200 word competitive narrative — where the brand wins, where it\'s vulnerable, who the main alternatives are.' },
    research_summary: { type: 'string', description: '400-600 word narrative tying positioning + ICP + signals + market context together. The single most useful paragraph a salesperson new to this brand could read.' },
    recommended_scan_recency: {
      type: 'string',
      enum: ['day', 'week', 'month', 'year'],
      description: 'Pick the recency window that best matches the lead time from buying signal to vendor selection for THIS brand. "day" for hyper-time-sensitive (incident response, breaches); "week" for fast-cycle (exec changes, breaches, breaking news); "month" for medium-cycle (CIO appointments, hiring sprees); "year" for slow-cycle (real estate, multi-year programmes, infrastructure builds, ESG commitments, M&A, capital projects).'
    }
  }
};

export async function researchBrand(brandId: number): Promise<Brand> {
  const db = getDb();
  const brand = db.prepare('SELECT * FROM brands WHERE id = ?').get(brandId) as Brand | undefined;
  if (!brand) throw new Error('Brand not found');

  db.prepare("UPDATE brands SET research_status = 'researching' WHERE id = ?").run(brandId);

  try {
    // Brand research prioritises brand-level material, then takes a sample
    // of product-scoped material for breadth.
    const knowledge = db
      .prepare(
        `SELECT * FROM knowledge_items
         WHERE brand_id = ? AND status = 'indexed'
         ORDER BY
           CASE WHEN product_id IS NULL THEN 0 ELSE 1 END,
           created_at DESC
         LIMIT 30`
      )
      .all(brandId) as KnowledgeItem[];

    const knowledgeBlob = knowledge
      .map((k) => `### ${k.title}\nSource: ${k.source}\n${(k.content || '').slice(0, 4000)}`)
      .join('\n\n')
      .slice(0, 50_000);

    const prompt = `# Brand
Name: ${brand.name}
Existing description: ${brand.description || '(none)'}
Existing positioning: ${brand.positioning || '(none)'}

# Internal knowledge-base excerpts
${knowledgeBlob || '(no internal knowledge — rely entirely on live web research)'}

# Task
Conduct deep web research on this BRAND. Synthesize external sources with the
internal excerpts above into a foundational brand-level dossier. Return JSON
matching the schema you've been given.`;

    const { perplexityResearchModel } = getSettings();
    const { json } = await completePerplexity<BrandResearchOutput>(
      BRAND_RESEARCH_SYSTEM,
      prompt,
      {
        model: perplexityResearchModel || 'sonar-deep-research',
        maxTokens: 6000,
        temperature: 0.15,
        jsonSchema: BRAND_RESEARCH_SCHEMA,
        stage: 'brand_research',
        relatedId: brandId
      }
    );

    if (!json) {
      throw new Error('Perplexity returned an unparseable brand-research response. Try again.');
    }

    // v1.9.2: brand signals deliberately not written here — they're now
    // managed by the separate Signal Config job (researchBrandSignals in
    // signal-research.ts). Existing signals stay untouched on re-research.
    db.prepare(
      `UPDATE brands SET
         category = COALESCE(NULLIF(?, ''), category),
         positioning = COALESCE(NULLIF(?, ''), positioning),
         target_icp = ?,
         competitive_summary = ?,
         research_summary = ?,
         scan_recency_auto = ?,
         research_status = 'ready',
         last_researched_at = datetime('now'),
         updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      json.category,
      json.positioning,
      json.target_icp,
      json.competitive_summary,
      json.research_summary,
      json.recommended_scan_recency || null,
      brandId
    );

    return db.prepare('SELECT * FROM brands WHERE id = ?').get(brandId) as Brand;
  } catch (e) {
    db.prepare("UPDATE brands SET research_status = 'error' WHERE id = ?").run(brandId);
    throw e;
  }
}

/**
 * Legacy "is this content long enough?" check. The real indexing work now
 * happens in src/main/knowledge-index.ts (chunkAndEmbedKnowledgeItem),
 * which is called fire-and-forget after every knowledge insert.
 */
export async function indexKnowledge(itemId: number): Promise<void> {
  const db = getDb();
  const item = db
    .prepare('SELECT * FROM knowledge_items WHERE id = ?')
    .get(itemId) as KnowledgeItem | undefined;
  if (!item) return;
  if (item.content && item.content.length > 200) {
    db.prepare("UPDATE knowledge_items SET status = 'indexed' WHERE id = ?").run(itemId);
  }
  // Trigger background chunk-and-embed so the chunk store stays in sync.
  // We don't await — knowledge inserts must stay fast.
  chunkAndEmbedKnowledgeItem(itemId).catch((e) => {
    console.warn('[indexKnowledge] chunkAndEmbed failed:', e?.message || e);
  });
}
