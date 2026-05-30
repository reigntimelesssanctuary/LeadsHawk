/**
 * v1.10.0 — Stage 2 of brand/product dossier research: Claude Opus verify + sharpen.
 *
 * Receives Stage 1's Perplexity output + citations + the knowledge blob and:
 *   • strips generic marketing language ("market-leading", "trusted partner")
 *   • annotates per-field confidence (high | medium | low)
 *   • emits a "What we don't know" markdown subsection
 *   • produces sharpened field values that overwrite the canonical columns
 *
 * Stage 2 does NOT do web search — it works only with what Stage 1 surfaced
 * plus the user's uploaded knowledge. If a claim looks thin, the model
 * downgrades confidence rather than guessing.
 *
 * Failure here preserves Stage 1 output untouched — the caller in research.ts
 * catches and logs, and Stage 3 is skipped on the same failure path.
 */

import { complete } from '../llm.js';
import { tryParseJson } from '../perplexity.js';
import { buildFeedbackBlock } from '../feedback.js';
import type { ConfidenceLevels } from '@shared/types';

/**
 * v1.10.1: result envelope so callers can surface error reasons in the UI
 * status chip instead of just seeing a null. ok=true carries the parsed
 * output; ok=false carries a short human-readable error string suitable
 * for display next to the stage status.
 */
export type StageResult<T> =
  | { ok: true; output: T }
  | { ok: false; error: string };

export type Stage2BrandInput = {
  brandId: number;
  name: string;
  stage1: {
    category: string | null;
    positioning: string | null;
    target_icp: string | null;
    competitive_summary: string | null;
    research_summary: string | null;
  };
  citations: string[];
  knowledgeBlob: string;
  /** Optional new feedback from the current request — already persisted by caller. */
  freshFeedback?: string;
};

export type Stage2BrandOutput = {
  fields: {
    category: string;
    positioning: string;
    target_icp: string;
    competitive_summary: string;
    research_summary: string;
  };
  confidence_levels: ConfidenceLevels;
  unknowns: string;
  flagged_claims?: { claim: string; reason: string }[];
};

export type Stage2ProductInput = {
  productId: number;
  name: string;
  stage1: {
    description: string | null;
    category: string | null;
    use_cases: string | null;
    competitors: string | null;
    differentiators: string | null;
    research_summary: string | null;
  };
  brand: {
    name: string;
    category: string | null;
    target_icp: string | null;
  };
  citations: string[];
  knowledgeBlob: string;
  freshFeedback?: string;
};

export type Stage2ProductOutput = {
  fields: {
    description: string;
    category: string;
    use_cases: string;
    competitors: string;
    differentiators: string;
    research_summary: string;
  };
  confidence_levels: ConfidenceLevels;
  unknowns: string;
  flagged_claims?: { claim: string; reason: string }[];
};

const VERIFY_SYSTEM = `You are a senior B2B competitive-intelligence editor. You
receive a draft brand or product dossier produced by an upstream research pass
plus the citations it consulted and the user's own uploaded knowledge.

Your job:
1. REWRITE each field for clarity and specificity. Strip generic marketing
   language ("market-leading", "trusted partner", "innovative", "best-in-class",
   "world-class", "comprehensive solution"). Replace with concrete specifics
   where the evidence supports them, or shorten / remove the sentence.
2. ANNOTATE per-field confidence (high | medium | low). High = multiple
   independent sources agree. Medium = some support but thin. Low = inferred
   or single-source. Honesty over flattery.
3. Surface "WHAT WE DON'T KNOW" as a markdown bulleted list — explicit gaps
   the upstream research didn't fully close. Useful prompts for the user to
   upload more knowledge or trigger re-research.
4. Optionally surface flagged_claims — specific upstream claims that look
   implausible given the cited sources or the knowledge blob, with a brief
   reason. Skip this if nothing is flagged.

You do NOT do web search. You work only with the upstream dossier + cited
URLs + user knowledge blob. If a field has no usable evidence at all, mark
confidence "low" and write what you can defend from the cited sources only.

Honour reviewer feedback if any is provided — feedback outranks your own
judgment for items it covers.

Respond with strictly valid JSON only, no prose, no code fences.`;

