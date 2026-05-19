import { getDb } from './db.js';
import { completePerplexity } from './perplexity.js';
import { getSettings } from './settings.js';
import type { Brand, Product, SignalSource, Opportunity } from '@shared/types';

const SYSTEM = `You are a senior B2B sales intelligence analyst with live web
access. You will be given a portfolio of our brands and products, plus a
topic / area of interest. You must surface RECENT (within the specified time
window) real-world events — news, incidents, announcements, leadership
changes — that represent credible B2B sales opportunities for our products.

You must be honest and skeptical. Most news is NOT an opportunity. Only flag
items where a real company's actual situation creates a credible reason to
buy one of OUR specific products.

For each genuine opportunity, return a structured record with the prospect
company, the matched brand/product, the situation, the recommended sales
angle, and a confidence score. Always include the source URL.

Respond ONLY with JSON matching the schema you've been given. No prose.`;

type PplxOpportunity = {
  company: string;
  industry: string;
  matched_brand: string | null;
  matched_product: string | null;
  source_url: string;
  source_title: string;
  source_published_at: string | null;
  headline: string;
  background: string;
  use_case: string;
  angle: string;
  signal_summary: string;
  confidence: number;
};

const OPPS_SCHEMA = {
  type: 'object',
  required: ['opportunities'],
  properties: {
    opportunities: {
      type: 'array',
      items: {
        type: 'object',
        required: [
          'company', 'industry', 'matched_brand', 'matched_product',
          'source_url', 'source_title', 'headline',
          'background', 'use_case', 'angle', 'signal_summary', 'confidence'
        ],
        properties: {
          company: { type: 'string' },
          industry: { type: 'string' },
          matched_brand: { type: ['string', 'null'] },
          matched_product: { type: ['string', 'null'] },
          source_url: { type: 'string' },
          source_title: { type: 'string' },
          source_published_at: { type: ['string', 'null'] },
          headline: { type: 'string' },
          background: { type: 'string' },
          use_case: { type: 'string' },
          angle: { type: 'string' },
          signal_summary: { type: 'string' },
          confidence: { type: 'number' }
        }
      }
    }
  }
};

export type ScanLog = (line: string) => void;

function describeSource(s: SignalSource): string {
  try {
    const cfg = JSON.parse(s.config || '{}');
    if (cfg.query) return `${s.name} — ${cfg.query}`;
    if (cfg.url) return `${s.name} — ${cfg.url}`;
    return s.name;
  } catch {
    return s.name;
  }
}

function buildPortfolio(brands: Brand[], products: Product[]): string {
  return brands
    .map((b) => {
      const ps = products.filter((p) => p.brand_id === b.id);
      return `## ${b.name}
${b.competitive_summary || b.description || ''}

Products:
${ps
  .map(
    (p) =>
      `  - "${p.name}" [${p.category || 'uncategorized'}] :: ${p.description || ''}
    Use cases: ${(p.use_cases || '').replace(/\n+/g, ' ')}
    Signals to watch: ${(p.signals || '').replace(/\n+/g, ' ')}`
  )
  .join('\n')}`;
    })
    .join('\n\n')
    .slice(0, 28_000);
}

