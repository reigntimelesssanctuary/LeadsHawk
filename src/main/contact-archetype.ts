/**
 * v1.19.0 — Stage 1 of contact search: archetype reasoning.
 *
 * Given (brand, product, opportunity), use Claude Sonnet 4.6 to decide
 * WHAT KIND OF CONTACT at the target company would most likely care
 * about THIS event for THIS product. Output is a structured query plan
 * (target seniorities + titles + departments + anti-patterns) that
 * Apollo's people-search endpoint can consume directly.
 *
 * Why not static title filters: different events at different companies
 * call for different archetypes. A "Singapore HQ expansion" event for
 * networking gear wants Facilities + IT-Infra leaders. A "ransomware
 * breach" event for the same product wants CISO + SOC head. Static
 * "always CIO" filters miss this nuance and burn outreach credits on
 * the wrong people.
 *
 * Sonnet (not Opus) because the reasoning is bounded — pick from a
 * known taxonomy. Opus is reserved for the draft-writing stage where
 * writing quality dominates.
 */

import { complete } from './llm.js';
import type { Brand, Product, Opportunity, ContactArchetype, ApolloSeniority } from '@shared/types';

const ARCHETYPE_SYSTEM = `You are a B2B account researcher. Given a brand's
positioning, one of its products, and a specific recent event at a target
company, your job is to decide WHAT KIND OF CONTACT at that company would
most likely BUY this product from our brand.

# CRITICAL: BUYER vs BUILDER distinction

We are selling TO the target company. The right contact is the person in
the target company's INTERNAL buying committee for OUR product category —
NOT the product team that builds what the target company sells to ITS
own customers.

Most common failure mode: when the target company is itself a tech company,
it's tempting to pick contacts in their product domain because the title
words overlap with our domain. This is almost always wrong.

WORKED EXAMPLES (study these — they're the most common mismatches):

  Example 1 — workspace design/build sold to Nvidia
    ✗ WRONG: "Director, Graphics Shader Compilers", "VP Professional
      Graphics" — these people build Nvidia's GPU products, they don't
      pick the architecture firm for Nvidia's new office.
    ✓ RIGHT: "Head of Real Estate", "Director of Workplace Strategy",
      "VP Global Facilities", "Head of Workplace Design"

  Example 2 — networking gear sold to Salesforce
    ✗ WRONG: "Director of Network Infrastructure Engineering" (this is
      a product team building Salesforce's own networking features) —
      wait, actually CONTEXT MATTERS: if Salesforce buys their corporate
      LAN gear, the right person IS their internal IT-Infra Director.
      You must distinguish: is the product team building Salesforce's
      product, or running Salesforce's internal IT? Read the company
      structure carefully.
    ✓ RIGHT: "Head of Corporate IT", "Director of Network Operations
      (internal)", "VP IT Infrastructure" — the team that runs the
      company's OWN technology, not the team building products.

  Example 3 — IT security software sold to JPMorgan
    ✓ RIGHT: "CISO", "Head of Information Security", "Director of
      Cyber Operations"
    ✗ WRONG: "Head of Cybersecurity Product" (probably doesn't exist
      at a bank, but watch for "Head of Wholesale Banking Security
      Solutions" — that's a product they SELL, not a function that
      buys from us).

  Example 4 — datacenter cooling sold to AWS
    ✗ WRONG: "Director of EC2 Engineering" — they build AWS's compute
      product.
    ✓ RIGHT: "Director of Datacenter Operations", "VP Infrastructure
      & Site Services", "Head of Edge Datacenter Construction"

# Think about it this way

For OUR product, who has:
  1. The budget line item that would pay for it?
  2. The operational pain the event creates?
  3. The authority to bring in an external vendor?

Match seniority to deal size. Director-band buyers own most operational
purchases at mid-market firms. C-suite + VP for enterprise deals or
multi-year capital programmes.

Generic "CIO" or "CTO" answers waste outreach credits. Be specific to the
function, not just the C-level.

Anti-patterns: roles that look superficially relevant but are wrong for
this context. Common ones to consider:
  - For non-product purchases: include the target company's PRODUCT
    domain words (e.g. "graphics", "shader", "compiler" when selling
    real estate to Nvidia)
  - "Marketing" for IT/infra purchases
  - "Sales" for everything (we're not selling to the sales org)
  - "Recruiting" and "HR" unless we explicitly sell HR products

Return strictly valid JSON only — no prose, no code fences.

Schema:
{
  "target_seniorities": [<one or more of: c_suite, vp, director, head, manager, senior, entry, owner, partner, founder>],
  "target_titles":      [<3-6 specific job-title strings — describe the FUNCTION, not the level; e.g. "Head of Workplace Strategy" not "Director">],
  "target_departments": [<one or more dept tags, lowercase, snake_case, e.g. "real_estate", "facilities", "it_operations", "finance">],
  "anti_patterns":      [<lowercase keywords for roles to penalise — include the target company's product-domain words when relevant>],
  "reasoning":          "<one sentence on why these archetypes for this event, explicitly noting buyer-vs-builder if the target is a tech company>"
}`;

