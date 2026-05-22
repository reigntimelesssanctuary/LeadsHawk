export type Brand = {
  id: number;
  name: string;
  description: string | null;
  positioning: string | null;
  competitive_summary: string | null;
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
  product_id: number;
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
  created_at: string;
  updated_at: string;
};

export type DashboardStats = {
  open: number;
  qualified: number;
  disqualified: number;
  brands: number;
  lastScan: { startedAt: string; status: string; results: number } | null;
};

export type Settings = {
  anthropicApiKey: string;          // used for sales-brief generation only
  model: string;                    // Claude model for sales-brief
  perplexityApiKey: string;         // used for product research + autonomous scans
  perplexityResearchModel: string;  // model for "Run research" — recommend sonar-deep-research
  perplexityScanModel: string;      // model for scan jobs — recommend sonar-pro
  scanRecency: 'day' | 'week' | 'month';
  scanCron: string;
  scanEnabled: boolean;
  minConfidence: number;
  maxItemsPerScan: number;
};
