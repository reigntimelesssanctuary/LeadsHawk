/**
 * v1.10.0 — Stage 3 of brand/product dossier research: Claude Opus strategic intel.
 *
 * Builds ON the verified (Stage 2) dossier and produces NEW structured content
 * Perplexity didn't generate well: ICP segmentation, buying-cycle scenarios,
 * and competitive plays. These are the kind of things a sales strategist would
 * write manually after reading a research dossier — automating them saves
 * judgment-cycles per brand/product.
 *
 * Stage 3 takes Stage 2's sharpened output as input. Failure here is non-fatal:
 * the verified dossier from Stage 2 is preserved and the user just doesn't get
 * the Strategic Intelligence section in the UI for this run.
 */

import { complete } from '../llm.js';
import { tryParseJson } from '../perplexity.js';
import { buildFeedbackBlock } from '../feedback.js';
import type { StrategicIntel } from '@shared/types';

export type Stage3BrandInput = {
  brandId: number;
  name: string;
  verified: {
    category: string;
    positioning: string;
    target_icp: string;
    competitive_summary: string;
    research_summary: string;
  };
};

export type Stage3ProductInput = {
  productId: number;
  name: string;
  brandName: string;
  verified: {
    description: string;
    category: string;
    use_cases: string;
    competitors: string;
    differentiators: string;
    research_summary: string;
  };
  brand: {
    target_icp: string | null;
    positioning: string | null;
  };
};

const STRATEGIC_SYSTEM = `You are a senior B2B sales strategist. You receive a
verified brand or product dossier and produce a tight strategic-intelligence
layer a sales team can act on directly.

Your output has three parts:

1. icp_segments — 3 to 5 named sub-ICPs derived from the broad target_icp.
   Each segment names a specific customer archetype with:
     • description — concrete shape (size, geo, sector, maturity)
     • decision_maker — the buying-team persona who typically initiates
     • cycle_length — typical buying-cycle duration
     • key_signals — observable events that indicate this sub-ICP is in-market
   Be specific. Three sharp segments beat five vague ones.

2. buying_cycle_scenarios — markdown narrative (≤500 words) describing how a
   typical deal starts → develops → closes for this brand/product. Use
   subheadings for distinct scenarios if there are multiple meaningful paths.

3. competitive_plays — markdown narrative (≤500 words) describing how to win
   against the named competitors from the dossier. Use a subheading per
   competitor when relevant. Skip generic statements; if you don't have
   enough material to write something concrete for a competitor, say so or
   omit them rather than padding.

You do NOT do web search. You work only with the dossier provided. Honour
reviewer feedback if any is supplied.

Respond with strictly valid JSON only, no prose, no code fences.`;

function buildOutputSchemaInstruction(): string {
  return `Return JSON in exactly this shape:
{
  "icp_segments": [
    {
      "name": "short segment label",
      "description": "1-2 sentence shape — size, geo, sector, maturity",
      "decision_maker": "persona who initiates the deal",
      "cycle_length": "e.g. 3-6 months, 12-18 months",
      "key_signals": "- signal 1\\n- signal 2\\n..."
    }
  ],
  "buying_cycle_scenarios": "markdown narrative (≤500 words)",
  "competitive_plays": "markdown narrative (≤500 words)"
}`;
}

export async function strategicIntelForBrand(
  input: Stage3BrandInput
): Promise<StrategicIntel | null> {
  const feedbackBlock = buildFeedbackBlock('brand', input.brandId);

  const prompt = `# Brand — verified dossier
Name: ${input.name}
Category: ${input.verified.category}

## Positioning
${input.verified.positioning}

## Target ICP
${input.verified.target_icp}

## Competitive summary
${input.verified.competitive_summary}

## Research summary
${input.verified.research_summary}
${feedbackBlock ? `\n${feedbackBlock}` : ''}

# Task
Produce the strategic intel layer for this brand: 3–5 ICP segments,
buying-cycle scenarios narrative, competitive plays narrative.

${buildOutputSchemaInstruction()}`;

  let raw = '';
  try {
    raw = await complete(STRATEGIC_SYSTEM, prompt, {
      model: 'claude-opus-4-7',
      maxTokens: 6000,
      temperature: 0.3,
      stage: 'brand_research_strategic',
      relatedId: input.brandId
    });
  } catch (e: any) {
    console.warn(`[dossier-strategic:brand ${input.brandId}] Opus error: ${String(e?.message || e).slice(0, 300)}`);
    return null;
  }

  const parsed = tryParseJson<StrategicIntel>(raw);
  if (!parsed || !Array.isArray(parsed.icp_segments)) {
    const head = (raw || '').slice(0, 800).replace(/\s+/g, ' ');
    console.warn(`[dossier-strategic:brand ${input.brandId}] unparseable Stage 3 response`);
    console.warn(`  head: ${head}`);
    return null;
  }
  return {
    icp_segments: parsed.icp_segments,
    buying_cycle_scenarios: parsed.buying_cycle_scenarios || '',
    competitive_plays: parsed.competitive_plays || ''
  };
}

export async function strategicIntelForProduct(
  input: Stage3ProductInput
): Promise<StrategicIntel | null> {
  const feedbackBlock = buildFeedbackBlock('product', input.productId);

  const prompt = `# Brand context
Name: ${input.brandName}
Brand positioning: ${input.brand.positioning || '(unspecified)'}
Brand target ICP: ${input.brand.target_icp || '(unspecified)'}

# Product — verified dossier
Name: ${input.name}
Category: ${input.verified.category}

## Description
${input.verified.description}

## Use cases
${input.verified.use_cases}

## Competitors
${input.verified.competitors}

## Differentiators
${input.verified.differentiators}

## Research summary
${input.verified.research_summary}
${feedbackBlock ? `\n${feedbackBlock}` : ''}

# Task
Produce the strategic intel layer for this PRODUCT: 3–5 ICP segments
(scoped to who buys this specific product, not the whole brand),
buying-cycle scenarios narrative, competitive plays narrative against the
listed competitors.

${buildOutputSchemaInstruction()}`;

  let raw = '';
  try {
    raw = await complete(STRATEGIC_SYSTEM, prompt, {
      model: 'claude-opus-4-7',
      maxTokens: 6000,
      temperature: 0.3,
      stage: 'product_research_strategic',
      relatedId: input.productId
    });
  } catch (e: any) {
    console.warn(`[dossier-strategic:product ${input.productId}] Opus error: ${String(e?.message || e).slice(0, 300)}`);
    return null;
  }

  const parsed = tryParseJson<StrategicIntel>(raw);
  if (!parsed || !Array.isArray(parsed.icp_segments)) {
    const head = (raw || '').slice(0, 800).replace(/\s+/g, ' ');
    console.warn(`[dossier-strategic:product ${input.productId}] unparseable Stage 3 response`);
    console.warn(`  head: ${head}`);
    return null;
  }
  return {
    icp_segments: parsed.icp_segments,
    buying_cycle_scenarios: parsed.buying_cycle_scenarios || '',
    competitive_plays: parsed.competitive_plays || ''
  };
}
