import Parser from 'rss-parser';
import { getDb } from './db.js';
import { complete, completeJson } from './llm.js';
import { fetchUrl } from './knowledge.js';
import { getSettings } from './settings.js';
import type { Brand, Product, SignalSource, Opportunity } from '@shared/types';

const parser = new Parser({
  timeout: 20_000,
  headers: { 'user-agent': 'LeadsHawk/1.0 (+local app)' }
});

const SYSTEM_QUALIFY = `You are a senior B2B sales strategist for a vendor.
You read a news item and decide if it represents a real buying opportunity for
one of OUR products. Be skeptical: most news is NOT an opportunity. Only flag
items where the company's situation creates a credible reason to buy.

You must return strictly valid JSON.`;

type QualifyResult = {
  is_opportunity: boolean;
  confidence: number;
  company: string;
  industry: string;
  matched_brand: string | null;
  matched_product: string | null;
  background: string;
  use_case: string;
  angle: string;
  signal_summary: string;
};

export type ScanLog = (line: string) => void;

export async function fetchSignals(log: ScanLog): Promise<RawSignal[]> {
  const db = getDb();
  const sources = db
    .prepare("SELECT * FROM signal_sources WHERE enabled = 1")
    .all() as SignalSource[];

  const seenStmt = db.prepare('SELECT 1 FROM seen_urls WHERE url = ?');
  const insertSeen = db.prepare(
    "INSERT OR IGNORE INTO seen_urls(url) VALUES (?)"
  );

  const all: RawSignal[] = [];
  for (const src of sources) {
    try {
      log(`Fetching: ${src.name} (${src.kind})`);
      const feedUrl = resolveFeedUrl(src);
      const feed = await parser.parseURL(feedUrl);
      for (const item of feed.items.slice(0, 25)) {
        const url = (item.link || '').split('&ved=')[0];
        if (!url) continue;
        if (seenStmt.get(url)) continue;
        insertSeen.run(url);
        all.push({
          title: item.title || '(untitled)',
          url,
          published: item.isoDate || item.pubDate || null,
          source: src.name,
          snippet: (item.contentSnippet || item.content || '').slice(0, 1000)
        });
      }
    } catch (e: any) {
      log(`  ! Source error (${src.name}): ${e.message || e}`);
    }
  }
  return all;
}

export type RawSignal = {
  title: string;
  url: string;
  published: string | null;
  source: string;
  snippet: string;
};

