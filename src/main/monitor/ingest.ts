import Parser from 'rss-parser';
import { getDb } from '../db.js';
import type { MonitorSource } from '@shared/types';

const parser = new Parser({
  timeout: 20_000,
  headers: { 'user-agent': 'LeadsHawk/1.1 (+local app)' }
});

const MAX_BACKOFF_MULT = 8; // backoff up to 8× the base interval

export type IngestLog = (line: string) => void;

function resolveFeedUrl(src: MonitorSource): string {
  if (src.kind === 'google_news') {
    const cfg = (() => { try { return JSON.parse(src.config || '{}'); } catch { return {}; } })();
    const q = encodeURIComponent(cfg.query || src.name);
    return `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
  }
  return src.url;
}

/**
 * Should this source be polled now?
 */
export function dueForPoll(src: MonitorSource, now = new Date()): boolean {
  if (!src.enabled) return false;
  if (!src.last_polled_at) return true;
  const last = new Date(src.last_polled_at + 'Z').getTime();
  const backoffMult = Math.min(MAX_BACKOFF_MULT, 1 + src.consecutive_empty_polls);
  const interval = src.poll_interval_seconds * 1000 * backoffMult;
  return now.getTime() - last >= interval;
}

export async function pollSource(src: MonitorSource, log: IngestLog): Promise<number> {
  const db = getDb();
  const feedUrl = resolveFeedUrl(src);
  const headers: Record<string, string> = { 'user-agent': 'LeadsHawk/1.1 (+local app)' };
  if (src.last_etag) headers['if-none-match'] = src.last_etag;
  if (src.last_modified) headers['if-modified-since'] = src.last_modified;

  let inserted = 0;
  try {
    // Manual fetch to honor ETag / Last-Modified, then hand the text to rss-parser
    const resp = await fetch(feedUrl, { headers });
    if (resp.status === 304) {
      log(`  ${src.name}: 304 not modified`);
      db.prepare(
        "UPDATE monitor_sources SET last_polled_at = datetime('now'), last_status = '304', last_error = NULL, consecutive_empty_polls = consecutive_empty_polls + 1 WHERE id = ?"
      ).run(src.id);
      return 0;
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const etag = resp.headers.get('etag');
    const lastModified = resp.headers.get('last-modified');
    const xml = await resp.text();
    const feed = await parser.parseString(xml);

    const insertItem = db.prepare(`
      INSERT OR IGNORE INTO signal_items(source_id, url, title, snippet, published_at, status)
      VALUES (?, ?, ?, ?, ?, 'new')
    `);

    for (const item of feed.items.slice(0, 50)) {
      const url = (item.link || '').split('&ved=')[0].trim();
      if (!url) continue;
      const title = (item.title || '(untitled)').slice(0, 500);
      const snippet = (item.contentSnippet || item.content || '').slice(0, 2000);
      const published = item.isoDate || item.pubDate || null;
      const res = insertItem.run(src.id, url, title, snippet, published);
      if (res.changes > 0) inserted++;
    }

    db.prepare(
      `UPDATE monitor_sources SET
         last_polled_at = datetime('now'),
         last_etag = ?,
         last_modified = ?,
         last_status = 'ok',
         last_error = NULL,
         consecutive_empty_polls = ?
       WHERE id = ?`
    ).run(
      etag,
      lastModified,
      inserted > 0 ? 0 : src.consecutive_empty_polls + 1,
      src.id
    );
    log(`  ${src.name}: +${inserted} new`);
    return inserted;
  } catch (e: any) {
    db.prepare(
      `UPDATE monitor_sources SET
         last_polled_at = datetime('now'),
         last_status = 'error',
         last_error = ?,
         consecutive_empty_polls = consecutive_empty_polls + 1
       WHERE id = ?`
    ).run(String(e?.message || e).slice(0, 500), src.id);
    log(`  ${src.name}: error ${e?.message || e}`);
    return 0;
  }
}

export async function pollAllDue(log: IngestLog): Promise<number> {
  const db = getDb();
  const sources = db
    .prepare('SELECT * FROM monitor_sources WHERE enabled = 1')
    .all() as MonitorSource[];
  const due = sources.filter((s) => dueForPoll(s));
  let total = 0;
  for (const s of due) {
    total += await pollSource(s, log);
  }
  return total;
}

/**
 * Seed default monitor sources on first enable. Idempotent.
 */
export function seedDefaultMonitorSources(): number {
  const db = getDb();
  const count = (db.prepare('SELECT COUNT(*) AS c FROM monitor_sources').get() as any).c as number;
  if (count > 0) return 0;
  const insert = db.prepare(
    "INSERT INTO monitor_sources(name, kind, url, config, enabled, poll_interval_seconds) VALUES (?, ?, ?, ?, 1, ?)"
  );
  const defaults: Array<[string, 'rss' | 'google_news', string, string | null, number]> = [
    ['TechCrunch — Enterprise', 'rss', 'https://techcrunch.com/category/enterprise/feed/', null, 900],
    ['Reuters — Technology', 'rss', 'https://feeds.reuters.com/reuters/technologyNews', null, 900],
    ['The Register — Networking', 'rss', 'https://www.theregister.com/data_centre/networks/headlines.atom', null, 1800],
    ['Dark Reading', 'rss', 'https://www.darkreading.com/rss.xml', null, 1800],
    ['Google News — IT outages', 'google_news', '', JSON.stringify({ query: 'enterprise IT outage OR datacenter failure OR cloud outage' }), 1200],
    ['Google News — CIO/CISO appointments', 'google_news', '', JSON.stringify({ query: '"new CIO" OR "new CISO" OR appointed CIO OR appointed CISO' }), 3600],
    ['Google News — vulnerabilities', 'google_news', '', JSON.stringify({ query: 'critical vulnerability OR zero-day disclosed OR CVE patched' }), 1800],
    ['SEC EDGAR — 8-K filings', 'rss', 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&type=8-K&dateb=&owner=include&count=40&action=getcompany&output=atom', null, 1800]
  ];
  let n = 0;
  for (const d of defaults) {
    insert.run(d[0], d[1], d[2], d[3], d[4]);
    n++;
  }
  return n;
}
