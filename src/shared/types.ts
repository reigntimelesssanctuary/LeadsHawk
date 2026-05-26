export type Brand = {
  id: number;
  name: string;
  description: string | null;
  positioning: string | null;
  competitive_summary: string | null;
  // v1.6 brand-research fields
  research_status: 'pending' | 'researching' | 'ready' | 'error';
  research_summary: string | null;
  target_icp: string | null;          // ideal customer profile narrative
  category: string | null;             // market category
  signals: string | null;              // brand-level signals (bulleted)
  last_researched_at: string | null;
  // v1.8: recency window for scans, derived by brand research.
  scan_recency_auto: 'day' | 'week' | 'month' | 'year' | null;
  scan_recency_override: 'day' | 'week' | 'month' | 'year' | null;
  scan_enabled: number; // 0 | 1 — when 0, all of this brand's products are excluded from scans
  // v1.10.0: Opus dossier verification (Stage 2) + strategic intel (Stage 3).
  // All null when the advanced pipeline hasn't run (Stage 1 only).
  raw_dossier: string | null;          // Stage 1 raw text, preserved when Stage 2 overwrites canonical fields
  verified_dossier: string | null;     // Stage 2 output JSON (full audit)
  confidence_levels: string | null;    // JSON: { field_name → 'high'|'medium'|'low' }
  unknowns: string | null;             // Stage 2 "What we don't know" markdown
  strategic_intel: string | null;      // Stage 3 output JSON (icp_segments, buying_cycle_scenarios, competitive_plays)
  last_advanced_research_at: string | null;
  research_status_detail: string | null; // v1.10.1: per-stage status JSON for UI surfacing
  created_at: string;
  updated_at: string;
};

export type Product = {
  id: number;
  brand_id: number;
  name: string;
  description: string | null;
  category: string | null;
  use_cases: string | null;
  competitors: string | null;
  differentiators: string | null;
  signals: string | null;
  research_status: 'pending' | 'researching' | 'ready' | 'error';
  research_summary: string | null;
  last_researched_at: string | null;
  // v1.8: recency window for scans, derived by product research.
  scan_recency_auto: 'day' | 'week' | 'month' | 'year' | null;
  scan_recency_override: 'day' | 'week' | 'month' | 'year' | null;
  scan_enabled: number; // 0 | 1 — when 1, autonomous scans include this product
  // v1.10.0: Opus dossier verification (Stage 2) + strategic intel (Stage 3).
  // All null when the advanced pipeline hasn't run (Stage 1 only).
  raw_dossier: string | null;
  verified_dossier: string | null;
  confidence_levels: string | null;
  unknowns: string | null;
  strategic_intel: string | null;
  last_advanced_research_at: string | null;
  research_status_detail: string | null; // v1.10.1: per-stage status JSON
  created_at: string;
  updated_at: string;
};

// v1.10.1: per-stage status persisted to brands.research_status_detail
// / products.research_status_detail (JSON-serialised).
export type ResearchStatusDetail = {
  stage1: string;        // 'completed' | 'failed: <reason>'
  stage2: string;        // 'completed' | 'skipped: <reason>' | 'failed: <reason>'
  stage3: string;        // 'completed' | 'skipped: <reason>' | 'failed: <reason>'
  last_attempt_at: string;
};

// v1.10.0: shared types for Stage 3 strategic intel output.
export type IcpSegment = {
  name: string;
  description: string;
  decision_maker: string;
  cycle_length: string;
  key_signals: string;
};

export type StrategicIntel = {
  icp_segments: IcpSegment[];
  buying_cycle_scenarios: string;  // markdown
  competitive_plays: string;       // markdown
};

export type ConfidenceLevel = 'high' | 'medium' | 'low';
export type ConfidenceLevels = Record<string, ConfidenceLevel>;

export type KnowledgeItem = {
  id: number;
  brand_id: number | null;
  product_id: number | null;
  kind: 'file' | 'link' | 'note';
  title: string;
  source: string;
  content: string | null;
  status: 'pending' | 'indexed' | 'error';
  indexed_at: string | null;          // when chunking+embedding completed
  created_at: string;
};

export type SignalSource = {
  id: number;
  name: string;
  kind: 'google_news' | 'rss' | 'query';
  config: string;
  enabled: number;
  created_at: string;
};

export type ScanRule = {
  id: number;
  product_id: number | null;          // null when scope='global'
  scope: 'product' | 'global';
  kind: 'include' | 'exclude';
  text: string;
  enabled: number;
  created_at: string;
};

export type ScanJob = {
  id: number;
  cron: string;
  enabled: number;
  last_run_at: string | null;
  last_status: string | null;
  last_results: number | null;
  created_at: string;
};

export type ScanRun = {
  id: number;
  started_at: string;
  finished_at: string | null;
  status: 'running' | 'completed' | 'error';
  kind: 'manual' | 'deep';
  items_scanned: number;
  opportunities_created: number;
  log: string | null;
};

