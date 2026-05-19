import { ipcMain, dialog, shell, BrowserWindow } from 'electron';
import { getDb, dataDir } from './db.js';
import { getSettings, updateSettings } from './settings.js';
import { extractFromFile, fetchUrl } from './knowledge.js';
import { researchProduct } from './research.js';
import { runScan } from './scanner.js';
import { buildBrief, recordDispatch } from './dispatch.js';
import { restartScheduler } from './scheduler.js';
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
    return db.prepare('SELECT * FROM brands WHERE id = ?').get(id);
  });
  ipcMain.handle('brands:delete', (_e, id: number) => {
    db.prepare('DELETE FROM brands WHERE id = ?').run(id);
    return true;
  });

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
    return db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  });
  ipcMain.handle('products:delete', (_e, id: number) => {
    db.prepare('DELETE FROM products WHERE id = ?').run(id);
    return true;
  });
  ipcMain.handle('products:research', async (_e, id: number) => researchProduct(id));
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
  ipcMain.handle('knowledge:addNote', (_e, payload: { brandId: number; title: string; content: string }) => {
    const info = db.prepare(
      `INSERT INTO knowledge_items(brand_id, kind, title, source, content, status)
       VALUES (?, 'note', ?, 'manual', ?, 'indexed')`
    ).run(payload.brandId, payload.title, payload.content);
    return db.prepare('SELECT * FROM knowledge_items WHERE id = ?').get(info.lastInsertRowid);
  });
  ipcMain.handle('knowledge:addLink', async (_e, payload: { brandId: number; url: string }) => {
    const fetched = await fetchUrl(payload.url);
    const info = db.prepare(
      `INSERT INTO knowledge_items(brand_id, kind, title, source, content, status)
       VALUES (?, 'link', ?, ?, ?, 'indexed')`
    ).run(payload.brandId, fetched.title, payload.url, fetched.content);
    return db.prepare('SELECT * FROM knowledge_items WHERE id = ?').get(info.lastInsertRowid);
  });
  ipcMain.handle('knowledge:upload', async (_e, brandId: number) => {
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
    const brandDir = join(dataDir(), 'brands', String(brandId), 'uploads');
    await mkdir(brandDir, { recursive: true });
    for (const filePath of sel.filePaths) {
      const extracted = await extractFromFile(filePath);
      const dest = join(brandDir, basename(filePath));
      try {
        const data = await import('fs/promises').then((f) => f.readFile(filePath));
        await writeFile(dest, data);
      } catch {}
      const info = db.prepare(
        `INSERT INTO knowledge_items(brand_id, kind, title, source, content, status)
         VALUES (?, 'file', ?, ?, ?, 'indexed')`
      ).run(brandId, extracted.title, dest, extracted.content);
      results.push(
        db.prepare('SELECT * FROM knowledge_items WHERE id = ?').get(info.lastInsertRowid) as KnowledgeItem
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

  // -------- Scan Rules (include / exclude guardrails) --------
  ipcMain.handle('rules:list', () =>
    db.prepare('SELECT * FROM scan_rules ORDER BY kind, id').all() as ScanRule[]
  );
  ipcMain.handle('rules:create', (_e, payload: { kind: 'include' | 'exclude'; text: string }) => {
    const info = db.prepare(
      'INSERT INTO scan_rules(kind, text, enabled) VALUES (?, ?, 1)'
    ).run(payload.kind, payload.text);
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

  // -------- Scans / Opportunities --------
  ipcMain.handle('scan:run', async () => {
    const result = await runScan();
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
    return db
      .prepare(`SELECT * FROM opportunities ${where} ORDER BY confidence DESC, id DESC LIMIT 500`)
      .all(...args) as Opportunity[];
  });
  ipcMain.handle('opps:get', (_e, id: number) =>
    db.prepare('SELECT * FROM opportunities WHERE id = ?').get(id) as Opportunity
  );
  ipcMain.handle('opps:setStatus', (_e, id: number, status: string) => {
    db.prepare('UPDATE opportunities SET status = ?, updated_at = datetime(\'now\') WHERE id = ?').run(status, id);
    return db.prepare('SELECT * FROM opportunities WHERE id = ?').get(id);
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