function renderCitations(citations: string[]): string {
  if (citations.length === 0) return '(no citations from upstream research)';
  return citations.slice(0, 30).map((c, i) => `  [${i + 1}] ${c}`).join('\n');
}

function fmt(v: string | null | undefined): string {
  return v && v.trim() ? v.trim() : '(empty)';
}

export async function verifyBrandDossier(
  input: Stage2BrandInput
): Promise<StageResult<Stage2BrandOutput>> {
  const feedbackBlock = buildFeedbackBlock('brand', input.brandId);

  const prompt = `# Brand
Name: ${input.name}

# Upstream draft dossier (Stage 1 — Perplexity)
## category
${fmt(input.stage1.category)}

## positioning
${fmt(input.stage1.positioning)}

## target_icp (ideal customer profile)
${fmt(input.stage1.target_icp)}

## competitive_summary
${fmt(input.stage1.competitive_summary)}

## research_summary
${fmt(input.stage1.research_summary)}

# Citations the upstream research consulted
${renderCitations(input.citations)}

# User-uploaded knowledge (brand and brand-scoped material)
${input.knowledgeBlob || '(no uploaded knowledge)'}
${feedbackBlock ? `\n${feedbackBlock}` : ''}

# Task
Rewrite the five fields above for clarity + specificity, annotate confidence,
and produce a "What we don't know" list.

Return JSON in exactly this shape:
{
  "fields": {
    "category": "...",
    "positioning": "...",
    "target_icp": "...",
    "competitive_summary": "...",
    "research_summary": "..."
  },
  "confidence_levels": {
    "category": "high|medium|low",
    "positioning": "high|medium|low",
    "target_icp": "high|medium|low",
    "competitive_summary": "high|medium|low",
    "research_summary": "high|medium|low"
  },
  "unknowns": "- gap 1\\n- gap 2\\n...",
  "flagged_claims": [
    { "claim": "verbatim upstream claim", "reason": "why it looks off" }
  ]
}

flagged_claims is optional — omit the array (or leave empty) if nothing is flagged.`;

  let raw = '';
  try {
    raw = await complete(VERIFY_SYSTEM, prompt, {
      model: 'claude-opus-4-7',
      // v1.17.2: bumped 6000 → 12000. The Stage 2 JSON output is sizeable
      // (6 fields × ~100-200 words each + 6 confidence levels + unknowns
      // list + optional flagged_claims). Opus also reasons before output,
      // and the 6K budget left too little headroom — we were seeing
      // unparseable responses where the JSON truncated mid-field.
      maxTokens: 12000,
      // v1.10.1: temperature is deprecated on Opus 4.7 — llm.ts gates it
      // automatically via modelSupportsTemperature.
      temperature: 0.2,
      stage: 'brand_research_verify',
      relatedId: input.brandId
    });
  } catch (e: any) {
    const err = String(e?.message || e).slice(0, 300);
    console.warn(`[dossier-verify:brand ${input.brandId}] Opus error: ${err}`);
    return { ok: false, error: `Opus API error: ${err}` };
  }

  const parsed = tryParseJson<Stage2BrandOutput>(raw);
  if (!parsed || !parsed.fields || !parsed.confidence_levels) {
    const head = (raw || '').slice(0, 200).replace(/\s+/g, ' ').trim();
    console.warn(`[dossier-verify:brand ${input.brandId}] unparseable Stage 2 response`);
    console.warn(`  head: ${head}`);
    // v1.17.2: include the response preview in the error itself so the
    // user sees it directly in the chip's expanded view — no terminal
    // access required to diagnose.
    return {
      ok: false,
      error: head
        ? `Unparseable Stage 2 response. Head: ${head}`
        : 'Unparseable Stage 2 response (empty body)'
    };
  }
  // Coerce missing string fields to safe defaults so downstream DB write
  // doesn't violate NOT NULL.
  return {
    ok: true,
    output: {
      fields: {
        category: parsed.fields.category || input.stage1.category || '',
        positioning: parsed.fields.positioning || input.stage1.positioning || '',
        target_icp: parsed.fields.target_icp || input.stage1.target_icp || '',
        competitive_summary: parsed.fields.competitive_summary || input.stage1.competitive_summary || '',
        research_summary: parsed.fields.research_summary || input.stage1.research_summary || ''
      },
      confidence_levels: parsed.confidence_levels,
      unknowns: parsed.unknowns || '',
      flagged_claims: parsed.flagged_claims || []
    }
  };
}

