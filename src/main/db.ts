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