const VALID_SENIORITIES: ApolloSeniority[] = [
  'c_suite', 'vp', 'director', 'head', 'manager',
  'senior', 'entry', 'owner', 'partner', 'founder'
];

/**
 * Fallback archetype used when Sonnet fails or returns garbage. Generic
 * but safe — targets the typical mid-market buying committee.
 */
const FALLBACK_ARCHETYPE: ContactArchetype = {
  target_seniorities: ['c_suite', 'vp', 'director'],
  target_titles: ['Vice President', 'Director', 'Head'],
  target_departments: [],
  anti_patterns: ['sales', 'marketing', 'recruiting'],
  reasoning: '(fallback archetype — Sonnet reasoning unavailable; using safe defaults)'
};

/**
 * Parse + validate Sonnet's response. Exported so the smoke test can
 * exercise it independently of the LLM call.
 */
export function parseArchetype(raw: any): ContactArchetype | null {
  if (!raw || typeof raw !== 'object') return null;
  const seniorities = Array.isArray(raw.target_seniorities)
    ? raw.target_seniorities
        .filter((s: any) => typeof s === 'string')
        .map((s: string) => s.trim().toLowerCase())
        .filter((s: string) => (VALID_SENIORITIES as string[]).includes(s)) as ApolloSeniority[]
    : [];
  const titles = Array.isArray(raw.target_titles)
    ? raw.target_titles
        .filter((s: any) => typeof s === 'string')
        .map((s: string) => s.trim())
        .filter((s: string) => s.length > 0)
        .slice(0, 12)
    : [];
  const depts = Array.isArray(raw.target_departments)
    ? raw.target_departments
        .filter((s: any) => typeof s === 'string')
        .map((s: string) => s.trim())
        .filter((s: string) => s.length > 0)
    : [];
  const antis = Array.isArray(raw.anti_patterns)
    ? raw.anti_patterns
        .filter((s: any) => typeof s === 'string')
        .map((s: string) => s.trim().toLowerCase())
        .filter((s: string) => s.length > 0)
    : [];
  const reasoning = typeof raw.reasoning === 'string' ? raw.reasoning.trim() : '';
  // Minimum bar: at least one seniority OR one title. Empty everything
  // is unusable — caller falls back.
  if (seniorities.length === 0 && titles.length === 0) return null;
  return {
    target_seniorities: seniorities,
    target_titles: titles,
    target_departments: depts,
    anti_patterns: antis,
    reasoning
  };
}

/**
 * Compact JSON extraction that tolerates code fences and prose around
 * the JSON object. Re-uses the same loose patterns as the deep-scan
 * tryParseJson — keeps this module self-contained.
 */
function extractJson(text: string): any | null {
  if (!text) return null;
  let s = text;
  // Strip markdown code fences.
  s = s.replace(/```(?:json)?\s*\n?/gi, '').replace(/```\s*$/g, '').trim();
  try { return JSON.parse(s); } catch { /* fall through */ }
  // Last-resort: greedy outer brace match.
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try { return JSON.parse(s.slice(first, last + 1)); } catch { /* ignore */ }
  }
  return null;
}

