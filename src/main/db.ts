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

    CREATE INDEX IF NOT EXISTS idx_opps_status ON opportunities(status);
    CREATE INDEX IF NOT EXISTS idx_products_brand ON products(brand_id);
    CREATE INDEX IF NOT EXISTS idx_knowledge_brand ON knowledge_items(brand_id);
  `);
}
