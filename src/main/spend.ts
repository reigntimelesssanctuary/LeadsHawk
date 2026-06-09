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

// ─── v1.11.0 — Cost Management ──────────────────────────────────────

/**
 * Operation buckets the user thinks in. Each maps to one or more
 * LlmStage values (which the code uses for fine-grained telemetry).
 * Order here drives the order rows appear in the UI.
 *
 * Exported as a pure function for smoke testing.
 */
export type OperationType =
  | 'brand_research'
  | 'product_research'
  | 'signal_research'
  | 'source_research'    // v1.13.0
  | 'manual_scan'
  | 'deep_scan'
  | 'live_monitor'
  | 'sales_brief'
  | 'contact_outreach'   // v1.19.0 — Apollo lookup + Sonnet archetype + Opus draft
  | 'other';

export function operationForStage(stage: string): OperationType {
  switch (stage) {
    case 'brand_research':
    case 'brand_research_verify':
    case 'brand_research_strategic':
    case 'brand_research_factcheck':
    case 'brand_summary':            // legacy v1.x
      return 'brand_research';
    case 'research':                 // historical: product Stage 1
    case 'product_research_verify':
    case 'product_research_strategic':
    case 'product_research_factcheck':
      return 'product_research';
    case 'brand_signals':
    case 'product_signals':
    case 'refresh_signals':          // legacy v1.x
      return 'signal_research';
    case 'brand_source_research':    // v1.13.0
      return 'source_research';
    case 'manual_scan':
      return 'manual_scan';
    case 'deep_scan':
    case 'deep_scan_discovery':
    case 'deep_scan_qualify':
      return 'deep_scan';
    case 'triage':
    case 'qualify':
      return 'live_monitor';
    case 'brief':
      return 'sales_brief';
    case 'contact_archetype':
    case 'contact_draft':
    case 'contact_lookup':           // v1.19.0
      return 'contact_outreach';
    default:
      return 'other';
  }
}

export const OPERATION_LABEL: Record<OperationType, string> = {
  brand_research: 'Brand research (all 4 stages)',
  product_research: 'Product research (all 4 stages)',
  signal_research: 'Signal research (brand + product)',
  source_research: 'Source research (auto-discover feeds)',
  manual_scan: 'Manual scan',
  deep_scan: 'Deep scan (Stage 1 + Stage 2)',
  live_monitor: 'Live Monitor (triage + qualify)',
  sales_brief: 'Sales brief generation',
  contact_outreach: 'Contact outreach (Apollo + archetype + draft)',
  other: 'Other / untagged'
};

const OPERATION_ORDER: OperationType[] = [
  'brand_research',
  'product_research',
  'signal_research',
  'source_research',
  'manual_scan',
  'deep_scan',
  'live_monitor',
  'sales_brief',
  'contact_outreach',
  'other'
];

export type OperationBucket = {
  operation: OperationType;
  label: string;
  calls: number;
  cost: number;
};

export type CostWindow = {
  totalCost: number;
  byOperation: OperationBucket[];
};

export type CostSummary = {
  today: CostWindow;
  last7d: CostWindow;
  last30d: CostWindow;
  allTime: CostWindow;
  byModel30d: Array<{ model: string; calls: number; cost: number }>;
  byStage30d: Array<{ stage: string; calls: number; cost: number }>;
  byProvider30d: Array<{ provider: string; calls: number; cost: number }>;
  // v1.11.1: per-scan-instance cost from joining scan_runs to api_calls
  // by time window (filtered to scan-related stages).
  recentScanRuns: ScanRunCostRow[];
};

export type ScanRunCostRow = {
  run_id: number;
  kind: 'manual' | 'deep';
  started_at: string;
  finished_at: string | null;
  status: string;
  items_scanned: number;
  opportunities_created: number;
  cost: number;
  api_calls: number;
};

/**
 * Aggregate raw stage-level rows into the user-facing operation buckets.
 * Pure function — exported for smoke testing.
 */
export function bucketByOperation(
  rows: Array<{ stage: string; calls: number; cost: number }>
): OperationBucket[] {
  const buckets = new Map<OperationType, OperationBucket>();
  for (const op of OPERATION_ORDER) {
    buckets.set(op, { operation: op, label: OPERATION_LABEL[op], calls: 0, cost: 0 });
  }
  for (const row of rows) {
    const op = operationForStage(row.stage);
    const b = buckets.get(op)!;
    b.calls += row.calls;
    b.cost += row.cost;
  }
  return OPERATION_ORDER.map((op) => buckets.get(op)!).filter((b) => b.calls > 0);
}

