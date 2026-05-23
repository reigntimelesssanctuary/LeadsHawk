import { getDb } from './db.js';
import { complete } from './llm.js';
import type { Opportunity, Brand, Product } from '@shared/types';

const SYSTEM = `You are a B2B sales enablement writer. You produce concise,
high-signal briefs and outreach drafts that a busy account exec can use today.
Plain prose. No fluff. No emojis.`;

export async function buildBrief(opportunityId: number): Promise<string> {
  const db = getDb();
  const opp = db.prepare('SELECT * FROM opportunities WHERE id = ?').get(opportunityId) as Opportunity;
  if (!opp) throw new Error('Opportunity not found');
  const brand = opp.brand_id
    ? (db.prepare('SELECT * FROM brands WHERE id = ?').get(opp.brand_id) as Brand)
    : null;
  const product = opp.product_id
    ? (db.prepare('SELECT * FROM products WHERE id = ?').get(opp.product_id) as Product)
    : null;
  const prompt = `Write a one-page sales brief for the AE assigned to this opportunity.

Company: ${opp.company}
Industry: ${opp.industry}
Brand to lead with: ${brand?.name || '(unspecified)'}
Product to lead with: ${product?.name || '(unspecified)'}
Signal: ${opp.signal_summary}
Background: ${opp.background}
Use case: ${opp.use_case}
Recommended angle: ${opp.angle}

Source headline: ${opp.headline}
Source URL: ${opp.source_url}

Produce:

# ${opp.company} — ${product?.name || ''}
## Why now
## The fit
## Recommended approach
## Talking points (3-5 bullets)
## Draft outreach email (subject + 120 words max)`;
  return complete(SYSTEM, prompt, { maxTokens: 1400, stage: 'brief', relatedId: opportunityId });
}

export function recordDispatch(opportunityId: number, target: string, payload: string) {
  const db = getDb();
  db.prepare(
    `INSERT INTO dispatch_log(opportunity_id, target, payload, result) VALUES (?, ?, ?, 'ready')`
  ).run(opportunityId, target, payload);
}