function buildPrompt(brand: Brand, product: Product, opp: Opportunity, hint?: string | null): string {
  const hintBlock = hint
    ? `\n# Operator hint (treat as authoritative — operator saw the last archetype output and is correcting it)\n${hint}\n`
    : '';
  return `${hintBlock}# Brand
Name: ${brand.name}
Category: ${brand.category || '(unspecified)'}
Positioning: ${brand.positioning || '(none on file)'}
Target ICP: ${brand.target_icp || '(not researched yet)'}
${brand.research_summary ? `\nBrand research summary:\n${brand.research_summary.slice(0, 1000)}${brand.research_summary.length > 1000 ? '…' : ''}` : ''}

# Product
Product: ${product.name}
Category: ${product.category || '(unspecified)'}
Description: ${product.description || ''}

Use cases:
${product.use_cases || ''}

Differentiators:
${product.differentiators || ''}

# Opportunity (the event at the target company)
Target company: ${opp.company}
Industry: ${opp.industry || '(unspecified)'}
Headline: ${opp.headline}

Background:
${opp.background || ''}

Buying signal: ${opp.signal_summary || ''}

# Task
Decide what kind of contact at "${opp.company}" would most likely care about
THIS event for THIS product. Output the structured archetype JSON described
in the system prompt.`;
}

export type ArchetypeOutcome = {
  archetype: ContactArchetype;
  /** 'sonnet' = parsed + validated. 'fallback' = Sonnet errored or unparseable. */
  source: 'sonnet' | 'fallback';
  /** Token cost (USD) of the Sonnet call; 0 if fallback was used. */
  llmCost: number;
  /** Raw error string if fallback was used, else null. */
  error: string | null;
};

/**
 * Derive an archetype for the given (brand, product, opp). Always returns
 * a usable archetype — falls back to a generic safe default if Sonnet
 * fails or returns unparseable output.
 *
 * v1.19.7: optional operator hint. When the operator clicks "Try with hint"
 * on the Hunt list, they supply a one-line correction (e.g. "look for Real
 * Estate and Facilities people, not engineering"). The hint is injected
 * as authoritative guidance at the top of the prompt.
 */
export async function deriveArchetype(
  brand: Brand,
  product: Product,
  opp: Opportunity,
  hint?: string | null
): Promise<ArchetypeOutcome> {
  const model = 'claude-sonnet-4-6';
  let raw = '';
  try {
    raw = await complete(ARCHETYPE_SYSTEM, buildPrompt(brand, product, opp, hint), {
      model,
      maxTokens: 800,
      temperature: 0.2,
      stage: 'contact_archetype',
      relatedId: opp.id
    });
  } catch (e: any) {
    const err = String(e?.message || e).slice(0, 300);
    console.warn(`[contact-archetype] Sonnet error for opp ${opp.id}:`, err);
    return {
      archetype: FALLBACK_ARCHETYPE,
      source: 'fallback',
      llmCost: 0,
      error: `Sonnet error: ${err}`
    };
  }
  const parsed = extractJson(raw);
  const archetype = parseArchetype(parsed);
  if (!archetype) {
    const head = raw.slice(0, 200).replace(/\s+/g, ' ');
    console.warn(`[contact-archetype] Unparseable Sonnet output for opp ${opp.id}. Head: ${head}`);
    return {
      archetype: FALLBACK_ARCHETYPE,
      source: 'fallback',
      llmCost: 0,
      error: `Unparseable Sonnet output. Head: ${head}`
    };
  }
  // recordApiCall already happened inside complete(). Cost lookup is best-
  // effort here for the audit record; the api_calls row is authoritative.
  // We pass 0 and let the audit consumer query the live cost if needed.
  return {
    archetype,
    source: 'sonnet',
    llmCost: 0,
    error: null
  };
}
