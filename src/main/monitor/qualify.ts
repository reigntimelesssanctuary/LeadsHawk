import { getDb } from '../db.js';
import { completePerplexity } from '../perplexity.js';
import { getSettings } from '../settings.js';
import type { Brand, Product, SignalItem, ScanRule } from '@shared/types';

const SYSTEM = `You are a senior B2B sales intelligence analyst. You will be
given ONE news item and ONE specific product from our portfolio. The item has
already been pre-qualified as a STRONG candidate by an earlier triage step.

Your job: do the deep research. Use live web search to confirm the situation,
find additional context about the company, and produce a full opportunity
record. If on deeper inspection the fit doesn't hold up, set is_opportunity
to false.

Respond ONLY with JSON.`;

type QualifyResult = {
  is_opportunity: boolean;
  confidence: number;
  company: string;
  industry: string;
  background: string;
  use_case: string;
  angle: string;
  signal_summary: string;
  headline: string;
};

const SCHEMA = {
  type: 'object',
  required: [
    'is_opportunity', 'confidence', 'company', 'industry',
    'background', 'use_case', 'angle', 'signal_summary', 'headline'
  ],
  properties: {
    is_opportunity: { type: 'boolean' },
    confidence: { type: 'number' },
    company: { type: 'string' },
    industry: { type: 'string' },
    background: { type: 'string' },
    use_case: { type: 'string' },
    angle: { type: 'string' },
    signal_summary: { type: 'string' },
    headline: { type: 'string' }
  }
};

function buildProductGuardrails(productId: number): string {
  const db = getDb();
  const rules = db
    .prepare("SELECT * FROM scan_rules WHERE product_id = ? AND enabled = 1 ORDER BY kind, id")
    .all(productId) as ScanRule[];
  if (rules.length === 0) return '';
  const includes = rules.filter((r) => r.kind === 'include');
  const excludes = rules.filter((r) => r.kind === 'exclude');
  const parts: string[] = ['# Hard constraints (apply to this candidate)'];
  if (includes.length) {
    parts.push('Only consider this an opportunity if ALL of these are satisfied:');
    parts.push(includes.map((r) => `- ${r.text}`).join('\n'));
  }
  if (excludes.length) {
    parts.push('Reject as opportunity if ANY of these match:');
    parts.push(excludes.map((r) => `- ${r.text}`).join('\n'));
  }
  parts.push('If a constraint is violated, set is_opportunity to false.');
  return parts.join('\n');
}

export type QualifyOutcome =
  | { kind: 'opportunity'; opportunityId: number; confidence: number }
  | { kind: 'rejected'; reason: string };

export async function qualifyItem(
  item: SignalItem,
  product: Product,
  brand: Brand,
  matchedSignal: string
): Promise<QualifyOutcome> {
  const db = getDb();
  const settings = getSettings();
  if (!settings.perplexityApiKey) {
    return { kind: 'rejected', reason: 'no perplexity key configured' };
  }
  const guardrails = buildProductGuardrails(product.id);

  const prompt = `# Product
Brand: ${brand.name}
Product: ${product.name}
Category: ${product.category || ''}
Description: ${product.description || ''}

Use cases:
${product.use_cases || ''}

Differentiators:
${product.differentiators || ''}

# News item (already triaged as strong)
Title: ${item.title}
URL: ${item.url}
Snippet: ${item.snippet || ''}
Pre-filter matched signal: "${matchedSignal}"

${guardrails}

# Task
Use live web search to verify and enrich this signal. Produce a full
opportunity record. If on deeper inspection the fit doesn't hold up
(generic news, wrong company size, doesn't match constraints, etc.),
set is_opportunity = false. Otherwise return the structured opportunity.`;

  let r;
  try {
    r = await completePerplexity<QualifyResult>(SYSTEM, prompt, {
      model: settings.perplexityScanModel || 'sonar-pro',
      maxTokens: 2500,
      temperature: 0.2,
      jsonSchema: SCHEMA,
      stage: 'qualify',
      relatedId: item.id
    });
  } catch (e: any) {
    return { kind: 'rejected', reason: `perplexity error: ${e?.message || e}` };
  }
  if (!r.json) return { kind: 'rejected', reason: 'unparseable response' };
  const j = r.json;
  if (!j.is_opportunity) return { kind: 'rejected', reason: 'model judged not an opportunity' };
  if ((j.confidence ?? 0) < settings.minConfidence) {
    return { kind: 'rejected', reason: `low confidence ${j.confidence}` };
  }

  const insert = db.prepare(`
    INSERT INTO opportunities(
      brand_id, product_id, company, industry, headline, source_url, source_title,
      source_published_at, confidence, status, background, use_case, angle,
      signal_summary, raw_signal
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)
  `);
  const info = insert.run(
    brand.id,
    product.id,
    j.company,
    j.industry,
    j.headline || item.title,
    item.url,
    'live monitor',
    item.published_at,
    j.confidence,
    j.background,
    j.use_case,
    j.angle,
    j.signal_summary,
    JSON.stringify({ source: 'live_monitor', matched_signal: matchedSignal })
  );
  db.prepare(
    "INSERT OR IGNORE INTO seen_urls(url) VALUES (?)"
  ).run(item.url);

  return {
    kind: 'opportunity',
    opportunityId: Number(info.lastInsertRowid),
    confidence: j.confidence
  };
}