function resolveFeedUrl(src: SignalSource): string {
  const cfg = JSON.parse(src.config || '{}');
  if (src.kind === 'rss') return cfg.url;
  if (src.kind === 'google_news' || src.kind === 'query') {
    const q = encodeURIComponent(cfg.query || src.name);
    return `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
  }
  return cfg.url;
}

export async function qualifyAndStore(signal: RawSignal, log: ScanLog): Promise<Opportunity | null> {
  const db = getDb();
  const brands = db.prepare('SELECT * FROM brands').all() as Brand[];
  const products = db.prepare('SELECT * FROM products').all() as Product[];
  if (brands.length === 0 || products.length === 0) {
    log('  - skipping qualify: no brands/products defined');
    return null;
  }

  // Hydrate signal body
  let body = signal.snippet;
  try {
    const fetched = await fetchUrl(signal.url);
    body = fetched.content.slice(0, 8000);
  } catch {
    // keep snippet
  }

  const portfolio = brands
    .map((b) => {
      const ps = products.filter((p) => p.brand_id === b.id);
      return `## ${b.name}
${b.competitive_summary || b.description || ''}
Products:
${ps
  .map(
    (p) =>
      `  - ${p.name} [${p.category || ''}] :: ${
        p.description || ''
      }\n    Use cases: ${(p.use_cases || '').replace(/\n/g, ' ')}\n    Signals to watch: ${(
        p.signals || ''
      ).replace(/\n/g, ' ')}`
  )
  .join('\n')}`;
    })
    .join('\n\n')
    .slice(0, 30_000);

  const settings = getSettings();
  const prompt = `# Our portfolio
${portfolio}

# News signal
Title: ${signal.title}
URL: ${signal.url}
Published: ${signal.published || 'unknown'}
Body:
${body}

# Task
Decide if this signal is a real B2B sales opportunity for one of OUR products.
Be honest: if it doesn't fit, return is_opportunity=false.

Return JSON shape:
{
  "is_opportunity": boolean,
  "confidence": 0..1,
  "company": "the company that would be the prospect",
  "industry": "their industry",
  "matched_brand": "EXACT brand name from our portfolio, or null",
  "matched_product": "EXACT product name from our portfolio, or null",
  "background": "2-3 sentence description of what's happening at the prospect",
  "use_case": "1-paragraph: WHY our matched product fits this situation",
  "angle": "1-paragraph: the specific sales angle / talking points to lead with",
  "signal_summary": "one tight sentence summarising the opportunity"
}

If is_opportunity is false, you may leave matched_* null and other fields short.`;

  let result: QualifyResult;
  try {
    result = await completeJson<QualifyResult>(SYSTEM_QUALIFY, prompt, {
      maxTokens: 1800
    });
  } catch (e: any) {
    log(`  ! qualify error: ${e.message || e}`);
    return null;
  }

  if (!result.is_opportunity) return null;
  if ((result.confidence ?? 0) < settings.minConfidence) {
    log(`  - skipping low confidence (${result.confidence.toFixed(2)}): ${signal.title}`);
    return null;
  }

  const matchedBrand = brands.find(
    (b) => b.name.toLowerCase() === (result.matched_brand || '').toLowerCase()
  );
  const matchedProduct = products.find(
    (p) =>
      p.name.toLowerCase() === (result.matched_product || '').toLowerCase() &&
      (!matchedBrand || p.brand_id === matchedBrand.id)
  );

  const insert = db.prepare(`
    INSERT INTO opportunities(
      brand_id, product_id, company, industry, headline, source_url, source_title,
      source_published_at, confidence, status, background, use_case, angle,
      signal_summary, raw_signal
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)
  `);
  const info = insert.run(
    matchedBrand?.id ?? null,
    matchedProduct?.id ?? null,
    result.company,
    result.industry,
    signal.title,
    signal.url,
    signal.source,
    signal.published,
    result.confidence,
    result.background,
    result.use_case,
    result.angle,
    result.signal_summary,
    JSON.stringify({ snippet: signal.snippet, body: body.slice(0, 4000) })
  );
  log(`  ✓ opportunity created: ${result.company} (${result.confidence.toFixed(2)})`);
  return db.prepare('SELECT * FROM opportunities WHERE id = ?').get(info.lastInsertRowid) as Opportunity;
}

export async function runScan(): Promise<{ runId: number; created: number; scanned: number }> {
  const db = getDb();
  const startStmt = db.prepare(
    "INSERT INTO scan_runs(status) VALUES ('running')"
  );
  const runId = Number(startStmt.run().lastInsertRowid);
  const logLines: string[] = [];
  const log: ScanLog = (line) => {
    logLines.push(`[${new Date().toISOString()}] ${line}`);
  };
  let created = 0;
  let scanned = 0;
  try {
    const signals = await fetchSignals(log);
    log(`Fetched ${signals.length} new signals`);
    const settings = getSettings();
    for (const sig of signals.slice(0, settings.maxItemsPerScan)) {
      scanned++;
      log(`Qualifying: ${sig.title}`);
      const opp = await qualifyAndStore(sig, log);
      if (opp) created++;
    }
    db.prepare(
      `UPDATE scan_runs SET finished_at = datetime('now'), status = 'completed',
       items_scanned = ?, opportunities_created = ?, log = ? WHERE id = ?`
    ).run(scanned, created, logLines.join('\n'), runId);
  } catch (e: any) {
    log(`FATAL: ${e.message || e}`);
    db.prepare(
      `UPDATE scan_runs SET finished_at = datetime('now'), status = 'error',
       items_scanned = ?, opportunities_created = ?, log = ? WHERE id = ?`
    ).run(scanned, created, logLines.join('\n'), runId);
    throw e;
  }
  // Bookkeeping on the (singleton) scan_jobs row
  db.prepare(
    `UPDATE scan_jobs SET last_run_at = datetime('now'), last_status = 'completed', last_results = ?`
  ).run(created);
  return { runId, created, scanned };
}
