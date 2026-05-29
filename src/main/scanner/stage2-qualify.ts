/**
 * v1.9.0 — Stage 2 of the two-stage deep scan: qualification.
 *
 * Claude Sonnet takes the raw candidate list from Stage 1 and applies all
 * the structured judgment that was previously overloading Perplexity:
 * ICP fit, scan rules, brand-self hygiene, recently-disqualified learning,
 * pipeline dedupe, and confidence scoring. Returns OPPS_SCHEMA records
 * shaped exactly like the v1.8.x scanner output so insertCandidates can
 * persist them unchanged.
 *
 * Stage 2 does NOT search the web. It works only with the candidates
 * Stage 1 surfaced — if a candidate's company/event is too thin to judge,
 * Sonnet drops it as unqualified rather than guessing.
 */

import { complete } from '../llm.js';
import { tryParseJson } from '../perplexity.js';
import { buildDisqualificationsBlock } from '../learning.js';
import { buildOwnBrandsBlock } from '../lead-hygiene.js';
import { getDb } from '../db.js';
import { OPPS_SCHEMA } from '../scanner.js';
import { getLearningSignals } from '../learning-signals.js';
import { buildLearningPriorsBlock, applyPriorAdjustment } from '@shared/learning.js';
import type { Brand, Product, Settings, ScanRule } from '@shared/types';
import type { ScanLog, PplxOpportunity } from '../scanner.js';
import type { Stage1Output, Stage1Candidate } from './stage1-discovery.js';

export type Stage2Rejection = { company: string; reason: string };

export type Stage2Output = {
  opportunities: PplxOpportunity[];
  rejected: Stage2Rejection[];
};

const STAGE2_SYSTEM = `You are a senior B2B sales qualifier. You receive a list of
raw lead candidates surfaced by an upstream research pass, and you decide
which deserve to land in the sales pipeline.

Be skeptical but not lazy. The research pass cast a wide net by design.
Your job is to filter, not to refuse. If a candidate clearly fits the
brand's ICP and the event is a credible buying signal, keep it. If it
doesn't fit, drop it.

You do NOT do web search. You work only with the candidate list you're
given. If a candidate's company / event description is too thin to judge
confidently, drop it as unqualified rather than guessing.

For each candidate you keep, fill out the full opportunity record using
the upstream candidate's data plus your judgment. Industry, background,
use_case, angle, signal_summary, and matched_signal are your job to write.
confidence is 0..1 — be honest, most should be 0.4–0.7 unless the fit is
obvious.

Empty opportunities[] is valid only when no candidate qualifies after
honest evaluation. Always respond with strictly valid JSON only, no prose,
no code fences.`;

/**
 * Stage 2's output schema = OPPS_SCHEMA (full opportunity records) plus a
 * `rejected` array for telemetry on what got dropped and why.
 */
function buildStage2Schema(): Record<string, any> {
  return {
    type: 'object',
    required: ['opportunities', 'rejected'],
    properties: {
      opportunities: OPPS_SCHEMA.properties.opportunities,
      rejected: {
        type: 'array',
        items: {
          type: 'object',
          required: ['company', 'reason'],
          properties: {
            company: { type: 'string' },
            reason: { type: 'string' }
          }
        }
      }
    }
  };
}

function formatRawCandidates(cands: Stage1Candidate[]): string {
  if (cands.length === 0) return '(none)';
  return cands
    .map((c, i) => {
      const lines = [
        `${i + 1}. company: ${c.company}`,
        `   event: ${c.event}`
      ];
      if (c.why_relevant) lines.push(`   why_relevant: ${c.why_relevant}`);
      if (c.source_title) lines.push(`   source_title: ${c.source_title}`);
      lines.push(`   source_url: ${c.source_url}`);
      if (c.source_date) lines.push(`   source_date: ${c.source_date}`);
      return lines.join('\n');
    })
    .join('\n\n');
}

