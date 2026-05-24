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
  scan_enabled: number; // 0 | 1 — when 0, all of this brand's products are excluded from scans
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
  scan_enabled: number; // 0 | 1 — when 1, autonomous scans include this product
  created_at: string;
  updated_at: string;
};

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
  scanRecency: 'day' | 'week' | 'month';
  scanCron: string;
  scanEnabled: boolean;
  // Deep scan — separate scheduled engine using sonar-deep-research
  deepScanCron: string;
  deepScanEnabled: boolean;
  deepScanModel: string;
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
