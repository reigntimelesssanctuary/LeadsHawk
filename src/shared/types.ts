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
  locked_signals: string | null;       // v1.15.0: JSON array of bullet-text strings the user has pinned
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
  // v1.10.2: Stage 4 fact-check — Opus verifies dossier claims against
  // actual fetched source text from Stage 1's citations.
  fact_check_report: string | null;
  last_fact_check_at: string | null;
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
  locked_signals: string | null;       // v1.15.0: JSON array of bullet-text strings the user has pinned
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
  // v1.10.2: Stage 4 fact-check.
  fact_check_report: string | null;
  last_fact_check_at: string | null;
  created_at: string;
  updated_at: string;
};

// v1.10.1: per-stage status persisted to brands.research_status_detail
// / products.research_status_detail (JSON-serialised).
// v1.10.2 extends with stage4.
export type ResearchStatusDetail = {
  stage1: string;        // 'completed' | 'failed: <reason>'
  stage2: string;        // 'completed' | 'skipped: <reason>' | 'failed: <reason>'
  stage3: string;        // 'completed' | 'skipped: <reason>' | 'failed: <reason>'
  stage4?: string;       // 'completed' | 'skipped: <reason>' | 'failed: <reason>' | 'partial: K/N sources'
  last_attempt_at: string;
};

// v1.10.2: Stage 4 fact-check output shape.
export type FactCheckSectionVerdict = {
  verdict: 'verified' | 'partially_supported' | 'unsupported' | 'inconclusive';
  reasoning: string;
  supporting_source_urls: string[];
};

export type FactCheckFlaggedClaim = {
  claim: string;
  status: 'verified' | 'unsupported' | 'contradicted' | 'inconclusive';
  source_url: string | null;
  reason: string;
};

export type FactCheckReport = {
  overall_confidence: 'high' | 'medium' | 'low';
  sources_attempted: number;
  sources_fetched: number;
  per_section_verdicts: Record<string, FactCheckSectionVerdict>;
  flagged_claims: FactCheckFlaggedClaim[];
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
  // v1.18.0: 'shadow' = sub-threshold + early-stage; preserved but hidden
  // from the Dashboard (which queries status='open'). Watchlist UI lands
  // in v1.19+.
  status: 'open' | 'qualified' | 'disqualified' | 'archived' | 'shadow';
  // v1.18.0: classified by Stage 2 (or live-monitor qualify) at insert
  // time. NULL on legacy rows + when the classifier didn't tag a stage.
  buying_stage: 'early' | 'mid' | 'late' | null;
  // v1.19.0: per-opp Dashboard chip state for the contact-search flow.
  // NULL = never searched. 'searching' = Apollo call in flight.
  // 'hunted' = ≥3 contacts found + ranked. 'no_contacts' = Apollo
  // returned <3 usable. 'search_failed' = Sonnet or Apollo errored.
  // v1.20+ extends additively (sequencing | meeting_booked | etc).
  hunt_status: 'searching' | 'hunted' | 'no_contacts' | 'search_failed' | null;
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

// v1.11.0 — Cost Management tab: operation-bucket aggregation.
// v1.13.0 — added 'source_research' for brand source auto-discovery.
export type OperationType =
  | 'brand_research'
  | 'product_research'
  | 'signal_research'
  | 'source_research'
  | 'manual_scan'
  | 'deep_scan'
  | 'live_monitor'
  | 'sales_brief'
  | 'other';

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
  recentScanRuns: ScanRunCostRow[];
};

// v1.11.1 — per-scan-instance cost row from joining scan_runs to api_calls.
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

// v1.9.2: reviewer feedback for re-research runs.
// v1.13.0: extended with 'brand_sources' for source-research feedback.
export type FeedbackTargetKind =
  | 'brand'
  | 'product'
  | 'brand_signals'
  | 'product_signals'
  | 'brand_sources';

// v1.13.0 — auto-discovered news sources per brand.
export type SourceSuggestion = {
  kind: 'rss' | 'google_news';
  name: string;
  url?: string;        // RSS only
  query?: string;      // Google News only
  why_relevant: string;
};

