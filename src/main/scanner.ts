import { getDb } from './db.js';
import { completePerplexity } from './perplexity.js';
import { getSettings } from './settings.js';
import type { Brand, Product, SignalSource } from '@shared/types';

const SYSTEM = `You are a senior B2B sales-intelligence analyst with live web
access. You will be given ONE specific product from our portfolio and the
buying signals that indicate when a customer is likely to need it. Your job
is to search the live web for RECENT real-world events that match those
signals and represent credible B2B sales opportunities for THIS product.

You must be honest and skeptical. Most news is NOT an opportunity. Only
surface items where a real named company is in a concrete situation that
genuinely fits one of the signals AND fits this product.

Always include a working source URL for each opportunity. Apply confidence
0..1 — be honest, most should be 0.4–0.7 unless the fit is obvious.

Respond ONLY with JSON matching the schema you've been given. No prose.`;

type PplxOpportunity = {
  company: string;
  industry: string;
  source_url: string;
  source_title: string;
  source_published_at: string | null;
  headline: string;
  background: string;
  use_case: string;
  angle: string;
  signal_summary: string;
  matched_signal: string;
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
          'company', 'industry', 'source_url', 'source_title', 'headline',
          'background', 'use_case', 'angle', 'signal_summary',
          'matched_signal', 'confidence'
        ],
        properties: {
          company: { type: 'string' },
          industry: { type: 'string' },
          source_url: { type: 'string' },
          source_title: { type: 'string' },
          source_published_at: { type: ['string', 'null'] },
          headline: { type: 'string' },
          background: { type: 'string' },
          use_case: { type: 'string' },
          angle: { type: 'string' },
          signal_summary: { type: 'string' },
          matched_signal: { type: 'string', description: 'Which of the product\'s signals this opportunity matches' },
          confidence: { type: 'number' }
        }
      }
    }
  }
};

export type ScanLog = (line: string) => void;