export type Opportunity = {
  id: number;
  brand_id: number | null;
  product_id: number | null;
  company: string;
  industry: string | null;
  country: string | null;
  headline: string;
  source_url: string;
  source_title: string;
  source_published_at: string | null;
  confidence: number;
  status: 'open' | 'qualified' | 'disqualified' | 'archived';
  background: string | null;
  use_case: string | null;
  angle: string | null;
  signal_summary: string | null;
  raw_signal: string | null;
  disqualify_reason: string | null;
  created_at: string;
  updated_at: string;
};

export type SpendSummary = {
  today: number;
  last7d: number;
  last30d: number;
  byStage: Array<{ stage: string; calls: number; cost: number }>;
  byModel: Array<{ model: string; calls: number; cost: number }>;
};

// v1.9.2: reviewer feedback for re-research runs.
export type FeedbackTargetKind =
  | 'brand'
  | 'product'
  | 'brand_signals'
  | 'product_signals';

export type DossierFeedback = {
  id: number;
  target_kind: FeedbackTargetKind;
  target_id: number;
  feedback: string;
  applied_at: string | null;
  created_at: string;
};

export type SourceHealth = {
  id: number;
  name: string;
  enabled: number;
  last_polled_at: string | null;
  last_status: string | null;
  poll_interval_seconds: number;
  ingested7d: number;
  candidates7d: number;
  strong7d: number;
  qualified7d: number;
};

export type DashboardStats = {
  open: number;
  qualified: number;
  disqualified: number;
  brands: number;
  lastScan: { startedAt: string; status: string; results: number } | null;
};

export type Settings = {
  anthropicApiKey: string;          // sales-brief generation + live-monitor triage
  model: string;                    // Claude model for sales-brief
  triageModel: string;              // Claude model for live-monitor triage stage (default sonnet 4.6)
  perplexityApiKey: string;         // research + scans + live-monitor deep qualify
  perplexityResearchModel: string;
  perplexityScanModel: string;
  scanRecency: 'day' | 'week' | 'month' | 'year';
  scanCron: string;
  scanEnabled: boolean;
  // Deep scan — separate scheduled engine using sonar-deep-research
  deepScanCron: string;
  deepScanEnabled: boolean;
  deepScanModel: string;
  // v1.9: when true, runDeepScan() splits the call into Perplexity-led
  // discovery (Stage 1) + Claude-led qualification (Stage 2). When false,
  // falls back to the v1.8.7 monolithic single-call path.
  deepScanTwoStage: boolean;
  minConfidence: number;
  maxItemsPerScan: number;
  // Live monitor
  liveMonitoringEnabled: boolean;
  embedSimilarityThreshold: number;     // 0..1, default 0.55
  notifyOnNewOpportunity: boolean;      // macOS notifications
  openAtLogin: boolean;                  // start LeadsHawk when user logs in
  // v1.7: when a scan finds an opportunity for one product, also check
  // whether it matches OTHER products' signal embeddings and create
  // additional opportunities for them. Uses embedSimilarityThreshold + 0.10
  // (so only strong cross-matches fire).
  crossMatchEnabled: boolean;
  // v1.10.0: when true, brand/product research chains Claude Opus
  // Stage 2 (verify + sharpen) and Stage 3 (strategic intel) after the
  // Perplexity Stage 1 call. Uncheck to revert to v1.9.x Stage-1-only.
  brandResearchAdvanced: boolean;
  productResearchAdvanced: boolean;
};

export type MonitorSource = {
  id: number;
  name: string;
  kind: 'rss' | 'google_news' | 'atom';
  url: string;
  config: string | null;
  enabled: number;
  poll_interval_seconds: number;
  last_polled_at: string | null;
  last_etag: string | null;
  last_modified: string | null;
  last_status: string | null;
  last_error: string | null;
  consecutive_empty_polls: number;
  created_at: string;
};

export type SignalItem = {
  id: number;
  source_id: number | null;
  url: string;
  title: string;
  snippet: string | null;
  content: string | null;
  published_at: string | null;
  fetched_at: string;
  status:
    | 'new'
    | 'embedded'
    | 'candidate'
    | 'filtered'
    | 'triaged_strong'
    | 'triaged_weak'
    | 'triaged_rejected'
    | 'qualified'
    | 'error';
  best_match_product_id: number | null;
  best_match_similarity: number | null;
  triage_result: string | null;
  triage_confidence: number | null;
  opportunity_id: number | null;
  error: string | null;
  processed_at: string | null;
};

export type MonitorStatus = {
  running: boolean;
  sources: number;
  enabledSources: number;
  embedderReady: boolean;
  embedderState: 'idle' | 'loading' | 'ready' | 'error';
  embedderError: string | null;
  last24h: {
    ingested: number;
    candidates: number;
    triagedStrong: number;
    qualified: number;
  };
};
