import { getDb } from './db.js';
import { completePerplexity } from './perplexity.js';
import { getSettings } from './settings.js';
import { buildDisqualificationsBlock } from './learning.js';
import { isOwnBrandCompany, buildOwnBrandsBlock } from './lead-hygiene.js';
import { pickBestSourceUrl, dedupeCleanCitations } from './url-hygiene.js';
import { retrieveRelevantChunks, renderChunksBlock } from './knowledge-index.js';
import type { LlmStage } from './pricing.js';
import type { Brand, Product, SignalSource, ScanRule } from '@shared/types';

/**
 * Runtime knobs for a scan run. Defaults reproduce the legacy "manual" run
 * (sonar-pro, manual_scan stage tag). The twice-daily deep scan overrides
 * with sonar-deep-research + 'deep_scan' stage + kind='deep'.
 */
export type ScanOpts = {
  model?: string;
  stage?: LlmStage;
  kind?: 'manual' | 'deep';
  maxTokens?: number;
  /** Prefix line written to the scan_runs log so it's clear which engine ran. */
  label?: string;
};

/**
 * Build the user-defined-rules guardrail block. If productId is provided,
 * BOTH global rules and that product's rules are included. If productId is
 * null, only global rules are included.
 */
function buildGuardrails(productId: number | null): string {
  const db = getDb();
  const productRules = productId
    ? (db.prepare(
        "SELECT * FROM scan_rules WHERE scope = 'product' AND product_id = ? AND enabled = 1 ORDER BY kind, id"
      ).all(productId) as ScanRule[])
    : [];
  const globalRules = db
    .prepare("SELECT * FROM scan_rules WHERE scope = 'global' AND enabled = 1 ORDER BY kind, id")
    .all() as ScanRule[];
  const rules = [...globalRules, ...productRules];
  if (rules.length === 0) return '';
  const includes = rules.filter((r) => r.kind === 'include');
  const excludes = rules.filter((r) => r.kind === 'exclude');
  const parts: string[] = [];
  parts.push('# User-defined scan rules (HARD CONSTRAINTS — apply to every candidate)');
  if (includes.length) {
    parts.push('\nOnly surface opportunities that satisfy ALL of these include rules:');
    parts.push(includes.map((r) => `- ${r.text}`).join('\n'));
  }
  if (excludes.length) {
    parts.push('\nDrop any opportunity that matches ANY of these exclude rules:');
    parts.push(excludes.map((r) => `- ${r.text}`).join('\n'));
  }
  parts.push(
    "\nIf a candidate violates an include rule, or matches an exclude rule, do not return it at all. These rules outrank everything else — if no candidates pass the rules, return an empty 'opportunities' array."
  );
  return parts.join('\n');
}

const SYSTEM = `You are a senior B2B sales-intelligence analyst with live web
access. You will be given foundational context about who we are (a brand and
one of its products) — its positioning, ideal customer profile, competitive
landscape, and excerpts of our own internal knowledge.

Your job: USE that context to do deep web research and identify recent
real-world events that represent credible B2B sales opportunities for this
product. Buying signals are provided as guidance — opportunities matching
them are obvious wins, but you are not limited to them. Surface anything
that fits our context and represents a genuine buying moment.

You must be honest and skeptical. Most news is NOT an opportunity. Only
surface items where a real named company is in a concrete situation that
genuinely fits our positioning + ICP + this product.

Always include a working source URL for each opportunity. Apply confidence
0..1 — be honest, most should be 0.4–0.7 unless the fit is obvious.

Respond ONLY with JSON matching the schema you've been given. No prose.`;

