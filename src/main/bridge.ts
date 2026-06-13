// Localhost read-only HTTP bridge for external agents (Hermes BDM, etc).
//
// Contract (consumed by Hermes BDM Step 0 — see
// HermesCommand/supervisor/seed_skills/bdm/00-consult-leadshawk-first.md):
//
//   GET /api/brands?q={name}     → [{id, name, domain, has_dossier, dossier_status}]
//   GET /api/brands/{id}         → full brand dossier
//   GET /api/products?brand_id={id} → list products for a brand
//   GET /api/products/{id}       → full product dossier
//
// Localhost-only, no auth. Safe because (a) we bind to 127.0.0.1, never
// 0.0.0.0, and (b) the surface is strictly read-only — no write/delete
// endpoints exist on this server.

import http from 'http';
import { URL } from 'url';
import { getDb } from './db.js';
import type { Brand, Product } from '../shared/types.js';

const HOST = '127.0.0.1';
const PORT = 8772;

let server: http.Server | null = null;

// ──────────────────────────────────────────────────────────────────────────
// Field mapping
// ──────────────────────────────────────────────────────────────────────────

// Contract status: `none | researching | verified | fact_checked | stale`.
// LeadsHawk has research_status + advanced-pipeline artifacts that carry
// more nuance. Collapse to the contract:
//  - pending / error → none
//  - researching → researching
//  - ready + fact_check_report → fact_checked  (Stage 4 ran)
//  - ready + verified_dossier  → verified      (Stage 2 ran)
//  - ready alone (Stage 1 only) → stale        (provisional; flagged so the
//    BDM agent knows it leaned on shaky ground)
function dossierStatusFor(row: {
  research_status: string | null;
  verified_dossier?: string | null;
  fact_check_report?: string | null;
}): 'none' | 'researching' | 'verified' | 'fact_checked' | 'stale' {
  const rs = row.research_status;
  if (rs === 'researching') return 'researching';
  if (rs !== 'ready') return 'none';
  if (row.fact_check_report) return 'fact_checked';
  if (row.verified_dossier) return 'verified';
  return 'stale';
}

function hasDossier(row: { research_status: string | null }): boolean {
  return row.research_status === 'ready';
}

// LeadsHawk stores signals as a free-form bulleted string. Split into the
// array shape an agent can iterate.
function signalsToList(s: string | null | undefined): string[] {
  if (!s) return [];
  return s
    .split('\n')
    .map((l) => l.replace(/^[\s•\-*\d.()]+/, '').trim())
    .filter((l) => l.length > 0);
}

function safeJsonParse<T = unknown>(s: string | null | undefined): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function brandSummary(row: Brand) {
  return {
    id: row.id,
    name: row.name,
    domain: row.domain,
    has_dossier: hasDossier(row),
    dossier_status: dossierStatusFor(row),
  };
}

function brandDossier(row: Brand) {
  return {
    id: row.id,
    name: row.name,
    domain: row.domain,
    has_dossier: hasDossier(row),
    dossier_status: dossierStatusFor(row),
    category: row.category,
    positioning: row.positioning,
    target_icp: row.target_icp,
    competitive_summary: row.competitive_summary,
    research_summary: row.research_summary,
    signals: signalsToList(row.signals),
    strategic_intel: safeJsonParse(row.strategic_intel),
    fact_check: safeJsonParse(row.fact_check_report),
    last_researched_at: row.last_researched_at,
    last_fact_check_at: row.last_fact_check_at,
  };
}

function productSummary(row: Product) {
  return {
    id: row.id,
    brand_id: row.brand_id,
    name: row.name,
    category: row.category,
    has_dossier: hasDossier(row),
    dossier_status: dossierStatusFor(row),
  };
}

function productDossier(row: Product) {
  return {
    id: row.id,
    brand_id: row.brand_id,
    name: row.name,
    description: row.description,
    category: row.category,
    has_dossier: hasDossier(row),
    dossier_status: dossierStatusFor(row),
    use_cases: row.use_cases,
    competitors: row.competitors,
    differentiators: row.differentiators,
    signals: signalsToList(row.signals),
    research_summary: row.research_summary,
    strategic_intel: safeJsonParse(row.strategic_intel),
    fact_check: safeJsonParse(row.fact_check_report),
    last_researched_at: row.last_researched_at,
    last_fact_check_at: row.last_fact_check_at,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Route handlers
// ──────────────────────────────────────────────────────────────────────────

function send(res: http.ServerResponse, code: number, body: unknown) {
  const json = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'Cache-Control': 'no-store',
  });
  res.end(json);
}

