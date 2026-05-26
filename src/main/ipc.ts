import { ipcMain, dialog, shell, BrowserWindow, app } from 'electron';
import { getDb, dataDir } from './db.js';
import { getSettings, updateSettings } from './settings.js';
import { extractFromFile, fetchUrl } from './knowledge.js';
import { researchProduct, researchBrand } from './research.js';
import { researchBrandSignals, researchProductSignals } from './signal-research.js';
import { listFeedback, type FeedbackTargetKind } from './feedback.js';
import { runScan, runDeepScan } from './scanner.js';
import { exportOpportunitiesXlsx } from './export.js';
import { chunkAndEmbedKnowledgeItem } from './knowledge-index.js';
import { buildBrief, recordDispatch } from './dispatch.js';
import { restartScheduler } from './scheduler.js';
import { getSpendSummary } from './spend.js';
import {
  startMonitor, stopMonitor, getMonitorStatus, getMonitorLog, isRunning as monitorRunning,
  processSingleItem
} from './monitor/index.js';
import { fetchUrl as fetchUrlForKnowledge } from './knowledge.js';
import { recordDisqualifyVector, embedSignalsForProduct } from './monitor/embed.js';
import type { MonitorSource, SignalItem, SourceHealth, Opportunity } from '@shared/types';
import { writeFile, mkdir } from 'fs/promises';
import { join, basename } from 'path';
import type {
  Brand, Product, KnowledgeItem, Opportunity, SignalSource, ScanRun, ScanRule, DashboardStats
} from '@shared/types';