export async function runScan(): Promise<{ runId: number; created: number; scanned: number }> {
  const db = getDb();
  const startStmt = db.prepare("INSERT INTO scan_runs(status) VALUES ('running')");
  const runId = Number(startStmt.run().lastInsertRowid);
  const logLines: string[] = [];
  const log: ScanLog = (line) => {
    logLines.push(`[${new Date().toISOString()}] ${line}`);
  };

  let created = 0;
  let scanned = 0;
  try {
    const settings = getSettings();
    if (!settings.perplexityApiKey) {
      throw new Error('Perplexity API key not configured. Open Settings and paste your key.');
    }

    const brands = db.prepare('SELECT * FROM brands').all() as Brand[];
    const products = db.prepare('SELECT * FROM products').all() as Product[];
    if (brands.length === 0 || products.length === 0) {
      throw new Error('Add at least one brand and product before scanning.');
    }
    const portfolio = buildPortfolio(brands, products);

    const sources = db
      .prepare('SELECT * FROM signal_sources WHERE enabled = 1')
      .all() as SignalSource[];
    if (sources.length === 0) {
      throw new Error('No enabled signal sources. Add at least one in Signal Config.');
    }

    const seenStmt = db.prepare('SELECT 1 FROM seen_urls WHERE url = ?');
    const insertSeen = db.prepare('INSERT OR IGNORE INTO seen_urls(url) VALUES (?)');
    const insertOpp = db.prepare(`
      INSERT INTO opportunities(
        brand_id, product_id, company, industry, headline, source_url, source_title,
        source_published_at, confidence, status, background, use_case, angle,
        signal_summary, raw_signal
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)
    `);

    for (const src of sources) {
      log(`Source: ${describeSource(src)}`);
      const cfg = (() => { try { return JSON.parse(src.config || '{}'); } catch { return {}; } })();
      const topic = cfg.query || cfg.url || src.name;

      const prompt = `# Our portfolio
${portfolio}

# Topic to investigate
${topic}

# Time window
Only consider events from the last ${settings.scanRecency} (no older).

# Task
Search the web for RECENT real-world events that match the topic AND
represent a credible B2B sales opportunity for one of OUR specific products.
Be specific — only flag named companies in concrete situations with a real
fit to our portfolio. Skip generic industry trend pieces.

Limit to at most ${Math.max(1, Math.min(15, settings.maxItemsPerScan))} of
the highest-quality opportunities. Use only the brand/product names that
appear in our portfolio (exact match, case-insensitive). Apply confidence
0..1; be honest — most cells should be 0.4–0.7 unless the fit is obvious.`;

      let json: { opportunities: PplxOpportunity[] } | null = null;
      try {
        const r = await completePerplexity<{ opportunities: PplxOpportunity[] }>(
          SYSTEM,
          prompt,
          {
            model: settings.perplexityScanModel || 'sonar-pro',
            maxTokens: 4500,
            temperature: 0.2,
            searchRecency: settings.scanRecency,
            jsonSchema: OPPS_SCHEMA
          }
        );
        json = r.json;
        if (!json) {
          log(`  ! unparseable response, ${r.text.length} chars of text`);
          continue;
        }
        log(`  → ${json.opportunities?.length ?? 0} candidate(s) returned`);
      } catch (e: any) {
        log(`  ! Perplexity error: ${e.message || e}`);
        continue;
      }

      for (const cand of json.opportunities || []) {
        scanned++;
        const url = (cand.source_url || '').trim();
        if (!url) { log('  - skip: no source_url'); continue; }
        if (seenStmt.get(url)) { log(`  - skip (seen): ${cand.company}`); continue; }
        if ((cand.confidence ?? 0) < settings.minConfidence) {
          log(`  - skip (low conf ${(cand.confidence ?? 0).toFixed(2)}): ${cand.company}`);
          continue;
        }
        insertSeen.run(url);

        const matchedBrand = brands.find(
          (b) => b.name.toLowerCase() === (cand.matched_brand || '').toLowerCase()
        );
        const matchedProduct = products.find(
          (p) =>
            p.name.toLowerCase() === (cand.matched_product || '').toLowerCase() &&
            (!matchedBrand || p.brand_id === matchedBrand.id)
        );

        insertOpp.run(
          matchedBrand?.id ?? null,
          matchedProduct?.id ?? null,
          cand.company,
          cand.industry,
          cand.headline,
          url,
          cand.source_title || src.name,
          cand.source_published_at || null,
          cand.confidence,
          cand.background,
          cand.use_case,
          cand.angle,
          cand.signal_summary,
          JSON.stringify({ source: src.name, topic })
        );
        created++;
        log(`  ✓ ${cand.company} (${(cand.confidence ?? 0).toFixed(2)}) → ${matchedBrand?.name || '?'} / ${matchedProduct?.name || '?'}`);
      }
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

  db.prepare(
    `UPDATE scan_jobs SET last_run_at = datetime('now'), last_status = 'completed', last_results = ?`
  ).run(created);
  return { runId, created, scanned };
}