type PplxOpportunity = {
  company: string;
  industry: string;
  country: string | null;
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
          'company', 'industry', 'country', 'source_url', 'source_title', 'headline',
          'background', 'use_case', 'angle', 'signal_summary',
          'matched_signal', 'confidence'
        ],
        properties: {
          company: { type: 'string' },
          industry: { type: 'string' },
          country: { type: ['string', 'null'], description: 'Country where the company is headquartered or where the event takes place. Use the common English name (e.g. "United States", "Singapore", "United Kingdom"). Null if genuinely unknown.' },
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

export async function runScan(
  opts: ScanOpts = {}
): Promise<{ runId: number; created: number; scanned: number }> {
  const db = getDb();
  const kind = opts.kind ?? 'manual';
  const stage: LlmStage = opts.stage ?? 'manual_scan';
  const maxTokens = opts.maxTokens ?? 4500;
  const startStmt = db.prepare("INSERT INTO scan_runs(status, kind) VALUES ('running', ?)");
  const runId = Number(startStmt.run(kind).lastInsertRowid);
  const logLines: string[] = [];
  const log: ScanLog = (line) => {
    logLines.push(`[${new Date().toISOString()}] ${line}`);
  };
  if (opts.label) log(opts.label);

  let created = 0;
  let scanned = 0;
  try {
    const settings = getSettings();
    if (!settings.perplexityApiKey) {
      throw new Error('Perplexity API key not configured. Open Settings and paste your key.');
    }
    const scanModel = opts.model ?? settings.perplexityScanModel ?? 'sonar-pro';
    log(`engine: model=${scanModel} stage=${stage} kind=${kind}`);

    const brands = db.prepare('SELECT * FROM brands').all() as Brand[];
    const allProducts = db.prepare('SELECT * FROM products').all() as Product[];
    const enabledBrandIds = new Set(
      brands.filter((b) => b.scan_enabled === 1).map((b) => b.id)
    );
    const scanProducts = allProducts.filter(
      (p) =>
        p.research_status === 'ready' &&
        p.scan_enabled === 1 &&
        enabledBrandIds.has(p.brand_id) &&
        p.signals &&
        p.signals.trim().length > 0
    );

    if (scanProducts.length === 0) {
      throw new Error(
        'No products are ready to scan. Run research on at least one product, and make sure both the product and its brand are included in scans (Brands & Products tab).'
      );
    }

    const seenStmt = db.prepare('SELECT 1 FROM seen_urls WHERE url = ?');
    const insertSeen = db.prepare('INSERT OR IGNORE INTO seen_urls(url) VALUES (?)');
    const insertOpp = db.prepare(`
      INSERT INTO opportunities(
        brand_id, product_id, company, industry, country, headline, source_url, source_title,
        source_published_at, confidence, status, background, use_case, angle,
        signal_summary, raw_signal
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)
    `);

    const perProduct = scanQuotaPerProduct();

    // ─────────────────────────────────────────────────────────────
    // Pass 1 — auto signals from each researched product
    // ─────────────────────────────────────────────────────────────
    for (const product of scanProducts) {
      const brand = brands.find((b) => b.id === product.brand_id);
      if (!brand) continue;
      log(`Product scan: ${brand.name} / ${product.name}`);

      const guardrails = buildGuardrails(product.id);
      if (guardrails) {
        const ruleCount = guardrails.split('\n').filter((l) => l.startsWith('- ')).length;
        log(`  applying ${ruleCount} include/exclude rule(s) for this product`);
      }
      const disqBlock = buildDisqualificationsBlock(product.id, 8);
      if (disqBlock) log(`  injecting recent disqualifications`);
      const ownBrandsBlock = buildOwnBrandsBlock(brands);

      // v1.6: knowledge-anchored prompt. Retrieve top-K knowledge chunks
      // relevant to this product so the LLM grounds on our internal
      // material, not just on derived signal bullets.
      const retrievalQuery = [
        brand.name,
        brand.target_icp || '',
        product.name,
        product.description || '',
        product.signals || ''
      ].filter((s) => s).join('\n');
      const chunks = await retrieveRelevantChunks(retrievalQuery, brand.id, product.id, 5);
      if (chunks.length > 0) {
        log(`  retrieved ${chunks.length} knowledge chunk(s) (best sim ${chunks[0].similarity.toFixed(2)})`);
      }
      const chunksBlock = renderChunksBlock(chunks);

      const prompt = `# Brand
Name: ${brand.name}
Category: ${brand.category || '(unspecified)'}
Description: ${brand.description || '(none on file)'}
Positioning: ${brand.positioning || '(none on file)'}
Target ICP (ideal customer profile): ${brand.target_icp || '(not researched yet — fall back to general knowledge of this brand)'}
Competitive summary: ${brand.competitive_summary || '(none on file)'}
${brand.signals ? `\nBrand-level signals (apply across the whole brand, in addition to product signals):\n${brand.signals}` : ''}
${brand.research_summary ? `\nBrand research summary:\n${brand.research_summary.slice(0, 1200)}${brand.research_summary.length > 1200 ? '…' : ''}` : ''}

# Product to find opportunities for
Product: "${product.name}"
Category: ${product.category || '(unspecified)'}
Description: ${product.description || ''}

Use cases (when this product is a great fit):
${product.use_cases || ''}

Differentiators vs competitors:
${product.differentiators || ''}

Competitors:
${product.competitors || ''}
${product.research_summary ? `\nProduct research summary:\n${product.research_summary.slice(0, 1500)}${product.research_summary.length > 1500 ? '…' : ''}` : ''}

# Product-level buying signals (guidance, not constraint)
${product.signals || '(none derived yet)'}

${chunksBlock}

# Time window
Only consider events from the last ${settings.scanRecency}.

${ownBrandsBlock}

${guardrails}

${disqBlock}

# Task
Using ALL of the context above (brand positioning + ICP + product details +
retrieved knowledge), search the live web for recent events that represent
quality B2B sales opportunities for this brand+product. The signals are
GUIDANCE — anchor on them when they fit, but don't be limited to them. Use
your full understanding of who we are and who we sell to.

For each opportunity, return a record. Limit to the ${perProduct} strongest.
Set "matched_signal" to whichever signal best describes the fit (or invent a
short descriptor if it's a knowledge-grounded match outside the listed signals).`;

      let json: { opportunities: PplxOpportunity[] } | null = null;
      let citations: string[] = [];
      try {
        const r = await completePerplexity<{ opportunities: PplxOpportunity[] }>(
          SYSTEM,
          prompt,
          {
            model: scanModel,
            maxTokens,
            temperature: 0.2,
            searchRecency: settings.scanRecency,
            jsonSchema: OPPS_SCHEMA,
            stage,
            relatedId: product.id
          }
        );
        json = r.json;
        citations = r.citations || [];
        if (!json) {
          log(`  ! unparseable response (${r.text.length} chars)`);
          continue;
        }
        log(`  → ${json.opportunities?.length ?? 0} candidate(s) returned, ${citations.length} citation(s)`);
      } catch (e: any) {
        log(`  ! Perplexity error: ${e.message || e}`);
        continue;
      }

      created += insertCandidates(
        json.opportunities || [],
        { brand, product, sourceLabel: `auto:${product.name}`, brands, citations },
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
      // Only show the LLM brands + products that are currently scan-enabled.
      // This is what makes custom topics honour the per-brand / per-product
      // scan toggles. Disabled brands shouldn't be mentioned at all in the
      // prompt, otherwise the model happily produces leads for them.
      const enabledBrands = brands.filter((b) => b.scan_enabled === 1);
      const enabledProducts = allProducts.filter(
        (p) => p.scan_enabled === 1 && enabledBrandIds.has(p.brand_id)
      );
      if (enabledBrands.length === 0) {
        log('Pass 2 (custom topics): skipped — no scan-enabled brands.');
      }
      const portfolio = buildPortfolio(enabledBrands, enabledProducts);
      for (const src of (enabledBrands.length === 0 ? [] : customSources)) {
        log(`Custom topic: ${src.name}`);
        const cfg = (() => { try { return JSON.parse(src.config || '{}'); } catch { return {}; } })();
        const topic = cfg.query || cfg.url || src.name;
        // v1.3: custom topics can pin to a product to inherit its scan rules
        // (and have global rules apply automatically too). When unpinned,
        // only global rules apply.
        const pinnedProductId: number | null =
          typeof cfg.pinnedProductId === 'number' ? cfg.pinnedProductId : null;
        const pinned = pinnedProductId
          ? allProducts.find((p) => p.id === pinnedProductId) || null
          : null;
        // If the topic is pinned to a product whose brand/itself is now
        // scan-disabled, skip the topic entirely.
        if (pinned) {
          const pinnedBrandOk = enabledBrandIds.has(pinned.brand_id);
          const pinnedProductOk = pinned.scan_enabled === 1;
          if (!pinnedBrandOk || !pinnedProductOk) {
            log(`  skipped — pinned product/brand is scan-disabled`);
            continue;
          }
          log(`  pinned to product "${pinned.name}" — inheriting its rules`);
        }
        const guardrails = buildGuardrails(pinnedProductId); // null → global only
        const ownBrandsBlock = buildOwnBrandsBlock(brands);

        const prompt = `# Our portfolio
${portfolio}

# Topic of interest
${topic}
${pinned ? `\n# Pinned product\nThis topic is scoped to "${pinned.name}" (${pinned.category || ''}). Prefer opportunities that fit this product when picking matched_brand/matched_product.` : ''}

# Time window
Only consider events from the last ${settings.scanRecency}.

${ownBrandsBlock}

${guardrails}

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
            model: scanModel,
            maxTokens,
            temperature: 0.2,
            searchRecency: settings.scanRecency,
            jsonSchema: OPPS_SCHEMA_CUSTOM,
            stage,
            relatedId: src.id
          });
          const opps = r.json?.opportunities || [];
          const citations = r.citations || [];
          log(`  → ${opps.length} candidate(s) returned, ${citations.length} citation(s)`);
          scanned += opps.length;
          for (const cand of opps) {
            // Resolve matched_brand / matched_product against ENABLED only —
            // the LLM never sees disabled brands in the prompt, but be
            // defensive in case it makes one up.
            const matchedBrand =
              enabledBrands.find((b) => b.name.toLowerCase() === (cand.matched_brand || '').toLowerCase()) || null;
            const matchedProduct =
              enabledProducts.find(
                (p) =>
                  p.name.toLowerCase() === (cand.matched_product || '').toLowerCase() &&
                  (!matchedBrand || p.brand_id === matchedBrand.id)
              ) || null;
            created += insertCandidates(
              [cand],
              {
                brand: matchedBrand,
                product: matchedProduct,
                sourceLabel: `custom:${src.name}`,
                brands,
                citations
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

/**
 * Thin wrapper around runScan that uses Perplexity's heavy deep-research
 * model. Designed for a low-frequency cron (default twice daily) so the
 * higher per-call cost is amortized across discovery quality.
 *
 * The token budget is roughly 2× the regular scan because deep-research
 * generates longer reasoning before its final answer.
 */
export async function runDeepScan(): Promise<{ runId: number; created: number; scanned: number }> {
  const settings = getSettings();
  return runScan({
    model: settings.deepScanModel || 'sonar-deep-research',
    stage: 'deep_scan',
    kind: 'deep',
    maxTokens: 9000,
    label: '== Deep Research scan =='
  });
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
          'company', 'industry', 'country', 'source_url', 'source_title', 'headline',
          'background', 'use_case', 'angle', 'signal_summary',
          'matched_signal', 'confidence',
          'matched_brand', 'matched_product'
        ],
        properties: {
          company: { type: 'string' },
          industry: { type: 'string' },
          country: { type: ['string', 'null'], description: 'Country where the company is headquartered or where the event takes place. Use the common English name. Null if genuinely unknown.' },
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
  attrib: { brand: Brand | null; product: Product | null; sourceLabel: string; brands: Brand[]; citations: string[] },
  ctx: InsertCtx
): number {
  let inserted = 0;
  const cleanedCitations = dedupeCleanCitations(attrib.citations);
  for (const cand of candidates) {
    // v1.5.4: pick the best URL by cross-referencing the LLM's stated
    // source_url against Perplexity's citation list. Drops candidates
    // we can't anchor to a real URL.
    const picked = pickBestSourceUrl(cand.source_url, attrib.citations);
    if (!picked.url) {
      ctx.log(`  - skip (no usable source_url): ${cand.company}`);
      continue;
    }
    if (picked.source === 'citation') {
      ctx.log(`  ~ substituted source_url with citation for ${cand.company} (LLM URL didn't match citations)`);
    } else if (picked.source === 'llm_unverified' && cleanedCitations.length > 0) {
      ctx.log(`  ~ LLM url not in citations for ${cand.company} — kept LLM url (no host match)`);
    }
    const url = picked.url;
    if (ctx.seenStmt.get(url)) { ctx.log(`  - skip (seen): ${cand.company}`); continue; }
    if ((cand.confidence ?? 0) < ctx.settings.minConfidence) {
      ctx.log(`  - skip (low conf ${(cand.confidence ?? 0).toFixed(2)}): ${cand.company}`);
      continue;
    }
    if (isOwnBrandCompany(cand.company, attrib.brands)) {
      ctx.log(`  - skip (our own brand as customer): ${cand.company}`);
      continue;
    }
    // Defense-in-depth: never insert a lead for a scan-disabled brand or
    // product, even if Pass 2's matched_brand/matched_product slipped past
    // the prompt-level filter. Brand toggle is the master gate; product
    // toggle is its inner gate.
    if (attrib.brand && attrib.brand.scan_enabled !== 1) {
      ctx.log(`  - skip (brand "${attrib.brand.name}" is scan-disabled): ${cand.company}`);
      continue;
    }
    if (attrib.product && attrib.product.scan_enabled !== 1) {
      ctx.log(`  - skip (product "${attrib.product.name}" is scan-disabled): ${cand.company}`);
      continue;
    }
    ctx.insertSeen.run(url);
    ctx.insertOpp.run(
      attrib.brand?.id ?? null,
      attrib.product?.id ?? null,
      cand.company,
      cand.industry,
      (cand.country && cand.country.trim()) || null,
      cand.headline,
      url,
      cand.source_title || attrib.sourceLabel,
      cand.source_published_at || null,
      cand.confidence,
      cand.background,
      cand.use_case,
      cand.angle,
      cand.signal_summary,
      JSON.stringify({
        source: attrib.sourceLabel,
        matched_signal: cand.matched_signal,
        // Keep up to 8 alternative citations so the UI can offer them if
        // the primary source link is broken.
        alt_sources: cleanedCitations.filter((c) => c !== url).slice(0, 8),
        url_source: picked.source
      })
    );
    inserted++;
    ctx.log(
      `  ✓ ${cand.company} (${(cand.confidence ?? 0).toFixed(2)}) → ${attrib.brand?.name || '?'} / ${attrib.product?.name || '?'}`
    );
  }
  return inserted;
}
