import Database from 'better-sqlite3';
import { app } from 'electron';
import { mkdirSync } from 'fs';
import { join } from 'path';

let db: Database.Database;

export function getDb(): Database.Database {
  if (db) return db;
  const dataDir = join(app.getPath('userData'), 'data');
  mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, 'leadshawk.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

export function dataDir(): string {
  const dir = join(app.getPath('userData'), 'data');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function migrate(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS brands (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      positioning TEXT,
      competitive_summary TEXT,
      scan_enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      category TEXT,
      use_cases TEXT,
      competitors TEXT,
      differentiators TEXT,
      signals TEXT,
      research_status TEXT NOT NULL DEFAULT 'pending',
      research_summary TEXT,
      scan_enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS knowledge_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      brand_id INTEGER REFERENCES brands(id) ON DELETE CASCADE,
      product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      source TEXT NOT NULL,
      content TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS signal_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      config TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS scan_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cron TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run_at TEXT,
      last_status TEXT,
      last_results INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS scan_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      items_scanned INTEGER NOT NULL DEFAULT 0,
      opportunities_created INTEGER NOT NULL DEFAULT 0,
      log TEXT
    );

    CREATE TABLE IF NOT EXISTS opportunities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      brand_id INTEGER REFERENCES brands(id) ON DELETE SET NULL,
      product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
      company TEXT NOT NULL,
      industry TEXT,
      headline TEXT NOT NULL,
      source_url TEXT NOT NULL,
      source_title TEXT NOT NULL,
      source_published_at TEXT,
      confidence REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'open',
      background TEXT,
      use_case TEXT,
      angle TEXT,
      signal_summary TEXT,
      raw_signal TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS dispatch_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      opportunity_id INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
      target TEXT NOT NULL,
      payload TEXT,
      result TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS seen_urls (
      url TEXT PRIMARY KEY,
      seen_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS scan_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_opps_status ON opportunities(status);
    CREATE INDEX IF NOT EXISTS idx_products_brand ON products(brand_id);
    CREATE INDEX IF NOT EXISTS idx_knowledge_brand ON knowledge_items(brand_id);

    -- Live Monitor (v1.1) -------------------------------------
    CREATE TABLE IF NOT EXISTS monitor_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'rss',
      url TEXT NOT NULL,
      config TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      poll_interval_seconds INTEGER NOT NULL DEFAULT 900,
      last_polled_at TEXT,
      last_etag TEXT,
      last_modified TEXT,
      last_status TEXT,
      last_error TEXT,
      consecutive_empty_polls INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS signal_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER REFERENCES monitor_sources(id) ON DELETE SET NULL,
      url TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      snippet TEXT,
      content TEXT,
      published_at TEXT,
      fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
      status TEXT NOT NULL DEFAULT 'new',
      best_match_product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
      best_match_similarity REAL,
      triage_result TEXT,
      triage_confidence REAL,
      opportunity_id INTEGER REFERENCES opportunities(id) ON DELETE SET NULL,
      error TEXT,
      processed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_items_status ON signal_items(status);
    CREATE INDEX IF NOT EXISTS idx_items_fetched ON signal_items(fetched_at);
    CREATE INDEX IF NOT EXISTS idx_items_source ON signal_items(source_id);

    -- v1.2 -----------------------------------------------------
    -- Every external LLM call is logged here. Used by the Spend dashboard.
    CREATE TABLE IF NOT EXISTS api_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,           -- 'perplexity' | 'anthropic'
      model TEXT NOT NULL,
      stage TEXT NOT NULL,              -- LlmStage values from pricing.ts
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      related_id INTEGER,                -- opportunity_id, item_id, product_id, etc.
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_api_calls_created ON api_calls(created_at);
    CREATE INDEX IF NOT EXISTS idx_api_calls_stage   ON api_calls(stage);

    -- v1.3 -----------------------------------------------------
    -- Fingerprints of items the user disqualified. The live monitor's
    -- pre-filter uses these to demote similar incoming items (Layer B).
    -- Persists even if the source opportunity is deleted — the learning
    -- doesn't go away just because the user cleaned up their inbox.
    CREATE TABLE IF NOT EXISTS disqualify_vectors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      headline TEXT NOT NULL,
      reason TEXT,
      embedding TEXT NOT NULL,           -- JSON Float32 array
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_disq_vectors_product ON disqualify_vectors(product_id);
  `);

  // Idempotent column additions for upgrade-in-place
  addColumnIfMissing(db, 'products', 'scan_enabled', 'INTEGER NOT NULL DEFAULT 1');
  addColumnIfMissing(db, 'brands', 'scan_enabled', 'INTEGER NOT NULL DEFAULT 1');
  addColumnIfMissing(db, 'scan_rules', 'product_id', 'INTEGER');
  addColumnIfMissing(db, 'products', 'signal_embeddings', 'TEXT'); // JSON [{text, embedding[]}]
  // v1.2: optional one-line user explanation on Disqualify.
  addColumnIfMissing(db, 'opportunities', 'disqualify_reason', 'TEXT');
  // v1.3: per-product scope on scan rules ('product' default, or 'global').
  addColumnIfMissing(db, 'scan_rules', 'scope', "TEXT NOT NULL DEFAULT 'product'");
  // v1.5: differentiate manual / deep cron runs in the history table.
  addColumnIfMissing(db, 'scan_runs', 'kind', "TEXT NOT NULL DEFAULT 'manual'");
  // v1.5.1: optional country captured by the scanner's LLM call.
  addColumnIfMissing(db, 'opportunities', 'country', 'TEXT');
  // v1.8: per-brand / per-product scan recency.
  // _auto is set by research; _override is the user's explicit choice (wins
  // when set). Resolution order at scan time:
  //   product.override → product.auto → brand.override → brand.auto → settings.scanRecency
  addColumnIfMissing(db, 'brands', 'scan_recency_auto', 'TEXT');
  addColumnIfMissing(db, 'brands', 'scan_recency_override', 'TEXT');
  addColumnIfMissing(db, 'products', 'scan_recency_auto', 'TEXT');
  addColumnIfMissing(db, 'products', 'scan_recency_override', 'TEXT');

  // v1.6: brand becomes a first-class research subject.
  addColumnIfMissing(db, 'brands', 'research_status', "TEXT NOT NULL DEFAULT 'pending'");
  addColumnIfMissing(db, 'brands', 'research_summary', 'TEXT');
  addColumnIfMissing(db, 'brands', 'target_icp', 'TEXT');
  addColumnIfMissing(db, 'brands', 'category', 'TEXT');
  addColumnIfMissing(db, 'brands', 'signals', 'TEXT');
  addColumnIfMissing(db, 'brands', 'last_researched_at', 'TEXT');
  // Brand website / primary domain. Surfaced by the HTTP bridge at
  // src/main/bridge.ts so external agents (Hermes BDM) can resolve a
  // brand to its canonical domain without re-scraping. Stored normalized
  // (lowercased, protocol/www/path stripped) — see cleanDomain() in
  // src/main/hunter.ts.
  addColumnIfMissing(db, 'brands', 'domain', 'TEXT');
  addColumnIfMissing(db, 'products', 'last_researched_at', 'TEXT');
  // Track when each knowledge_item finished being chunked + embedded.
  addColumnIfMissing(db, 'knowledge_items', 'indexed_at', 'TEXT');

  // v1.6: real knowledge indexing — chunks + embeddings per knowledge_item.
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
      ord INTEGER NOT NULL,
      text TEXT NOT NULL,
      embedding TEXT NOT NULL,        -- JSON Float32 array (384-dim from MiniLM)
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_item ON knowledge_chunks(item_id);
  `);

  // v1.10.0: Opus dossier verification + strategic intelligence.
  // Stage 1 (Perplexity) still writes the canonical columns. Stage 2 (Opus)
  // overwrites canonical fields with sharpened versions; the raw Stage 1 text
  // is preserved in raw_dossier for audit. confidence_levels + unknowns track
  // Stage 2's metadata. strategic_intel holds Stage 3's structured output.
  addColumnIfMissing(db, 'brands', 'raw_dossier', 'TEXT');
  addColumnIfMissing(db, 'brands', 'verified_dossier', 'TEXT');
  addColumnIfMissing(db, 'brands', 'confidence_levels', 'TEXT');
  addColumnIfMissing(db, 'brands', 'unknowns', 'TEXT');
  addColumnIfMissing(db, 'brands', 'strategic_intel', 'TEXT');
  addColumnIfMissing(db, 'brands', 'last_advanced_research_at', 'TEXT');
  // v1.10.1: per-stage status surfacing so silent failures are visible.
  addColumnIfMissing(db, 'brands', 'research_status_detail', 'TEXT');
  addColumnIfMissing(db, 'products', 'raw_dossier', 'TEXT');
  addColumnIfMissing(db, 'products', 'verified_dossier', 'TEXT');
  addColumnIfMissing(db, 'products', 'confidence_levels', 'TEXT');
  addColumnIfMissing(db, 'products', 'unknowns', 'TEXT');
  addColumnIfMissing(db, 'products', 'strategic_intel', 'TEXT');
  addColumnIfMissing(db, 'products', 'last_advanced_research_at', 'TEXT');
  addColumnIfMissing(db, 'products', 'research_status_detail', 'TEXT');

  // v1.10.2: Stage 4 fact-check (fetch cited URLs + Opus verifies claims
  // against actual source text). fact_check_report holds the JSON output;
  // last_fact_check_at timestamps a successful run.
  addColumnIfMissing(db, 'brands', 'fact_check_report', 'TEXT');
  addColumnIfMissing(db, 'brands', 'last_fact_check_at', 'TEXT');
  addColumnIfMissing(db, 'products', 'fact_check_report', 'TEXT');
  addColumnIfMissing(db, 'products', 'last_fact_check_at', 'TEXT');

  // v1.13.1: trial mode for monitor sources. When set, the monitor loop
  // auto-disables the source after this timestamp passes. Sources can be
  // promoted (trial_until cleared) or extended.
  addColumnIfMissing(db, 'monitor_sources', 'trial_until', 'TEXT');

  // v1.13.2: persist pending source-research suggestions so closing the
  // modal mid-research doesn't waste the Perplexity spend. One row per
  // brand at most (UPSERT on brand_id). consumed_at marks rows the user
  // has already reviewed + added (or dismissed) so they don't re-appear.
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_source_suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      brand_id INTEGER NOT NULL UNIQUE REFERENCES brands(id) ON DELETE CASCADE,
      suggestions_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      consumed_at TEXT
    );
  `);

  // v1.9.2: reviewer feedback for dossier and signal re-research.
  // target_kind = 'brand' | 'product' | 'brand_signals' | 'product_signals'
  // applied_at is set when the research run that consumed this feedback
  // completes successfully; NULL means the feedback hasn't been applied yet.
  db.exec(`
    CREATE TABLE IF NOT EXISTS dossier_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_kind TEXT NOT NULL,
      target_id INTEGER NOT NULL,
      feedback TEXT NOT NULL,
      applied_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_target
      ON dossier_feedback(target_kind, target_id, created_at DESC);
  `);

  // v1.15.0: per-signal locks. The signals column stays a newline-joined
  // text blob; locked_signals holds a JSON array of bullet-text strings
  // the user has explicitly pinned. Re-research preserves locked entries:
  // signal-research.ts prepends them to the prompt as "must keep exactly
  // as-is" instructions AND merges them back into the LLM output if it
  // dropped any (see mergeLockedIntoSignals in src/shared/signals.ts).
  addColumnIfMissing(db, 'brands', 'locked_signals', 'TEXT');
  addColumnIfMissing(db, 'products', 'locked_signals', 'TEXT');

  // v1.16.0 — outcome capture / learning event log.
  //
  // opportunity_events is the IMMUTABLE source of truth: append-only, no
  // updates, no deletes. Current state lives in opportunity_state_cache,
  // which is a derived projection rebuilt by replaying the log via
  // projectOpportunityState() in src/shared/lifecycle.ts.
  //
  // tenant_id is hardcoded 1 in single-tenant mode but the column exists
  // from day one so v1.18 cross-client aggregation doesn't need a schema
  // rewrite. embedding (JSON Float32 array) is populated for closed_won /
  // closed_lost events at record time so v1.17 RAG retrieval can find
  // semantically similar past outcomes when scoring new candidates.
  db.exec(`
    CREATE TABLE IF NOT EXISTS opportunity_events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id       INTEGER NOT NULL DEFAULT 1,
      opportunity_id  INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
      event_type      TEXT NOT NULL,
      payload_json    TEXT,
      occurred_at     TEXT NOT NULL,
      recorded_at     TEXT NOT NULL DEFAULT (datetime('now')),
      actor_kind      TEXT NOT NULL DEFAULT 'user',
      actor_id        TEXT,
      provenance      TEXT,
      embedding       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_opp_events_opp
      ON opportunity_events(opportunity_id, occurred_at, id);
    CREATE INDEX IF NOT EXISTS idx_opp_events_type
      ON opportunity_events(event_type, occurred_at);
    CREATE INDEX IF NOT EXISTS idx_opp_events_tenant
      ON opportunity_events(tenant_id, event_type);
  `);

  // Derived state. Renderer reads from here for the Stage column,
  // pipeline summary, stale-check, etc. Never written directly — only
  // rebuilt by main/events.ts after each append.
  db.exec(`
    CREATE TABLE IF NOT EXISTS opportunity_state_cache (
      opportunity_id          INTEGER PRIMARY KEY REFERENCES opportunities(id) ON DELETE CASCADE,
      current_stage           TEXT NOT NULL,
      delivered_at            TEXT,
      accepted_at             TEXT,
      closed_at               TEXT,
      close_value             REAL,
      close_currency          TEXT,
      cycle_days              INTEGER,
      primary_factor          TEXT,
      is_closed_won           INTEGER NOT NULL DEFAULT 0,
      is_closed_lost          INTEGER NOT NULL DEFAULT 0,
      effective_close_event_id INTEGER,
      last_event_id           INTEGER NOT NULL,
      last_event_at           TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_opp_state_stage
      ON opportunity_state_cache(current_stage);
    CREATE INDEX IF NOT EXISTS idx_opp_state_closed
      ON opportunity_state_cache(closed_at) WHERE closed_at IS NOT NULL;
  `);

  // Tenancy field on opportunities. v1.17 will add it to other tables
  // (learning_signals, etc.) but the parent gets it now so foreign-key
  // joins land on a tenant-aware boundary from day one.
  addColumnIfMissing(db, 'opportunities', 'tenant_id', 'INTEGER NOT NULL DEFAULT 1');

  // v1.17.0 — learning loop. Per-dimension aggregates of closed-won / lost
  // outcomes. Rebuilt from scratch by recomputeAllLearningSignals() (in
  // src/main/learning-signals.ts) whenever an outcome event lands or at
  // app startup. The dimension+value pair is the natural key per tenant;
  // counts and smoothed/CI estimates are precomputed on write so Stage 2
  // doesn't pay math at scan time.
  db.exec(`
    CREATE TABLE IF NOT EXISTS learning_signals (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id            INTEGER NOT NULL DEFAULT 1,
      dimension            TEXT NOT NULL,
      dimension_value      TEXT NOT NULL,
      n_closed_won         INTEGER NOT NULL DEFAULT 0,
      n_closed_lost        INTEGER NOT NULL DEFAULT 0,
      sum_close_value      REAL NOT NULL DEFAULT 0,
      smoothed_close_rate  REAL NOT NULL DEFAULT 0,
      raw_close_rate       REAL NOT NULL DEFAULT 0,
      ci_low               REAL NOT NULL DEFAULT 0,
      ci_high              REAL NOT NULL DEFAULT 1,
      meets_threshold      INTEGER NOT NULL DEFAULT 0,
      last_recomputed_at   TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tenant_id, dimension, dimension_value)
    );
    CREATE INDEX IF NOT EXISTS idx_learning_dimension
      ON learning_signals(tenant_id, dimension, meets_threshold);
  `);

  // v1.19.0 — contact search + drafts (Phase 1 of outbound).
  //
  // Three new tables + one column on opportunities:
  //
  //   contact_searches   — append-only audit log of every archetype-reasoning
  //                        invocation. Each row captures the Sonnet output,
  //                        the Apollo credit spend, and the outcome.
  //   contacts           — Apollo-sourced contacts attached to an opportunity.
  //                        Ranked + state-machine'd (pending → drafted → sent /
  //                        skipped, with Phase 2 states added later additively).
  //                        Unique (opportunity_id, apollo_id) so re-search
  //                        dedups cleanly.
  //   contact_drafts     — per-contact draft history. Multiple versions per
  //                        contact supported; is_active=1 marks the
  //                        currently-selected draft for any send action.
  //                        Enforced by partial unique index.
  //   opportunities.hunt_status — Dashboard chip state. NULL until first
  //                        search; then 'searching' | 'hunted' | 'no_contacts'
  //                        | 'search_failed'. Phase 2 extends additively.
  db.exec(`
    CREATE TABLE IF NOT EXISTS contact_searches (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      opportunity_id  INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
      archetype_json  TEXT NOT NULL,
      reasoning       TEXT,
      contacts_found  INTEGER NOT NULL DEFAULT 0,
      apollo_credits  INTEGER NOT NULL DEFAULT 0,
      llm_cost        REAL NOT NULL DEFAULT 0,
      run_at          TEXT NOT NULL DEFAULT (datetime('now')),
      run_status      TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE INDEX IF NOT EXISTS idx_contact_searches_opp ON contact_searches(opportunity_id);

    CREATE TABLE IF NOT EXISTS contacts (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      opportunity_id  INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
      search_id       INTEGER REFERENCES contact_searches(id) ON DELETE SET NULL,
      apollo_id       TEXT,
      full_name       TEXT NOT NULL,
      first_name      TEXT,
      last_name       TEXT,
      title           TEXT,
      seniority       TEXT,
      department      TEXT,
      email           TEXT,
      email_status    TEXT,
      linkedin_url    TEXT,
      hunt_rank       INTEGER NOT NULL,
      hunt_score      REAL NOT NULL,
      rank_components TEXT,
      contact_status  TEXT NOT NULL DEFAULT 'pending',
      marked_sent_at  TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_contacts_opp ON contacts(opportunity_id);
    CREATE INDEX IF NOT EXISTS idx_contacts_rank ON contacts(opportunity_id, hunt_rank);
    CREATE INDEX IF NOT EXISTS idx_contacts_status ON contacts(contact_status);
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_contacts_apollo_per_opp
      ON contacts(opportunity_id, apollo_id) WHERE apollo_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS contact_drafts (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id      INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      draft_version   INTEGER NOT NULL,
      subject         TEXT NOT NULL,
      body            TEXT NOT NULL,
      reasoning_trace TEXT,
      one_line_why    TEXT,
      human_edited    INTEGER NOT NULL DEFAULT 0,
      is_active       INTEGER NOT NULL DEFAULT 1,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_drafts_contact ON contact_drafts(contact_id);
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_draft_per_contact
      ON contact_drafts(contact_id) WHERE is_active = 1;
  `);
  addColumnIfMissing(db, 'opportunities', 'hunt_status', 'TEXT');
  db.exec(`CREATE INDEX IF NOT EXISTS idx_opps_hunt_status ON opportunities(hunt_status);`);

  // v1.18.0 — qualification axes split.
  // buying_stage: 'early' | 'mid' | 'late' | NULL, classified by the
  // Stage 2 qualifier (or live-monitor qualify) at insert time. NULL on
  // legacy rows + when the classifier didn't or couldn't tag the stage.
  // status now has a fifth value 'shadow' (in addition to open / qualified
  // / disqualified / archived): sub-threshold candidates that were tagged
  // early-stage by the classifier — preserved for false-negative analysis
  // and the v1.19 Watchlist UI, but NOT surfaced on the Dashboard (which
  // explicitly queries status='open').
  addColumnIfMissing(db, 'opportunities', 'buying_stage', 'TEXT');
  db.exec(`CREATE INDEX IF NOT EXISTS idx_opps_buying_stage ON opportunities(buying_stage);`);

  // v1.17.0 — external_priors schema, populated in v1.18+ by the central
  // service. Each row is an anonymized aggregated stat from ≥k tenants
  // (k_anonymity threshold = 5). v1.17 doesn't read or write to this
  // table; it exists so v1.18 can add the federated layer without a
  // schema migration. The Bayesian blend that combines local +
  // external priors lives in shared/learning.ts and is dormant until
  // there are external rows to consume.
  db.exec(`
    CREATE TABLE IF NOT EXISTS external_priors (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      dimension         TEXT NOT NULL,
      dimension_value   TEXT NOT NULL,
      close_rate        REAL NOT NULL,
      n_tenants         INTEGER NOT NULL,
      total_n           INTEGER NOT NULL,
      received_at       TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(dimension, dimension_value)
    );
  `);
}

function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: string,
  decl: string
) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}