function loadWindow(db: ReturnType<typeof getDb>, sqlWhere: string): CostWindow {
  const rows = db
    .prepare(
      `SELECT stage, COUNT(*) AS calls, COALESCE(SUM(cost_usd),0) AS cost
       FROM api_calls
       ${sqlWhere}
       GROUP BY stage`
    )
    .all() as Array<{ stage: string; calls: number; cost: number }>;
  const byOperation = bucketByOperation(rows);
  const totalCost = byOperation.reduce((sum, b) => sum + b.cost, 0);
  return { totalCost, byOperation };
}

export function getCostSummary(): CostSummary {
  const db = getDb();
  const today    = loadWindow(db, "WHERE created_at >= date('now')");
  const last7d   = loadWindow(db, "WHERE created_at >= datetime('now','-7 days')");
  const last30d  = loadWindow(db, "WHERE created_at >= datetime('now','-30 days')");
  const allTime  = loadWindow(db, "");

  const byModel30d = db.prepare(
    `SELECT model, COUNT(*) AS calls, COALESCE(SUM(cost_usd),0) AS cost
     FROM api_calls
     WHERE created_at >= datetime('now','-30 days')
     GROUP BY model
     ORDER BY cost DESC`
  ).all() as Array<{ model: string; calls: number; cost: number }>;

  const byStage30d = db.prepare(
    `SELECT stage, COUNT(*) AS calls, COALESCE(SUM(cost_usd),0) AS cost
     FROM api_calls
     WHERE created_at >= datetime('now','-30 days')
     GROUP BY stage
     ORDER BY cost DESC`
  ).all() as Array<{ stage: string; calls: number; cost: number }>;

  const byProvider30d = db.prepare(
    `SELECT provider, COUNT(*) AS calls, COALESCE(SUM(cost_usd),0) AS cost
     FROM api_calls
     WHERE created_at >= datetime('now','-30 days')
     GROUP BY provider
     ORDER BY cost DESC`
  ).all() as Array<{ provider: string; calls: number; cost: number }>;

  const recentScanRuns = getRecentScanRunCosts(50);

  return { today, last7d, last30d, allTime, byModel30d, byStage30d, byProvider30d, recentScanRuns };
}

/**
 * v1.11.1: per-scan-instance cost.
 *
 * Joins `scan_runs` (each row = one scan instance with start/finish timestamps)
 * to `api_calls` filtered by scan-related stages within that time window.
 * Live-Monitor and research api_calls that happen to fire during a scan
 * window are excluded by the stage filter, so the attribution is accurate
 * even when other operations run in parallel.
 *
 * Returns the most recent N runs, newest first. Includes runs from the
 * last 30 days only.
 */
export function getRecentScanRunCosts(limit = 50): ScanRunCostRow[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT
       sr.id AS run_id,
       sr.kind,
       sr.started_at,
       sr.finished_at,
       sr.status,
       sr.items_scanned,
       sr.opportunities_created,
       COALESCE(
         (SELECT SUM(ac.cost_usd)
            FROM api_calls ac
           WHERE ac.created_at >= sr.started_at
             AND (sr.finished_at IS NULL OR ac.created_at <= sr.finished_at)
             AND ac.stage IN ('manual_scan', 'deep_scan',
                              'deep_scan_discovery', 'deep_scan_qualify')),
         0
       ) AS cost,
       COALESCE(
         (SELECT COUNT(*)
            FROM api_calls ac
           WHERE ac.created_at >= sr.started_at
             AND (sr.finished_at IS NULL OR ac.created_at <= sr.finished_at)
             AND ac.stage IN ('manual_scan', 'deep_scan',
                              'deep_scan_discovery', 'deep_scan_qualify')),
         0
       ) AS api_calls
     FROM scan_runs sr
     WHERE sr.started_at >= datetime('now', '-30 days')
     ORDER BY sr.id DESC
     LIMIT ?`
  ).all(limit) as ScanRunCostRow[];
  return rows;
}
