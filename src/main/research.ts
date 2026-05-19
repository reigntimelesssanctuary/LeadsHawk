import { getDb } from './db.js';
import { complete, completeJson } from './llm.js';
import type { Product, Brand, KnowledgeItem } from '@shared/types';

const SYSTEM = `You are an expert B2B competitive intelligence analyst.
Your job is to deeply understand products and brands well enough to identify
when a prospective customer's situation creates a buying opportunity.

When researching, always think about:
- The job-to-be-done the product solves
- Concrete trigger events / situations that create buying intent (failures,
  incidents, executive changes, regulatory pressure, growth milestones, etc.)
- The honest competitive landscape (direct, indirect, status-quo)
- The product's clearest differentiators and weaknesses
- The "signals" a sales team should watch for in news and the open web.`;

export async function researchProduct(productId: number): Promise<Product> {
  const db = getDb();
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId) as Product | undefined;
  if (!product) throw new Error('Product not found');
  const brand = db.prepare('SELECT * FROM brands WHERE id = ?').get(product.brand_id) as Brand;

  db.prepare('UPDATE products SET research_status = ? WHERE id = ?').run('researching', productId);

  const knowledge = db
    .prepare(
      `SELECT * FROM knowledge_items
       WHERE (brand_id = ? OR brand_id IS NULL)
         AND status = 'indexed'
       ORDER BY created_at DESC LIMIT 30`
    )
    .all(brand.id) as KnowledgeItem[];

  const knowledgeBlob = knowledge
    .map(
      (k) =>
        `### ${k.title}\nSource: ${k.source}\n${(k.content || '').slice(0, 6000)}`
    )
    .join('\n\n')
    .slice(0, 60_000);

  const prompt = `# Brand
Name: ${brand.name}
Existing description: ${brand.description || '(none)'}

# Product
Name: ${product.name}
Existing description: ${product.description || '(none)'}
Existing category: ${product.category || '(unknown)'}

# Knowledge base excerpts
${knowledgeBlob || '(no uploaded knowledge yet — use your own deep general knowledge of this domain)'}

# Task
Produce a competitive-intelligence dossier for this product. Return JSON with these keys:
{
  "description": "1-paragraph crisp description",
  "category": "short market category",
  "use_cases": "bulleted list of high-fit customer situations (markdown -)",
  "competitors": "bulleted list, each line: Competitor — short positioning",
  "differentiators": "bulleted list of this product's unique angles vs competitors",
  "signals": "bulleted list of concrete news/event signals (e.g. 'reports of vendor X outage', 'CISO change in regulated industry', etc.) that indicate a buying opportunity",
  "research_summary": "200-400 word holistic narrative tying the above together. Plain prose."
}`;

  const data = await completeJson<{
    description: string;
    category: string;
    use_cases: string;
    competitors: string;
    differentiators: string;
    signals: string;
    research_summary: string;
  }>(SYSTEM, prompt, { maxTokens: 3500 });

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
    data.description,
    data.category,
    data.use_cases,
    data.competitors,
    data.differentiators,
    data.signals,
    data.research_summary,
    productId
  );

  // Roll the brand competitive_summary up too
  const brandSummary = await complete(
    SYSTEM,
    `Given this brand "${brand.name}" and its current product portfolio in our DB, write a tight 150-word competitive summary for the BRAND itself (positioning, where it wins, where it's vulnerable).`,
    { maxTokens: 600 }
  );
  db.prepare(
    'UPDATE brands SET competitive_summary = ?, updated_at = datetime(\'now\') WHERE id = ?'
  ).run(brandSummary, brand.id);

  return db.prepare('SELECT * FROM products WHERE id = ?').get(productId) as Product;
}

export async function indexKnowledge(itemId: number): Promise<void> {
  const db = getDb();
  const item = db
    .prepare('SELECT * FROM knowledge_items WHERE id = ?')
    .get(itemId) as KnowledgeItem | undefined;
  if (!item) return;
  // Already indexed if content present
  if (item.content && item.content.length > 200) {
    db.prepare("UPDATE knowledge_items SET status = 'indexed' WHERE id = ?").run(itemId);
  }
}