export function registerIpc() {
  const db = getDb();

  // -------- Settings --------
  ipcMain.handle('settings:get', () => getSettings());
  ipcMain.handle('settings:update', (_e, patch) => {
    const s = updateSettings(patch);
    restartScheduler();
    // React to live-monitoring toggle changes
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'liveMonitoringEnabled')) {
      if (s.liveMonitoringEnabled) startMonitor();
      else stopMonitor();
    }
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'openAtLogin')) {
      try {
        app.setLoginItemSettings({ openAtLogin: !!s.openAtLogin, openAsHidden: true });
      } catch (e) {
        console.warn('setLoginItemSettings failed:', e);
      }
    }
    return s;
  });

  // -------- Dashboard --------
  ipcMain.handle('dashboard:stats', (): DashboardStats => {
    const counts = db.prepare(
      `SELECT
        SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open,
        SUM(CASE WHEN status = 'qualified' THEN 1 ELSE 0 END) AS qualified,
        SUM(CASE WHEN status = 'disqualified' THEN 1 ELSE 0 END) AS disqualified
      FROM opportunities`
    ).get() as { open: number; qualified: number; disqualified: number } | null;
    const brands = (db.prepare('SELECT COUNT(*) AS c FROM brands').get() as any).c as number;
    const lastRun = db
      .prepare('SELECT * FROM scan_runs ORDER BY id DESC LIMIT 1')
      .get() as ScanRun | undefined;
    return {
      open: counts?.open ?? 0,
      qualified: counts?.qualified ?? 0,
      disqualified: counts?.disqualified ?? 0,
      brands,
      lastScan: lastRun
        ? {
            startedAt: lastRun.started_at,
            status: lastRun.status,
            results: lastRun.opportunities_created
          }
        : null
    };
  });

  // -------- Brands --------
  ipcMain.handle('brands:list', () =>
    db.prepare('SELECT * FROM brands ORDER BY name').all() as Brand[]
  );
  ipcMain.handle('brands:get', (_e, id: number) =>
    db.prepare('SELECT * FROM brands WHERE id = ?').get(id) as Brand
  );
  ipcMain.handle('brands:create', (_e, payload: Partial<Brand>) => {
    const info = db
      .prepare('INSERT INTO brands(name, description, positioning) VALUES (?, ?, ?)')
      .run(payload.name, payload.description ?? null, payload.positioning ?? null);
    return db.prepare('SELECT * FROM brands WHERE id = ?').get(info.lastInsertRowid);
  });
  ipcMain.handle('brands:update', (_e, id: number, payload: Partial<Brand>) => {
    db.prepare(
      `UPDATE brands SET
        name = COALESCE(?, name),
        description = COALESCE(?, description),
        positioning = COALESCE(?, positioning),
        competitive_summary = COALESCE(?, competitive_summary),
        updated_at = datetime('now')
       WHERE id = ?`
    ).run(payload.name ?? null, payload.description ?? null, payload.positioning ?? null, payload.competitive_summary ?? null, id);
    // v1.8: scan_recency_override is set explicitly (null clears it). Only
    // touched if the renderer included the key — otherwise leave alone.
    if ('scan_recency_override' in payload) {
      db.prepare("UPDATE brands SET scan_recency_override = ?, updated_at = datetime('now') WHERE id = ?")
        .run(payload.scan_recency_override ?? null, id);
    }
    return db.prepare('SELECT * FROM brands WHERE id = ?').get(id);
  });
  ipcMain.handle('brands:delete', (_e, id: number) => {
    db.prepare('DELETE FROM brands WHERE id = ?').run(id);
    return true;
  });
  ipcMain.handle('brands:setScanEnabled', (_e, id: number, enabled: boolean) => {
    db.prepare(
      "UPDATE brands SET scan_enabled = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(enabled ? 1 : 0, id);
    return db.prepare('SELECT * FROM brands WHERE id = ?').get(id);
  });
  // v1.6: brand becomes a first-class research subject.
  // v1.10.0: accepts { feedback? } for reviewer-feedback-aware re-research.
  ipcMain.handle('brands:research', async (_e, id: number, opts?: { feedback?: string }) =>
    researchBrand(id, opts || {})
  );
  // v1.9.2: brand-level signal research (separate job, optional feedback).
  ipcMain.handle('brands:researchSignals', async (_e, id: number, opts?: { feedback?: string }) =>
    researchBrandSignals(id, opts || {})
  );

  // -------- Products --------
  ipcMain.handle('products:list', (_e, brandId?: number) => {
    if (brandId)
      return db
        .prepare('SELECT * FROM products WHERE brand_id = ? ORDER BY name')
        .all(brandId) as Product[];
    return db.prepare('SELECT * FROM products ORDER BY name').all() as Product[];
  });
  ipcMain.handle('products:get', (_e, id: number) =>
    db.prepare('SELECT * FROM products WHERE id = ?').get(id) as Product
  );
  ipcMain.handle('products:create', (_e, payload: Partial<Product>) => {
    const info = db.prepare(
      `INSERT INTO products(brand_id, name, description, category)
       VALUES (?, ?, ?, ?)`
    ).run(payload.brand_id, payload.name, payload.description ?? null, payload.category ?? null);
    return db.prepare('SELECT * FROM products WHERE id = ?').get(info.lastInsertRowid);
  });
  ipcMain.handle('products:update', (_e, id: number, payload: Partial<Product>) => {
    db.prepare(
      `UPDATE products SET
        name = COALESCE(?, name),
        description = COALESCE(?, description),
        category = COALESCE(?, category),
        use_cases = COALESCE(?, use_cases),
        competitors = COALESCE(?, competitors),
        differentiators = COALESCE(?, differentiators),
        signals = COALESCE(?, signals),
        research_summary = COALESCE(?, research_summary),
        updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      payload.name ?? null,
      payload.description ?? null,
      payload.category ?? null,
      payload.use_cases ?? null,
      payload.competitors ?? null,
      payload.differentiators ?? null,
      payload.signals ?? null,
      payload.research_summary ?? null,
      id
    );
    // v1.8: scan_recency_override set explicitly when key is in payload.
    if ('scan_recency_override' in payload) {
      db.prepare("UPDATE products SET scan_recency_override = ?, updated_at = datetime('now') WHERE id = ?")
        .run(payload.scan_recency_override ?? null, id);
    }
    return db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  });
  ipcMain.handle('products:delete', (_e, id: number) => {
    db.prepare('DELETE FROM scan_rules WHERE product_id = ?').run(id);
    db.prepare('DELETE FROM products WHERE id = ?').run(id);
    return true;
  });
  // v1.10.0: products:research accepts { feedback? } for reviewer-feedback-aware re-research.
  ipcMain.handle('products:research', async (_e, id: number, opts?: { feedback?: string }) =>
    researchProduct(id, opts || {})
  );
  // v1.9.2: product-level signal research (separate job, optional feedback).
  // Replaces the old products:refreshSignals handler.
  ipcMain.handle('products:researchSignals', async (_e, id: number, opts?: { feedback?: string }) =>
    researchProductSignals(id, opts || {})
  );
  // Re-embed the product's signals string in-place — no Perplexity call.
  // Used after the user manually edits the signals via the product editor.
  ipcMain.handle('products:reembed', async (_e, id: number) => {
    await embedSignalsForProduct(id);
    return true;
  });
  ipcMain.handle('products:setScanEnabled', (_e, id: number, enabled: boolean) => {
    db.prepare(
      "UPDATE products SET scan_enabled = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(enabled ? 1 : 0, id);
    return db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  });

  // -------- Knowledge --------
  ipcMain.handle('knowledge:list', (_e, brandId?: number) => {
    if (brandId)
      return db
        .prepare('SELECT * FROM knowledge_items WHERE brand_id = ? ORDER BY created_at DESC')
        .all(brandId) as KnowledgeItem[];
    return db
      .prepare('SELECT * FROM knowledge_items ORDER BY created_at DESC LIMIT 200')
      .all() as KnowledgeItem[];
  });
  ipcMain.handle('knowledge:addNote', (_e, payload: { brandId: number; productId?: number | null; title: string; content: string }) => {
    const info = db.prepare(
      `INSERT INTO knowledge_items(brand_id, product_id, kind, title, source, content, status)
       VALUES (?, ?, 'note', ?, 'manual', ?, 'indexed')`
    ).run(payload.brandId, payload.productId ?? null, payload.title, payload.content);
    const id = Number(info.lastInsertRowid);
    // Fire-and-forget chunk + embed so retrieval sees this immediately on next scan.
    chunkAndEmbedKnowledgeItem(id).catch((e) => console.warn('[knowledge:addNote] embed failed:', e?.message || e));
    return db.prepare('SELECT * FROM knowledge_items WHERE id = ?').get(id);
  });
  ipcMain.handle('knowledge:addLink', async (_e, payload: { brandId: number; productId?: number | null; url: string }) => {
    const fetched = await fetchUrl(payload.url);
    const info = db.prepare(
      `INSERT INTO knowledge_items(brand_id, product_id, kind, title, source, content, status)
       VALUES (?, ?, 'link', ?, ?, ?, 'indexed')`
    ).run(payload.brandId, payload.productId ?? null, fetched.title, payload.url, fetched.content);
    const id = Number(info.lastInsertRowid);
    chunkAndEmbedKnowledgeItem(id).catch((e) => console.warn('[knowledge:addLink] embed failed:', e?.message || e));
    return db.prepare('SELECT * FROM knowledge_items WHERE id = ?').get(id);
  });
  ipcMain.handle('knowledge:upload', async (_e, brandId: number, productId?: number | null) => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return null;
    const sel = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Documents', extensions: ['pdf', 'pptx', 'docx', 'txt', 'md', 'html'] }
      ]
    });
    if (sel.canceled) return [];
    const results: KnowledgeItem[] = [];
    const brandDir = join(dataDir(), 'brands', String(brandId), productId ? `products/${productId}` : 'uploads');
    await mkdir(brandDir, { recursive: true });
    for (const filePath of sel.filePaths) {
      const extracted = await extractFromFile(filePath);
      const dest = join(brandDir, basename(filePath));
      try {
        const data = await import('fs/promises').then((f) => f.readFile(filePath));
        await writeFile(dest, data);
      } catch {}
      const info = db.prepare(
        `INSERT INTO knowledge_items(brand_id, product_id, kind, title, source, content, status)
         VALUES (?, ?, 'file', ?, ?, ?, 'indexed')`
      ).run(brandId, productId ?? null, extracted.title, dest, extracted.content);
      const id = Number(info.lastInsertRowid);
      chunkAndEmbedKnowledgeItem(id).catch((e) => console.warn('[knowledge:upload] embed failed:', e?.message || e));
      results.push(
        db.prepare('SELECT * FROM knowledge_items WHERE id = ?').get(id) as KnowledgeItem
      );
    }
    return results;
  });
  ipcMain.handle('knowledge:delete', (_e, id: number) => {
    db.prepare('DELETE FROM knowledge_items WHERE id = ?').run(id);
    return true;
  });

  // -------- Signal Sources --------
  ipcMain.handle('sources:list', () =>
    db.prepare('SELECT * FROM signal_sources ORDER BY id').all() as SignalSource[]
  );
  ipcMain.handle('sources:create', (_e, payload: Partial<SignalSource>) => {
    const info = db.prepare(
      `INSERT INTO signal_sources(name, kind, config, enabled) VALUES (?, ?, ?, ?)`
    ).run(payload.name, payload.kind, payload.config ?? '{}', payload.enabled ?? 1);
    return db.prepare('SELECT * FROM signal_sources WHERE id = ?').get(info.lastInsertRowid);
  });
  ipcMain.handle('sources:update', (_e, id: number, payload: Partial<SignalSource>) => {
    db.prepare(
      `UPDATE signal_sources SET name = COALESCE(?, name), kind = COALESCE(?, kind),
       config = COALESCE(?, config), enabled = COALESCE(?, enabled) WHERE id = ?`
    ).run(payload.name ?? null, payload.kind ?? null, payload.config ?? null, payload.enabled ?? null, id);
    return db.prepare('SELECT * FROM signal_sources WHERE id = ?').get(id);
  });
  ipcMain.handle('sources:delete', (_e, id: number) => {
    db.prepare('DELETE FROM signal_sources WHERE id = ?').run(id);
    return true;
  });

  // -------- Scan Rules (per-product include / exclude guardrails) --------
  ipcMain.handle('rules:list', (_e, productId: number) =>
    db
      .prepare("SELECT * FROM scan_rules WHERE scope = 'product' AND product_id = ? ORDER BY kind, id")
      .all(productId) as ScanRule[]
  );
  ipcMain.handle('rules:create', (_e, payload: { productId: number; kind: 'include' | 'exclude'; text: string }) => {
    const info = db.prepare(
      "INSERT INTO scan_rules(product_id, scope, kind, text, enabled) VALUES (?, 'product', ?, ?, 1)"
    ).run(payload.productId, payload.kind, payload.text);
    return db.prepare('SELECT * FROM scan_rules WHERE id = ?').get(info.lastInsertRowid);
  });
  ipcMain.handle('rules:update', (_e, id: number, payload: Partial<ScanRule>) => {
    db.prepare(
      'UPDATE scan_rules SET text = COALESCE(?, text), enabled = COALESCE(?, enabled) WHERE id = ?'
    ).run(payload.text ?? null, payload.enabled ?? null, id);
    return db.prepare('SELECT * FROM scan_rules WHERE id = ?').get(id);
  });
  ipcMain.handle('rules:delete', (_e, id: number) => {
    db.prepare('DELETE FROM scan_rules WHERE id = ?').run(id);
    return true;
  });

  // v1.3 — Global rules apply to EVERY Perplexity scan call (Pass 1, Pass 2,
  // and Live Monitor deep qualify). product_id is NULL for global rules.
  ipcMain.handle('rules:listGlobal', () =>
    db.prepare("SELECT * FROM scan_rules WHERE scope = 'global' ORDER BY kind, id").all() as ScanRule[]
  );
  ipcMain.handle('rules:createGlobal', (_e, payload: { kind: 'include' | 'exclude'; text: string }) => {
    const info = db.prepare(
      "INSERT INTO scan_rules(product_id, scope, kind, text, enabled) VALUES (NULL, 'global', ?, ?, 1)"
    ).run(payload.kind, payload.text);
    return db.prepare('SELECT * FROM scan_rules WHERE id = ?').get(info.lastInsertRowid);
  });

  // -------- Scans / Opportunities --------
  ipcMain.handle('scan:run', async () => {
    const result = await runScan();
    return result;
  });
  ipcMain.handle('scan:runDeep', async () => {
    const result = await runDeepScan();
    return result;
  });
  ipcMain.handle('scan:runs', () =>
    db
      .prepare('SELECT * FROM scan_runs ORDER BY id DESC LIMIT 50')
      .all() as ScanRun[]
  );
  ipcMain.handle('scan:run:get', (_e, id: number) =>
    db.prepare('SELECT * FROM scan_runs WHERE id = ?').get(id) as ScanRun
  );

  ipcMain.handle('opps:list', (_e, status?: string) => {
    const where = status ? "WHERE status = ?" : '';
    const args = status ? [status] : [];
    // Default sort: newest first (created_at desc, then id desc as tie-break).
    // The renderer can re-sort client-side once the rows are in memory.
    return db
      .prepare(`SELECT * FROM opportunities ${where} ORDER BY datetime(created_at) DESC, id DESC LIMIT 500`)
      .all(...args) as Opportunity[];
  });
  ipcMain.handle('opps:get', (_e, id: number) =>
    db.prepare('SELECT * FROM opportunities WHERE id = ?').get(id) as Opportunity
  );
  ipcMain.handle('opps:setStatus', (_e, id: number, status: string) => {
    db.prepare('UPDATE opportunities SET status = ?, updated_at = datetime(\'now\') WHERE id = ?').run(status, id);
    return db.prepare('SELECT * FROM opportunities WHERE id = ?').get(id);
  });
  ipcMain.handle('opps:disqualify', (_e, id: number, reason?: string | null) => {
    const cleanReason = (reason ?? '').trim() || null;
    db.prepare(
      `UPDATE opportunities
       SET status = 'disqualified',
           disqualify_reason = ?,
           updated_at = datetime('now')
       WHERE id = ?`
    ).run(cleanReason, id);
    const opp = db.prepare('SELECT * FROM opportunities WHERE id = ?').get(id) as Opportunity | undefined;
    // Layer B: fire-and-forget fingerprint capture so the live-monitor's
    // local pre-filter learns to demote similar incoming items.
    if (opp && opp.product_id) {
      recordDisqualifyVector(opp.product_id, opp.headline, cleanReason, opp.signal_summary).catch(
        (e) => console.warn('[opps:disqualify] vector capture failed:', e?.message || e)
      );
    }
    return opp;
  });
  ipcMain.handle('opps:delete', (_e, id: number) => {
    db.prepare('DELETE FROM dispatch_log WHERE opportunity_id = ?').run(id);
    db.prepare('DELETE FROM opportunities WHERE id = ?').run(id);
    return true;
  });
  ipcMain.handle('opps:exportXlsx', async (_e, ids: number[]) => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return null;
    const buf = await exportOpportunitiesXlsx(ids);
    const defaultName = `leadshawk-opportunities-${new Date().toISOString().slice(0, 10)}.xlsx`;
    const sel = await dialog.showSaveDialog(win, {
      title: 'Export opportunities',
      defaultPath: defaultName,
      filters: [{ name: 'Excel workbook', extensions: ['xlsx'] }]
    });
    if (sel.canceled || !sel.filePath) return null;
    await writeFile(sel.filePath, buf);
    return { path: sel.filePath, count: ids.length };
  });
  ipcMain.handle('opps:deleteMany', (_e, ids: number[]) => {
    if (!Array.isArray(ids) || ids.length === 0) return 0;
    const placeholders = ids.map(() => '?').join(',');
    const delLog = db.prepare(`DELETE FROM dispatch_log WHERE opportunity_id IN (${placeholders})`);
    const delOpps = db.prepare(`DELETE FROM opportunities WHERE id IN (${placeholders})`);
    const txn = db.transaction((values: number[]) => {
      delLog.run(...values);
      delOpps.run(...values);
    });
    txn(ids);
    return ids.length;
  });
  ipcMain.handle('opps:brief', async (_e, id: number) => buildBrief(id));
  ipcMain.handle('opps:dispatch', async (_e, id: number, target: string, payload: string) => {
    recordDispatch(id, target, payload);
    return true;
  });

  ipcMain.handle('openExternal', (_e, url: string) => {
    shell.openExternal(url);
    return true;
  });

  // -------- Live Monitor --------
  ipcMain.handle('monitor:status', () => getMonitorStatus());
  ipcMain.handle('monitor:start', async () => { await startMonitor(); return getMonitorStatus(); });
  ipcMain.handle('monitor:stop', () => { stopMonitor(); return getMonitorStatus(); });
  ipcMain.handle('monitor:running', () => monitorRunning());
  ipcMain.handle('monitor:log', () => getMonitorLog());
  ipcMain.handle('monitor:items', (_e, limit?: number) =>
    db
      .prepare('SELECT * FROM signal_items ORDER BY fetched_at DESC LIMIT ?')
      .all(limit ?? 100) as SignalItem[]
  );
  ipcMain.handle('monitor:sources', () =>
    db.prepare('SELECT * FROM monitor_sources ORDER BY id').all() as MonitorSource[]
  );
  ipcMain.handle('monitor:sources:create', (_e, p: Partial<MonitorSource>) => {
    const info = db.prepare(
      `INSERT INTO monitor_sources(name, kind, url, config, enabled, poll_interval_seconds)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      p.name,
      p.kind || 'rss',
      p.url || '',
      p.config ?? null,
      p.enabled ?? 1,
      p.poll_interval_seconds ?? 900
    );
    return db.prepare('SELECT * FROM monitor_sources WHERE id = ?').get(info.lastInsertRowid);
  });
  ipcMain.handle('monitor:sources:update', (_e, id: number, p: Partial<MonitorSource>) => {
    db.prepare(
      `UPDATE monitor_sources SET
         name = COALESCE(?, name),
         url = COALESCE(?, url),
         enabled = COALESCE(?, enabled),
         poll_interval_seconds = COALESCE(?, poll_interval_seconds),
         config = COALESCE(?, config)
       WHERE id = ?`
    ).run(p.name ?? null, p.url ?? null, p.enabled ?? null, p.poll_interval_seconds ?? null, p.config ?? null, id);
    return db.prepare('SELECT * FROM monitor_sources WHERE id = ?').get(id);
  });
  ipcMain.handle('monitor:sources:delete', (_e, id: number) => {
    db.prepare('DELETE FROM monitor_sources WHERE id = ?').run(id);
    return true;
  });
  // v1.7: manual article intake. User pastes a URL (or URL + override
  // title); we fetch, insert as a signal_item, and run the full
  // embed → triage → qualify pipeline synchronously so they see the result.
  ipcMain.handle('monitor:intake', async (_e, payload: { url: string; title?: string }) => {
    const url = (payload?.url || '').trim();
    if (!url) throw new Error('URL is required.');
    let fetched: { title: string; content: string };
    try {
      fetched = await fetchUrlForKnowledge(url);
    } catch (e: any) {
      throw new Error(`Failed to fetch URL: ${e?.message || e}`);
    }
    const title = (payload.title || fetched.title || url).slice(0, 500);
    const snippet = (fetched.content || '').slice(0, 1500);
    // Insert or surface existing item if we've already seen this URL.
    const existing = db.prepare('SELECT id FROM signal_items WHERE url = ?').get(url) as { id: number } | undefined;
    let itemId: number;
    if (existing) {
      itemId = existing.id;
      db.prepare(
        "UPDATE signal_items SET title = ?, snippet = ?, content = ?, status = 'new', error = NULL, processed_at = NULL WHERE id = ?"
      ).run(title, snippet, fetched.content || null, itemId);
    } else {
      const info = db.prepare(
        `INSERT INTO signal_items(source_id, url, title, snippet, content, status)
         VALUES (NULL, ?, ?, ?, ?, 'new')`
      ).run(url, title, snippet, fetched.content || null);
      itemId = Number(info.lastInsertRowid);
    }
    const outcome = await processSingleItem(itemId);
    return { itemId, outcome };
  });

  ipcMain.handle('monitor:sources:health', (): SourceHealth[] => {
    // Per-source 7-day funnel: ingested → passed prefilter (candidate or further)
    // → triaged strong → became opportunity. Joins through signal_items.
    return db.prepare(`
      SELECT
        s.id, s.name, s.enabled, s.last_polled_at, s.last_status, s.poll_interval_seconds,
        COALESCE(SUM(CASE WHEN i.fetched_at >= datetime('now','-7 days') THEN 1 ELSE 0 END), 0) AS ingested7d,
        COALESCE(SUM(CASE WHEN i.fetched_at >= datetime('now','-7 days') AND i.status NOT IN ('filtered','new','embedded') THEN 1 ELSE 0 END), 0) AS candidates7d,
        COALESCE(SUM(CASE WHEN i.fetched_at >= datetime('now','-7 days') AND i.status IN ('triaged_strong','qualified') THEN 1 ELSE 0 END), 0) AS strong7d,
        COALESCE(SUM(CASE WHEN i.fetched_at >= datetime('now','-7 days') AND i.status = 'qualified' THEN 1 ELSE 0 END), 0) AS qualified7d
      FROM monitor_sources s
      LEFT JOIN signal_items i ON i.source_id = s.id
      GROUP BY s.id
      ORDER BY qualified7d DESC, strong7d DESC, ingested7d DESC
    `).all() as SourceHealth[];
  });

  // -------- Spend --------
  ipcMain.handle('spend:summary', () => getSpendSummary());

  // -------- Feedback (v1.9.2) --------
  // Read-only — feedback rows are inserted by the research handlers
  // themselves when `opts.feedback` is provided, so the renderer never
  // needs to call addFeedback directly. listFeedback drives the modal's
  // history pane.
  ipcMain.handle('feedback:list', (_e, kind: FeedbackTargetKind, targetId: number) =>
    listFeedback(kind, targetId)
  );
}

export function seedDefaults() {
  const db = getDb();
  // Signal sources are no longer auto-seeded — scans derive their signals
  // directly from per-product research output. Power users can still add
  // optional custom topics in Signal Config.
  const jobCount = (db.prepare('SELECT COUNT(*) AS c FROM scan_jobs').get() as any).c as number;
  if (jobCount === 0) {
    db.prepare("INSERT INTO scan_jobs(cron, enabled) VALUES ('0 */6 * * *', 1)").run();
  }
}