function handleBrandsList(res: http.ServerResponse, q: string | null) {
  const db = getDb();
  let rows: Brand[];
  if (q && q.trim()) {
    rows = db
      .prepare(
        `SELECT * FROM brands
         WHERE LOWER(name) LIKE LOWER(?)
         ORDER BY name COLLATE NOCASE
         LIMIT 25`
      )
      .all(`%${q.trim()}%`) as Brand[];
  } else {
    rows = db
      .prepare('SELECT * FROM brands ORDER BY name COLLATE NOCASE LIMIT 50')
      .all() as Brand[];
  }
  send(res, 200, rows.map(brandSummary));
}

function handleBrandGet(res: http.ServerResponse, id: number) {
  const row = getDb().prepare('SELECT * FROM brands WHERE id = ?').get(id) as
    | Brand
    | undefined;
  if (!row) return send(res, 404, { error: 'brand_not_found', id });
  send(res, 200, brandDossier(row));
}

function handleProductsList(res: http.ServerResponse, brandId: number | null) {
  const db = getDb();
  let rows: Product[];
  if (brandId != null) {
    rows = db
      .prepare(
        'SELECT * FROM products WHERE brand_id = ? ORDER BY name COLLATE NOCASE'
      )
      .all(brandId) as Product[];
  } else {
    rows = db
      .prepare('SELECT * FROM products ORDER BY name COLLATE NOCASE LIMIT 100')
      .all() as Product[];
  }
  send(res, 200, rows.map(productSummary));
}

function handleProductGet(res: http.ServerResponse, id: number) {
  const row = getDb().prepare('SELECT * FROM products WHERE id = ?').get(id) as
    | Product
    | undefined;
  if (!row) return send(res, 404, { error: 'product_not_found', id });
  send(res, 200, productDossier(row));
}

function handleHealth(res: http.ServerResponse) {
  send(res, 200, {
    ok: true,
    service: 'leadshawk-bridge',
    version: 1,
    endpoints: [
      'GET /api/brands?q=',
      'GET /api/brands/:id',
      'GET /api/products?brand_id=',
      'GET /api/products/:id',
    ],
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Router
// ──────────────────────────────────────────────────────────────────────────

function route(req: http.IncomingMessage, res: http.ServerResponse) {
  if (req.method !== 'GET') {
    return send(res, 405, { error: 'method_not_allowed' });
  }
  let url: URL;
  try {
    url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  } catch {
    return send(res, 400, { error: 'bad_url' });
  }
  const path = url.pathname;

  if (path === '/api/health') return handleHealth(res);

  if (path === '/api/brands') {
    return handleBrandsList(res, url.searchParams.get('q'));
  }
  const brandIdMatch = path.match(/^\/api\/brands\/(\d+)$/);
  if (brandIdMatch) return handleBrandGet(res, Number(brandIdMatch[1]));

  if (path === '/api/products') {
    const raw = url.searchParams.get('brand_id');
    const brandId = raw && /^\d+$/.test(raw) ? Number(raw) : null;
    return handleProductsList(res, brandId);
  }
  const productIdMatch = path.match(/^\/api\/products\/(\d+)$/);
  if (productIdMatch) return handleProductGet(res, Number(productIdMatch[1]));

  send(res, 404, { error: 'not_found', path });
}

// ──────────────────────────────────────────────────────────────────────────
// Lifecycle
// ──────────────────────────────────────────────────────────────────────────

export function startBridge(): void {
  if (server) return;
  const s = http.createServer((req, res) => {
    try {
      route(req, res);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('[bridge] handler error:', msg);
      if (!res.headersSent) send(res, 500, { error: 'internal', message: msg });
    }
  });
  s.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(
        `[bridge] port ${PORT} already in use — another LeadsHawk instance? Bridge disabled this session.`
      );
    } else {
      console.warn('[bridge] server error:', err.message);
    }
    server = null;
  });
  s.listen(PORT, HOST, () => {
    console.log(`[bridge] listening on http://${HOST}:${PORT}`);
  });
  server = s;
}

export function stopBridge(): void {
  if (!server) return;
  const s = server;
  server = null;
  s.close(() => {
    console.log('[bridge] stopped');
  });
}