function buildRulesBlock(productId: number): string {
  const db = getDb();
  const productRules = db
    .prepare(
      "SELECT * FROM scan_rules WHERE scope = 'product' AND product_id = ? AND enabled = 1 ORDER BY kind, id"
    )
    .all(productId) as ScanRule[];
  const globalRules = db
    .prepare("SELECT * FROM scan_rules WHERE scope = 'global' AND enabled = 1 ORDER BY kind, id")
    .all() as ScanRule[];
  const rules = [...globalRules, ...productRules];
  if (rules.length === 0) return '';
  const includes = rules.filter((r) => r.kind === 'include');
  const excludes = rules.filter((r) => r.kind === 'exclude');
  const parts: string[] = ['# Hard constraints from user (apply to every candidate)'];
  if (includes.length) {
    parts.push('\nOnly keep candidates that satisfy ALL of these include rules:');
    parts.push(includes.map((r) => `- ${r.text}`).join('\n'));
  }
  if (excludes.length) {
    parts.push('\nDrop any candidate that matches ANY of these exclude rules:');
    parts.push(excludes.map((r) => `- ${r.text}`).join('\n'));
  }
  parts.push(
    "\nViolations of include rules or matches against exclude rules are non-negotiable drops, regardless of how good the fit otherwise looks."
  );
  return parts.join('\n');
}

