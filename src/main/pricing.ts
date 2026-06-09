/**
 * Per-1M-token rates (USD) for every model LeadsHawk talks to.
 *
 * These are estimates — easy to update as providers change pricing.
 * Cost computation is best-effort: if a model isn't found here, we
 * fall back to `UNKNOWN_RATE` so the spend dashboard still records
 * SOMETHING rather than zero (and a warning is logged).
 *
 * Sources (as of 2026-05):
 *   Perplexity: https://docs.perplexity.ai/guides/pricing
 *   Anthropic:  https://www.anthropic.com/pricing
 *
 * If you update a rate here, no other code change is needed —
 * `estimateCost()` is called from the LLM wrappers automatically.
 */

export type LlmStage =
  | 'research'                   // Perplexity sonar-deep-research, product Stage 1 dossier
  | 'brand_research'             // v1.6: Perplexity sonar-deep-research, brand Stage 1 dossier
  | 'brand_research_verify'      // v1.10.0: Claude Opus, brand Stage 2 (verify + sharpen)
  | 'brand_research_strategic'   // v1.10.0: Claude Opus, brand Stage 3 (strategic intel)
  | 'brand_research_factcheck'   // v1.10.2: Claude Opus, brand Stage 4 (fetch + verify citations)
  | 'product_research_verify'    // v1.10.0: Claude Opus, product Stage 2
  | 'product_research_strategic' // v1.10.0: Claude Opus, product Stage 3
  | 'product_research_factcheck' // v1.10.2: Claude Opus, product Stage 4
  | 'brand_summary'      // Perplexity, 150-word brand rollup (legacy; phased out by brand_research)
  | 'refresh_signals'    // Perplexity sonar-pro, signals-only refresh (legacy; v1.9.2 replaced by brand_signals / product_signals — kept so historical spend rows still label correctly)
  | 'brand_signals'      // v1.9.2: Perplexity sonar-pro, brand-level signal research
  | 'product_signals'    // v1.9.2: Perplexity sonar-pro, product-level signal research
  | 'brand_source_research'  // v1.13.0: Perplexity sonar-deep-research, auto-discover RSS / Google News sources per brand
  | 'manual_scan'        // Perplexity sonar-pro, Pass 1 + Pass 2 (cheap cron)
  | 'deep_scan'          // Perplexity sonar-deep-research, single-stage deep scan (v1.8.x fallback)
  | 'deep_scan_discovery'// v1.9: Perplexity sonar-deep-research, Stage 1 of two-stage deep scan
  | 'deep_scan_qualify'  // v1.9: Anthropic Sonnet, Stage 2 of two-stage deep scan
  | 'triage'             // Anthropic Sonnet, live-monitor stage 3
  | 'qualify'            // Perplexity sonar-pro, live-monitor stage 4
  | 'brief'              // Anthropic Opus, sales-brief generation
  | 'contact_archetype'  // v1.19: Anthropic Sonnet, who-to-reach reasoning
  | 'contact_draft'      // v1.19: Anthropic Opus + extended thinking, cold-email draft
  | 'contact_lookup'     // v1.19: Apollo (not an LLM), people search by company + filters
  | 'unknown';

type Rate = {
  input: number;   // USD per 1M input tokens
  output: number;  // USD per 1M output tokens
};

const RATES: Record<string, Rate> = {
  // Perplexity ----------------------------------------------------
  'sonar':                  { input: 1,  output: 1 },
  'sonar-pro':              { input: 3,  output: 15 },
  'sonar-reasoning':        { input: 1,  output: 5 },
  'sonar-reasoning-pro':    { input: 2,  output: 8 },
  'sonar-deep-research':    { input: 2,  output: 8 },

  // Anthropic -----------------------------------------------------
  // Approximations for the 4.x tier; adjust when official pricing posts.
  'claude-opus-4-7':            { input: 15, output: 75 },
  'claude-sonnet-4-6':          { input: 3,  output: 15 },
  'claude-haiku-4-5':           { input: 1,  output: 5 },
  'claude-haiku-4-5-20251001':  { input: 1,  output: 5 }
};

const UNKNOWN_RATE: Rate = { input: 3, output: 15 };

export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const rate = RATES[model] ?? UNKNOWN_RATE;
  const inCost  = (inputTokens  / 1_000_000) * rate.input;
  const outCost = (outputTokens / 1_000_000) * rate.output;
  return Number((inCost + outCost).toFixed(6));
}

export function knownModel(model: string): boolean {
  return Object.prototype.hasOwnProperty.call(RATES, model);
}