function scanQuotaPerProduct(): number {
  const { maxItemsPerScan } = getSettings();
  // Spread the budget across products. Floor at 3, cap at 10 per product.
  return Math.max(3, Math.min(10, Math.ceil(maxItemsPerScan / 3)));
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
    const allProducts = db.prepare('SELECT * FROM products').all() as Product[];
    const scanProducts = allProducts.filter(
      (p) => p.research_status === 'ready' && p.scan_enabled === 1 && p.signals && p.signals.trim().length > 0
    );

    if (scanProducts.length === 0) {
      throw new Error(
        'No products are ready to scan. Run research on at least one product and make sure it has scanning enabled.'
      );
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

    const perProduct = scanQuotaPerProduct();

    // ─────────────────────────────────────────────────────────────
    // Pass 1 — auto signals from each researched product
    // ─────────────────────────────────────────────────────────────
    for (const product of scanProducts) {
      const brand = brands.find((b) => b.id === product.brand_id);
      if (!brand) continue;
      log(`Product scan: ${brand.name} / ${product.name}`);

      const prompt = `# Product to find opportunities for
Brand: ${brand.name}
Product: "${product.name}"
Category: ${product.category || '(unspecified)'}
Description: ${product.description || ''}

Use cases (when this product is a great fit):
${product.use_cases || ''}

Differentiators vs competitors:
${product.differentiators || ''}

# Buying signals to search for
${product.signals}

# Time window
Only consider events from the last ${settings.scanRecency}.

# Task
Search the live web. For each genuine sales opportunity you find that
matches one of the signals above, return a record. Limit to the
${perProduct} strongest opportunities. Set "matched_signal" to the
specific signal (from the list above) that this opportunity matches.`;

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
          log(`  ! unparseable response (${r.text.length} chars)`);
          continue;
        }
        log(`  → ${json.opportunities?.length ?? 0} candidate(s) returned`);
      } catch (e: any) {
        log(`  ! Perplexity error: ${e.message || e}`);
        continue;
      }

      created += insertCandidates(
        json.opportunities || [],
        { brand, product, sourceLabel: `auto:${product.name}` },
        { settings, seenStmt, insertSeen, insertOpp, log }
      );
      scanned += json.opportunities?.length ?? 0;
    }

    // ─────────────────────────────────────────────────────────────
    // Pass 2 — manual custom topics (optional, for power users)
    // ─────────────────────────────────────────────────────────────
    const customSources = db
      .prepare('SELECT * FROM signal_sources WHERE enabled = 1')
      .all() as SignalSource[];

    if (customSources.length > 0) {
      const portfolio = buildPortfolio(brands, allProducts);
      for (const src of customSources) {
        log(`Custom topic: ${src.name}`);
        const cfg = (() => { try { return JSON.parse(src.config || '{}'); } catch { return {}; } })();
        const topic = cfg.query || cfg.url || src.name;

        const prompt = `# Our portfolio
${portfolio}

# Topic of interest
${topic}

# Time window
Only consider events from the last ${settings.scanRecency}.

# Task
Search the live web for RECENT events matching this topic that represent a
genuine B2B sales opportunity for one of OUR specific products. Be specific.
Return up to ${perProduct} of the strongest opportunities. Use only
brand/product names that appear in our portfolio.`;

        // For custom topics we don't know which product upfront, so let
        // the model pick — we re-use the OPPS_SCHEMA but resolve the
        // product in our parser.
        try {
          const r = await completePerplexity<{ opportunities: (PplxOpportunity & {
            matched_brand?: string | null; matched_product?: string | null;
          })[] }>(SYSTEM, prompt, {
            model: settings.perplexityScanModel || 'sonar-pro',
            maxTokens: 4500,
            temperature: 0.2,
            searchRecency: settings.scanRecency,
            jsonSchema: OPPS_SCHEMA_CUSTOM
          });
          const opps = r.json?.opportunities || [];
          log(`  → ${opps.length} candidate(s) returned`);
          scanned += opps.length;
          for (const cand of opps) {
            const matchedBrand =
              brands.find((b) => b.name.toLowerCase() === (cand.matched_brand || '').toLowerCase()) || null;
            const matchedProduct =
              allProducts.find(
                (p) =>
                  p.name.toLowerCase() === (cand.matched_product || '').toLowerCase() &&
                  (!matchedBrand || p.brand_id === matchedBrand.id)
              ) || null;
            created += insertCandidates(
              [cand],
              {
                brand: matchedBrand,
                product: matchedProduct,
                sourceLabel: `custom:${src.name}`
              },
              { settings, seenStmt, insertSeen, insertOpp, log }
            );
          }
        } catch (e: any) {
          log(`  ! Perplexity error: ${e.message || e}`);
        }
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

const OPPS_SCHEMA_CUSTOM = {
  type: 'object',
  required: ['opportunities'],
  properties: {
    opportunities: {
      type: 'array',
      items: {
        type: 'object',
        required: [
          'company', 'industry', 'source_url', 'source_title', 'headline',
          'background', 'use_case', 'angle', 'signal_summary',
          'matched_signal', 'confidence',
          'matched_brand', 'matched_product'
        ],
        properties: {
          company: { type: 'string' },
          industry: { type: 'string' },
          source_url: { type: 'string' },
          source_title: { type: 'string' },
          source_published_at: { type: ['string', 'null'] },
          headline: { type: 'string' },
          background: { type: 'string' },
          use_case: { type: 'string' },
          angle: { type: 'string' },
          signal_summary: { type: 'string' },
          matched_signal: { type: 'string' },
          matched_brand: { type: ['string', 'null'] },
          matched_product: { type: ['string', 'null'] },
          confidence: { type: 'number' }
        }
      }
    }
  }
};

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
      `  - "${p.name}" [${p.category || 'uncategorized'}] :: ${p.description || ''}`
  )
  .join('\n')}`;
    })
    .join('\n\n')
    .slice(0, 20_000);
}

type InsertCtx = {
  settings: ReturnType<typeof getSettings>;
  seenStmt: any;
  insertSeen: any;
  insertOpp: any;
  log: ScanLog;
};

function insertCandidates(
  candidates: PplxOpportunity[],
  attrib: { brand: Brand | null; product: Product | null; sourceLabel: string },
  ctx: InsertCtx
): number {
  let inserted = 0;
  for (const cand of candidates) {
    const url = (cand.source_url || '').trim();
    if (!url) { ctx.log('  - skip: no source_url'); continue; }
    if (ctx.seenStmt.get(url)) { ctx.log(`  - skip (seen): ${cand.company}`); continue; }
    if ((cand.confidence ?? 0) < ctx.settings.minConfidence) {
      ctx.log(`  - skip (low conf ${(cand.confidence ?? 0).toFixed(2)}): ${cand.company}`);
      continue;
    }
    ctx.insertSeen.run(url);
    ctx.insertOpp.run(
      attrib.brand?.id ?? null,
      attrib.product?.id ?? null,
      cand.company,
      cand.industry,
      cand.headline,
      url,
      cand.source_title || attrib.sourceLabel,
      cand.source_published_at || null,
      cand.confidence,
      cand.background,
      cand.use_case,
      cand.angle,
      cand.signal_summary,
      JSON.stringify({ source: attrib.sourceLabel, matched_signal: cand.matched_signal })
    );
    inserted++;
    ctx.log(
      `  ✓ ${cand.company} (${(cand.confidence ?? 0).toFixed(2)}) → ${attrib.brand?.name || '?'} / ${attrib.product?.name || '?'}`
    );
  }
  return inserted;
}