function recentPipelineCompanies(productId: number): string[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT DISTINCT company FROM opportunities
       WHERE product_id = ?
         AND datetime(created_at) > datetime('now', '-30 days')
       ORDER BY company`
    )
    .all(productId) as Array<{ company: string }>;
  return rows.map((r) => r.company).filter(Boolean);
}

export async function stage2Qualify(
  stage1: Stage1Output,
  brand: Brand,
  product: Product,
  settings: Settings,
  log: ScanLog,
  allBrands: Brand[]
): Promise<Stage2Output> {
  if (stage1.candidates.length === 0) {
    return { opportunities: [], rejected: [] };
  }
  // v1.14.0: Sonnet 4.6 hardcoded — picker removed from Settings. This is
  // the qualify-side Claude call (was sharing settings.triageModel with the
  // Live Monitor triage stage; both now hardcoded to the same model).
  const model = 'claude-sonnet-4-6';

  const rulesBlock = buildRulesBlock(product.id);
  const disqBlock = buildDisqualificationsBlock(product.id, 8);
  const ownBrandsBlock = buildOwnBrandsBlock(allBrands);
  const pipelineCompanies = recentPipelineCompanies(product.id);
  const pipelineBlock = pipelineCompanies.length
    ? `# Already in pipeline (last 30 days — do not duplicate)
Skip new candidates whose company name matches any of these (we already
have an opportunity for them on this product):
${pipelineCompanies.map((c) => `- ${c}`).join('\n')}`
    : '';

  // v1.17.0 — learning loop. Read aggregated close rates and synthesize a
  // priors block to bias Sonnet toward patterns that have historically
  // converted, and away from patterns that haven't. Empty string when
  // we don't yet have any dimension that meets the 5W/5L threshold —
  // cold start degrades gracefully to no-op.
  const learnings = getLearningSignals();
  const learningPriorsBlock = buildLearningPriorsBlock(learnings);
  if (learningPriorsBlock) {
    const informingCount = learnings.filter((l) => l.meets_threshold).length;
    log(`  Stage 2 learning priors active: ${informingCount} informing dimension(s)`);
  }

  const rawList = formatRawCandidates(stage1.candidates);

  const prompt = `${learningPriorsBlock}# Brand
Name: ${brand.name}
Category: ${brand.category || '(unspecified)'}
Description: ${brand.description || '(none on file)'}
Positioning: ${brand.positioning || '(none on file)'}
Target ICP (ideal customer profile): ${brand.target_icp || '(not researched yet)'}
Competitive summary: ${brand.competitive_summary || '(none on file)'}
${brand.signals ? `\nBrand-level signals:\n${brand.signals}` : ''}
${brand.research_summary ? `\nBrand research summary:\n${brand.research_summary.slice(0, 1200)}${brand.research_summary.length > 1200 ? '…' : ''}` : ''}

# Product
Product: "${product.name}"
Category: ${product.category || '(unspecified)'}
Description: ${product.description || ''}

Use cases (when this product is a great fit):
${product.use_cases || ''}

Differentiators vs competitors:
${product.differentiators || ''}

Competitors:
${product.competitors || ''}
${product.research_summary ? `\nProduct research summary:\n${product.research_summary.slice(0, 1500)}${product.research_summary.length > 1500 ? '…' : ''}` : ''}

# Product-level buying signals
${product.signals || '(none derived yet)'}

# Target ICP (apply this strictly)
${brand.target_icp || '(no specific ICP on file — fall back to brand positioning)'}

${rulesBlock}

${ownBrandsBlock}

${disqBlock}

${pipelineBlock}

# Raw candidates from upstream research
${rawList}

# Task
For each numbered candidate above, decide:
1. Does the company plausibly fit our target ICP? (size, geo, sector,
   maturity, buying-team persona)
2. Is the described event a credible buying signal for THIS specific
   product, not just general news?
3. Does the candidate pass the hard constraints (include/exclude rules)?
4. Is the company NOT one of our own brands or a near-match thereof?
5. Is the company NOT already in our pipeline for this product?
6. Confidence 0..1 — be honest. Most should be 0.4–0.7 unless the fit is
   obvious.

For each survivor, produce a full opportunity record:
- company: the named organization
- industry: best guess from the event / company
- country: where the company is headquartered or where the event takes
  place (common English name, e.g. "United States"; null if unknown)
- source_url: keep from the candidate
- source_title: keep from the candidate (or empty string if missing)
- source_published_at: ISO date if known, null otherwise
- headline: a short specific headline for THIS opportunity, not just the
  article title (e.g. "Acme Corp opens 200k sqft Singapore HQ")
- background: 2–3 sentences of context — what happened, why it matters
- use_case: how OUR product would help in this specific situation
- angle: the recommended sales angle / first-contact pitch
- signal_summary: one tight sentence summarising the buying signal
- matched_signal: which of the product's signals this candidate fits
  (or a short descriptor if it's a knowledge-grounded match)
- confidence: 0..1

For each rejected candidate, briefly note its company name and the reason
(e.g. "not in ICP", "no concrete event", "matches exclude rule", "own
brand", "already in pipeline", "too thin to judge"). Keep the reason
under 12 words.

Return strict JSON of the form:
{ "opportunities": [ ... ], "rejected": [ {"company":"...","reason":"..."} ] }`;

  let raw = '';
  try {
    raw = await complete(STAGE2_SYSTEM, prompt, {
      model,
      maxTokens: 6000,
      temperature: 0.2,
      stage: 'deep_scan_qualify',
      relatedId: product.id
    });
  } catch (e: any) {
    log(`  ! Stage 2 Claude error: ${String(e?.message || e).slice(0, 300)}`);
    return { opportunities: [], rejected: [] };
  }

  const parsed = tryParseJson<{
    opportunities?: PplxOpportunity[];
    rejected?: Stage2Rejection[];
  }>(raw);
  if (!parsed) {
    const head = (raw || '').slice(0, 800).replace(/\s+/g, ' ');
    const tail = (raw || '').slice(-200).replace(/\s+/g, ' ');
    log(`  ! Stage 2 unparseable response (${(raw || '').length} chars)`);
    log(`    head: ${head}`);
    log(`    tail: …${tail}`);
    return { opportunities: [], rejected: [] };
  }
  const opportunities = Array.isArray(parsed.opportunities) ? parsed.opportunities : [];
  const rejected = Array.isArray(parsed.rejected) ? parsed.rejected : [];
  log(`  Stage 2 kept ${opportunities.length}, rejected ${rejected.length}`);
  if (rejected.length > 0) {
    // Telemetry — surface the first 3 rejection reasons so the user can
    // see why Stage 2 dropped things without opening the full log.
    const sample = rejected.slice(0, 3).map((r) => `      • ${r.company}: ${r.reason}`).join('\n');
    log(`    rejection sample:\n${sample}`);
  }

  // v1.17.0 — apply the per-candidate confidence adjustment based on
  // matched learning dimensions. Capped at ±0.15 by default; learning
  // nudges, never overrides. If no learnings apply (cold start) this is
  // a complete no-op — the function returns the input unchanged.
  let adjustedCount = 0;
  let upCount = 0;
  let downCount = 0;
  for (const opp of opportunities) {
    const result = applyPriorAdjustment(
      Number(opp.confidence ?? 0),
      {
        product_id: product.id,
        industry: opp.industry ?? null,
        confidence: Number(opp.confidence ?? 0),
        matched_signal: opp.matched_signal ?? null
      },
      learnings
    );
    if (result.matches.length > 0) {
      adjustedCount++;
      if (result.capped > 0) upCount++;
      else if (result.capped < 0) downCount++;
      opp.confidence = result.adjusted;
    }
  }
  if (adjustedCount > 0) {
    log(`  Stage 2 learning adjusted ${adjustedCount} candidate confidence(s) (↑${upCount} ↓${downCount})`);
  }

  return { opportunities, rejected };
}
