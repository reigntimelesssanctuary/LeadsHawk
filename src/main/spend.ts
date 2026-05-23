import { getDb } from './db.js';
import { estimateCost, knownModel, type LlmStage } from './pricing.js';

type RecordArgs = {
  provider: 'perplexity' | 'anthropic';
  model: string;
  stage: LlmStage;
  inputTokens: number;
  outputTokens: number;
  relatedId?: number | null;
};

/**
 * Fail-open recorder: if logging blows up, swallow the error — the caller
 * (an LLM API call) must always succeed for the user even if telemetry fails.
 */
export function recordApiCall(a: RecordArgs): void {
  try {
    const db = getDb();
    if (!knownModel(a.model)) {
      console.warn(`[spend] unknown model "${a.model}" — using fallback rate`);
    }
    const cost = estimateCost(a.model, a.inputTokens, a.outputTokens);
    db.prepare(
      `INSERT INTO api_calls(provider, model, stage, input_tokens, output_tokens, cost_usd, related_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(a.provider, a.model, a.stage, a.inputTokens, a.outputTokens, cost, a.relatedId ?? null);
  } catch (e) {
    console.warn('[spend] recordApiCall failed:', e);
  }
}

export type SpendSummary = {
  today: number;
  last7d: number;
  last30d: number;
  byStage: Array<{ stage: string; calls: number; cost: number }>;
  byModel: Array<{ model: string; calls: number; cost: number }>;
};

export function getSpendSummary(): SpendSummary {
  const db = getDb();
  const today = (db.prepare(
    "SELECT COALESCE(SUM(cost_usd),0) AS c FROM api_calls WHERE created_at >= date('now')"
  ).get() as { c: number }).c;
  const last7d = (db.prepare(
    "SELECT COALESCE(SUM(cost_usd),0) AS c FROM api_calls WHERE created_at >= datetime('now','-7 days')"
  ).get() as { c: number }).c;
  const last30d = (db.prepare(
    "SELECT COALESCE(SUM(cost_usd),0) AS c FROM api_calls WHERE created_at >= datetime('now','-30 days')"
  ).get() as { c: number }).c;

  const byStage = db.prepare(
    `SELECT stage, COUNT(*) AS calls, COALESCE(SUM(cost_usd),0) AS cost
     FROM api_calls
     WHERE created_at >= datetime('now','-30 days')
     GROUP BY stage
     ORDER BY cost DESC`
  ).all() as Array<{ stage: string; calls: number; cost: number }>;

  const byModel = db.prepare(
    `SELECT model, COUNT(*) AS calls, COALESCE(SUM(cost_usd),0) AS cost
     FROM api_calls
     WHERE created_at >= datetime('now','-30 days')
     GROUP BY model
     ORDER BY cost DESC`
  ).all() as Array<{ model: string; calls: number; cost: number }>;

  return { today, last7d, last30d, byStage, byModel };
}
