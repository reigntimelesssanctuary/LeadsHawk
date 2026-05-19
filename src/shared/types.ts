export type Brand = {
  id: number;
  name: string;
  description: string | null;
  positioning: string | null;
  competitive_summary: string | null;
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
  anthropicApiKey: string;
  model: string;
  scanCron: string;
  scanEnabled: boolean;
  minConfidence: number;
  maxItemsPerScan: number;
};
