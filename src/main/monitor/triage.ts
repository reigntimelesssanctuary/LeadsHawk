import Anthropic from '@anthropic-ai/sdk';
import { getSettings } from '../settings.js';
import { getDb } from '../db.js';
import { recordApiCall } from '../spend.js';
import { buildDisqualificationsBlock } from '../learning.js';
import type { Brand, Product, SignalItem } from '@shared/types';

const SYSTEM = `You are a senior B2B sales analyst. You will be given ONE news /
blog / RSS item plus ONE specific product from our portfolio. Your job is a
fast yes/no triage: is this item a credible buying-signal candidate for this
specific product?

Be honest. Most items, even those that look topical, are NOT real
opportunities. Only label "strong" when a named company is in a concrete
situation that genuinely fits the product. Use "weak" if it's adjacent but
not a clear fit. Use "rejected" if it doesn't fit at all.

Respond ONLY with JSON. No prose.`;

export type TriageDecision = {
  decision: 'rejected' | 'weak' | 'strong';
  confidence: number; // 0..1
  reason: string;
};

function client(): Anthropic {
  const { anthropicApiKey } = getSettings();
  if (!anthropicApiKey) {
    throw new Error('Anthropic API key not configured (needed for live-monitor triage).');
  }
  return new Anthropic({ apiKey: anthropicApiKey });
}

export async function triageItem(
  item: Pick<SignalItem, 'id' | 'title' | 'snippet' | 'url' | 'best_match_similarity'>,
  product: Product,
  brand: Brand,
  matchedSignal: string
): Promise<TriageDecision> {
  const { triageModel } = getSettings();
  const c = client();
  const modelId = triageModel || 'claude-sonnet-4-6';

  const disqBlock = buildDisqualificationsBlock(product.id, 6);

  const prompt = `# Our product
Brand: ${brand.name}
Product: ${product.name}
Category: ${product.category || ''}
Description: ${product.description || ''}

Use cases:
${product.use_cases || ''}

# News item
Title: ${item.title}
URL: ${item.url}
Snippet: ${item.snippet || '(none)'}

# Pre-filter signal that matched
"${matchedSignal}"
(cosine similarity to this signal: ${(item.best_match_similarity ?? 0).toFixed(3)})

${disqBlock}

# Task
Decide: is this a credible buying-signal candidate for THIS product?

Return JSON:
{
  "decision": "rejected" | "weak" | "strong",
  "confidence": 0..1,
  "reason": "one-sentence rationale"
}

Lean conservative — "strong" should only fire when the fit is clearly real
and concrete. "weak" means topical but a stretch. "rejected" means clearly
unrelated or noise.`;

  const resp = await c.messages.create({
    model: modelId,
    max_tokens: 250,
    temperature: 0.1,
    system: SYSTEM,
    messages: [{ role: 'user', content: prompt }]
  });
  recordApiCall({
    provider: 'anthropic',
    model: modelId,
    stage: 'triage',
    inputTokens: Number((resp as any).usage?.input_tokens ?? 0),
    outputTokens: Number((resp as any).usage?.output_tokens ?? 0),
    relatedId: (item as any).id ?? null
  });
  const text = resp.content
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('\n')
    .trim();
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  let parsed: TriageDecision;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1) {
      throw new Error('Triage returned unparseable response: ' + text.slice(0, 200));
    }
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  }
  if (!['rejected', 'weak', 'strong'].includes(parsed.decision)) {
    parsed.decision = 'rejected';
  }
  parsed.confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
  return parsed;
}

export function loadProductAndBrand(productId: number): { product: Product; brand: Brand } | null {
  const db = getDb();
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId) as Product | undefined;
  if (!product) return null;
  const brand = db.prepare('SELECT * FROM brands WHERE id = ?').get(product.brand_id) as Brand | undefined;
  if (!brand) return null;
  return { product, brand };
}