export async function verifyProductDossier(
  input: Stage2ProductInput
): Promise<StageResult<Stage2ProductOutput>> {
  const feedbackBlock = buildFeedbackBlock('product', input.productId);

  const prompt = `# Brand context
Name: ${input.brand.name}
Category: ${input.brand.category || '(unspecified)'}
Target ICP: ${input.brand.target_icp || '(not researched)'}

# Product
Name: ${input.name}

# Upstream draft dossier (Stage 1 — Perplexity)
## description
${fmt(input.stage1.description)}

## category
${fmt(input.stage1.category)}

## use_cases
${fmt(input.stage1.use_cases)}

## competitors
${fmt(input.stage1.competitors)}

## differentiators
${fmt(input.stage1.differentiators)}

## research_summary
${fmt(input.stage1.research_summary)}

# Citations the upstream research consulted
${renderCitations(input.citations)}

# User-uploaded knowledge (brand and product-scoped material)
${input.knowledgeBlob || '(no uploaded knowledge)'}
${feedbackBlock ? `\n${feedbackBlock}` : ''}

# Task
Rewrite the six fields above for clarity + specificity, annotate confidence,
and produce a "What we don't know" list.

Return JSON in exactly this shape:
{
  "fields": {
    "description": "...",
    "category": "...",
    "use_cases": "...",
    "competitors": "...",
    "differentiators": "...",
    "research_summary": "..."
  },
  "confidence_levels": {
    "description": "high|medium|low",
    "category": "high|medium|low",
    "use_cases": "high|medium|low",
    "competitors": "high|medium|low",
    "differentiators": "high|medium|low",
    "research_summary": "high|medium|low"
  },
  "unknowns": "- gap 1\\n- gap 2\\n...",
  "flagged_claims": [
    { "claim": "verbatim upstream claim", "reason": "why it looks off" }
  ]
}

flagged_claims is optional — omit the array (or leave empty) if nothing is flagged.`;

  let raw = '';
  try {
    raw = await complete(VERIFY_SYSTEM, prompt, {
      model: 'claude-opus-4-7',
      // v1.17.2: bumped 6000 → 12000 to give the verified-dossier JSON
      // enough output headroom. See brand version above for full rationale.
      maxTokens: 12000,
      temperature: 0.2,
      stage: 'product_research_verify',
      relatedId: input.productId
    });
  } catch (e: any) {
    const err = String(e?.message || e).slice(0, 300);
    console.warn(`[dossier-verify:product ${input.productId}] Opus error: ${err}`);
    return { ok: false, error: `Opus API error: ${err}` };
  }

  const parsed = tryParseJson<Stage2ProductOutput>(raw);
  if (!parsed || !parsed.fields || !parsed.confidence_levels) {
    const head = (raw || '').slice(0, 200).replace(/\s+/g, ' ').trim();
    console.warn(`[dossier-verify:product ${input.productId}] unparseable Stage 2 response`);
    console.warn(`  head: ${head}`);
    // v1.17.2: include the response preview in the error itself so the
    // user sees it directly in the chip's expanded view.
    return {
      ok: false,
      error: head
        ? `Unparseable Stage 2 response. Head: ${head}`
        : 'Unparseable Stage 2 response (empty body)'
    };
  }
  return {
    ok: true,
    output: {
      fields: {
        description: parsed.fields.description || input.stage1.description || '',
        category: parsed.fields.category || input.stage1.category || '',
        use_cases: parsed.fields.use_cases || input.stage1.use_cases || '',
        competitors: parsed.fields.competitors || input.stage1.competitors || '',
        differentiators: parsed.fields.differentiators || input.stage1.differentiators || '',
        research_summary: parsed.fields.research_summary || input.stage1.research_summary || ''
      },
      confidence_levels: parsed.confidence_levels,
      unknowns: parsed.unknowns || '',
      flagged_claims: parsed.flagged_claims || []
    }
  };
}