export type ResearchSourcesResult = {
  suggestions: SourceSuggestion[];
};

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
  perplexityApiKey: string;         // research + scans + live-monitor deep qualify
  // v1.14.0: model pickers removed from Settings UI; we hardcode the right
  // model per call site instead (sonar-deep-research for research, sonar-pro
  // for scan + qualify, claude-opus-4-7 for brief, claude-sonnet-4-6 for
  // triage). Models are upgraded via code rather than user-tunable settings.
  scanRecency: 'day' | 'week' | 'month' | 'year';
  // v1.14.0: scanCron / scanEnabled (the retired v1.x manual scan) removed.
  // Deep scan — the only scheduled engine since v1.12.0
  deepScanCron: string;
  deepScanEnabled: boolean;
  deepScanModel: string;
  // v1.14.0: deepScanTwoStage removed. Two-stage is always-on; the v1.8.7
  // monolithic single-call path is gone.
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
  // v1.10.2: when true, chain Stage 4 fact-check after Stages 1-3.
  // Stage 4 fetches cited URLs and asks Opus to verify dossier claims
  // against the actual source text. Skipped if Stage 2/3 didn't complete.
  brandResearchFactCheck: boolean;
  productResearchFactCheck: boolean;
  /** Cap on the number of citation URLs fetched and verified per call. */
  factCheckMaxSources: number;
  // v1.19.0 — Apollo API key for contact search (Phase 1 of outbound).
  apolloApiKey: string;
};

// ─────────────────────────────────────────────────────────────────────
// v1.19.0 — Contact search + drafts (Phase 1 of outbound)
// ─────────────────────────────────────────────────────────────────────

/** Apollo seniority enum — mirrors their API. */
export type ApolloSeniority =
  | 'c_suite' | 'vp' | 'director' | 'head' | 'manager'
  | 'senior' | 'entry' | 'owner' | 'partner' | 'founder';

/**
 * Output of the Sonnet archetype-reasoning step.
 * Drives Apollo's search filters AND the ranking score.
 */
export type ContactArchetype = {
  target_seniorities: ApolloSeniority[];
  target_titles: string[];
  target_departments: string[];
  anti_patterns: string[];
  reasoning: string;
};

/** Append-only audit row for each archetype invocation. */
export type ContactSearch = {
  id: number;
  opportunity_id: number;
  archetype_json: string;     // serialized ContactArchetype
  reasoning: string | null;
  contacts_found: number;
  apollo_credits: number;
  llm_cost: number;
  run_at: string;
  run_status: 'pending' | 'completed' | 'no_contacts' | 'search_failed';
};

/** A single contact attached to an opportunity. */
export type Contact = {
  id: number;
  opportunity_id: number;
  search_id: number | null;
  apollo_id: string | null;
  full_name: string;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  seniority: ApolloSeniority | null;
  department: string | null;
  email: string | null;
  email_status: 'verified' | 'guessed' | 'unavailable' | 'unverified' | null;
  linkedin_url: string | null;
  hunt_rank: number;
  hunt_score: number;
  rank_components: string | null;   // JSON breakdown
  /**
   * v1.19 states: pending | drafted | sent | skipped | failed
   * v1.20+ adds:  sequencing_active | sequence_paused_awaiting_decision |
   *               replied | bounced_hard | bounced_soft | unsubscribed |
   *               sequence_complete_no_response
   */
  contact_status: string;
  marked_sent_at: string | null;
  created_at: string;
  updated_at: string;
};

/** A single draft for a contact. Multiple versions per contact supported. */
export type ContactDraft = {
  id: number;
  contact_id: number;
  draft_version: number;
  subject: string;
  body: string;
  reasoning_trace: string | null;
  one_line_why: string | null;
  human_edited: number;            // 0 | 1
  is_active: number;               // 0 | 1
  created_at: string;
  updated_at: string;
};

/** Joined shape returned by contacts:listForOpp — contact + its active draft. */
export type ContactWithDraft = Contact & {
  active_draft: ContactDraft | null;
  draft_count: number;             // total drafts (versions) for this contact
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
  // v1.13.1: trial mode. When set, the monitor loop auto-disables the
  // source after this timestamp passes (SQLite UTC string format).
  // null = permanent.
  trial_until: string | null;
  created_at: string;
};

// v1.13.1: typed shape for monitor_sources.config JSON (most fields optional).
export type MonitorSourceConfig = {
  suggested_by_brand_id?: number;
  serves_brand_ids?: number[];
  suggested_at?: string;
  trial_period?: '24h' | '48h' | '7d' | 'permanent';
  query?: string;          // for google_news kind
  why_relevant?: string;
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
