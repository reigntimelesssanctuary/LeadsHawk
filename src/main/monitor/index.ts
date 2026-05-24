import { Notification, BrowserWindow } from 'electron';
import { getDb } from '../db.js';
import { getSettings } from '../settings.js';
import {
  ensureAllProductEmbeddings,
  bestProductMatch,
  embedderState,
  ensureEmbedder
} from './embed.js';
import { pollAllDue, seedDefaultMonitorSources } from './ingest.js';
import { triageItem, loadProductAndBrand } from './triage.js';
import { qualifyItem } from './qualify.js';
import type { SignalItem, MonitorStatus } from '@shared/types';

let running = false;
let pollTimer: NodeJS.Timeout | null = null;
let pipelineTimer: NodeJS.Timeout | null = null;
const logLines: string[] = [];

function log(line: string) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  logLines.push(stamped);
  if (logLines.length > 500) logLines.splice(0, logLines.length - 500);
  console.log('[monitor]', line);
}

export function getMonitorLog(): string[] {
  return [...logLines];
}

export function isRunning(): boolean {
  return running;
}

export async function startMonitor(): Promise<void> {
  if (running) return;
  log('starting live monitor');
  running = true;

  seedDefaultMonitorSources();

  // Fire-and-forget embedder warmup so the UI can show progress
  ensureEmbedder().catch((e) => log(`embedder load failed: ${e?.message || e}`));
  ensureAllProductEmbeddings(log).catch((e) =>
    log(`product embedding refresh failed: ${e?.message || e}`)
  );

  // Poll cycle every 60s (each source has its own due check)
  pollTimer = setInterval(() => {
    pollAllDue(log).catch((e) => log(`poll cycle error: ${e?.message || e}`));
  }, 60_000);
  // First poll immediately
  setTimeout(() => pollAllDue(log).catch((e) => log(`poll cycle error: ${e?.message || e}`)), 1000);

  // Pipeline cycle every 30s: process up to N items per cycle
  pipelineTimer = setInterval(() => {
    processPipeline().catch((e) => log(`pipeline error: ${e?.message || e}`));
  }, 30_000);
  setTimeout(() => processPipeline().catch((e) => log(`pipeline error: ${e?.message || e}`)), 5000);
}

export function stopMonitor(): void {
  if (!running) return;
  log('stopping live monitor');
  running = false;
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (pipelineTimer) { clearInterval(pipelineTimer); pipelineTimer = null; }
}

const MAX_PER_CYCLE = 5;

async function processPipeline(): Promise<void> {
  if (!running) return;
  const settings = getSettings();
  const db = getDb();

  // Stage 2: embed + score 'new' items
  const newItems = db
    .prepare("SELECT * FROM signal_items WHERE status = 'new' ORDER BY id ASC LIMIT ?")
    .all(MAX_PER_CYCLE) as SignalItem[];
  for (const item of newItems) {
    try {
      const text = [item.title, item.snippet].filter(Boolean).join(' — ');
      const match = await bestProductMatch(text);
      if (!match) {
        db.prepare(
          "UPDATE signal_items SET status = 'filtered', error = 'no scan-enabled product with embeddings', processed_at = datetime('now') WHERE id = ?"
        ).run(item.id);
        continue;
      }
      const passed = match.similarity >= settings.embedSimilarityThreshold;
      db.prepare(
        `UPDATE signal_items
         SET status = ?, best_match_product_id = ?, best_match_similarity = ?, processed_at = datetime('now')
         WHERE id = ?`
      ).run(passed ? 'candidate' : 'filtered', match.productId, match.similarity, item.id);
      log(
        `embed ${item.id} → ${passed ? 'candidate' : 'filtered'} (sim=${match.similarity.toFixed(3)})`
      );
    } catch (e: any) {
      db.prepare(
        "UPDATE signal_items SET status = 'error', error = ?, processed_at = datetime('now') WHERE id = ?"
      ).run(String(e?.message || e).slice(0, 500), item.id);
      log(`embed error ${item.id}: ${e?.message || e}`);
    }
  }

  // Stage 3: triage candidates with Claude
  if (settings.anthropicApiKey) {
    const candidates = db
      .prepare(
        "SELECT * FROM signal_items WHERE status = 'candidate' ORDER BY best_match_similarity DESC, id ASC LIMIT ?"
      )
      .all(MAX_PER_CYCLE) as SignalItem[];
    for (const item of candidates) {
      try {
        const pb = item.best_match_product_id ? loadProductAndBrand(item.best_match_product_id) : null;
        if (!pb) {
          db.prepare(
            "UPDATE signal_items SET status = 'error', error = 'matched product/brand vanished' WHERE id = ?"
          ).run(item.id);
          continue;
        }
        // Re-fetch the matched signal text from the cached vectors
        const products = db
          .prepare('SELECT signal_embeddings FROM products WHERE id = ?')
          .get(pb.product.id) as { signal_embeddings: string | null } | undefined;
        let matchedSignalText = '';
        try {
          const vecs = JSON.parse(products?.signal_embeddings || '[]') as Array<{ text: string }>;
          if (vecs.length) matchedSignalText = vecs[0].text; // best-effort; not critical for triage
        } catch {}
        const decision = await triageItem(item, pb.product, pb.brand, matchedSignalText);
        const newStatus =
          decision.decision === 'strong'
            ? 'triaged_strong'
            : decision.decision === 'weak'
              ? 'triaged_weak'
              : 'triaged_rejected';
        db.prepare(
          `UPDATE signal_items
           SET status = ?, triage_result = ?, triage_confidence = ?, processed_at = datetime('now')
           WHERE id = ?`
        ).run(newStatus, JSON.stringify(decision), decision.confidence, item.id);
        log(
          `triage ${item.id} → ${decision.decision} (${decision.confidence.toFixed(2)}): ${decision.reason}`
        );
      } catch (e: any) {
        db.prepare(
          "UPDATE signal_items SET status = 'error', error = ?, processed_at = datetime('now') WHERE id = ?"
        ).run(String(e?.message || e).slice(0, 500), item.id);
        log(`triage error ${item.id}: ${e?.message || e}`);
      }
    }
  }

  // Stage 4: Perplexity deep qualify on triaged_strong
  if (settings.perplexityApiKey) {
    const strong = db
      .prepare(
        "SELECT * FROM signal_items WHERE status = 'triaged_strong' ORDER BY triage_confidence DESC, id ASC LIMIT ?"
      )
      .all(MAX_PER_CYCLE) as SignalItem[];
    for (const item of strong) {
      try {
        const pb = item.best_match_product_id ? loadProductAndBrand(item.best_match_product_id) : null;
        if (!pb) {
          db.prepare(
            "UPDATE signal_items SET status = 'error', error = 'product/brand vanished' WHERE id = ?"
          ).run(item.id);
          continue;
        }
        const products = db
          .prepare('SELECT signal_embeddings FROM products WHERE id = ?')
          .get(pb.product.id) as { signal_embeddings: string | null } | undefined;
        let matchedSignalText = '';
        try {
          const vecs = JSON.parse(products?.signal_embeddings || '[]') as Array<{ text: string }>;
          if (vecs.length) matchedSignalText = vecs[0].text;
        } catch {}
        const outcome = await qualifyItem(item, pb.product, pb.brand, matchedSignalText);
        if (outcome.kind === 'opportunity') {
          db.prepare(
            `UPDATE signal_items SET status = 'qualified', opportunity_id = ?, processed_at = datetime('now') WHERE id = ?`
          ).run(outcome.opportunityId, item.id);
          log(`qualify ${item.id} → opportunity #${outcome.opportunityId} (${outcome.confidence.toFixed(2)})`);
          maybeNotify(item, pb.product.name, pb.brand.name, outcome.opportunityId, outcome.confidence);
        } else {
          db.prepare(
            "UPDATE signal_items SET status = 'triaged_rejected', error = ?, processed_at = datetime('now') WHERE id = ?"
          ).run(outcome.reason.slice(0, 500), item.id);
          log(`qualify ${item.id} → rejected (${outcome.reason})`);
        }
      } catch (e: any) {
        db.prepare(
          "UPDATE signal_items SET status = 'error', error = ?, processed_at = datetime('now') WHERE id = ?"
        ).run(String(e?.message || e).slice(0, 500), item.id);
        log(`qualify error ${item.id}: ${e?.message || e}`);
      }
    }
  }
}

function maybeNotify(
  item: SignalItem,
  productName: string,
  brandName: string,
  opportunityId: number,
  confidence: number
) {
  const { notifyOnNewOpportunity } = getSettings();
  if (!notifyOnNewOpportunity) return;
  if (!Notification.isSupported()) return;
  try {
    const n = new Notification({
      title: `LeadsHawk · ${brandName} / ${productName}`,
      body: `${item.title} (${Math.round(confidence * 100)}% confidence)`,
      silent: false
    });
    n.on('click', () => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        if (!win.isVisible()) win.show();
        win.focus();
        win.webContents.send('navigate', { kind: 'opportunity', id: opportunityId });
      }
    });
    n.show();
  } catch {
    // ignore
  }
}

/**
 * v1.7 — Process ONE specific signal_item all the way through the funnel
 * (embed → triage → qualify) synchronously, so the manual-intake IPC can
 * give the user immediate feedback rather than waiting for the next 30s
 * cycle. Returns the final state for the caller to surface.
 */
export type IntakeOutcome =
  | { kind: 'filtered'; reason: string; similarity: number }
  | { kind: 'triaged'; decision: 'rejected' | 'weak'; reason: string; similarity: number }
  | { kind: 'qualified'; opportunityId: number; confidence: number }
  | { kind: 'error'; error: string };

export async function processSingleItem(itemId: number): Promise<IntakeOutcome> {
  const settings = getSettings();
  const db = getDb();
  const item = db
    .prepare('SELECT * FROM signal_items WHERE id = ?')
    .get(itemId) as SignalItem | undefined;
  if (!item) return { kind: 'error', error: 'item not found' };

  try {
    // Stage 2: embed + match
    const text = [item.title, item.snippet].filter(Boolean).join(' — ');
    const match = await bestProductMatch(text);
    if (!match) {
      db.prepare(
        "UPDATE signal_items SET status = 'filtered', error = 'no scan-enabled product with embeddings', processed_at = datetime('now') WHERE id = ?"
      ).run(itemId);
      return { kind: 'filtered', reason: 'no scan-enabled product with signal embeddings', similarity: 0 };
    }
    const passed = match.similarity >= settings.embedSimilarityThreshold;
    db.prepare(
      `UPDATE signal_items
       SET status = ?, best_match_product_id = ?, best_match_similarity = ?, processed_at = datetime('now')
       WHERE id = ?`
    ).run(passed ? 'candidate' : 'filtered', match.productId, match.similarity, itemId);
    if (!passed) {
      return {
        kind: 'filtered',
        reason: `pre-filter similarity ${match.similarity.toFixed(2)} below threshold ${settings.embedSimilarityThreshold}`,
        similarity: match.similarity
      };
    }

    // Stage 3: triage
    if (!settings.anthropicApiKey) {
      return { kind: 'error', error: 'Anthropic API key not configured — triage cannot run.' };
    }
    const pb = loadProductAndBrand(match.productId);
    if (!pb) return { kind: 'error', error: 'matched product/brand vanished' };
    const decision = await triageItem(
      { ...item, best_match_similarity: match.similarity } as any,
      pb.product,
      pb.brand,
      match.matchedSignal
    );
    const triagedStatus =
      decision.decision === 'strong' ? 'triaged_strong'
      : decision.decision === 'weak' ? 'triaged_weak'
      : 'triaged_rejected';
    db.prepare(
      `UPDATE signal_items
       SET status = ?, triage_result = ?, triage_confidence = ?, processed_at = datetime('now')
       WHERE id = ?`
    ).run(triagedStatus, JSON.stringify(decision), decision.confidence, itemId);
    if (decision.decision !== 'strong') {
      return { kind: 'triaged', decision: decision.decision, reason: decision.reason, similarity: match.similarity };
    }

    // Stage 4: qualify
    if (!settings.perplexityApiKey) {
      return { kind: 'error', error: 'Perplexity API key not configured — qualify cannot run.' };
    }
    const fresh = db.prepare('SELECT * FROM signal_items WHERE id = ?').get(itemId) as SignalItem;
    const outcome = await qualifyItem(fresh, pb.product, pb.brand, match.matchedSignal);
    if (outcome.kind === 'opportunity') {
      db.prepare(
        `UPDATE signal_items SET status = 'qualified', opportunity_id = ?, processed_at = datetime('now') WHERE id = ?`
      ).run(outcome.opportunityId, itemId);
      maybeNotify(item, pb.product.name, pb.brand.name, outcome.opportunityId, outcome.confidence);
      return { kind: 'qualified', opportunityId: outcome.opportunityId, confidence: outcome.confidence };
    }
    db.prepare(
      "UPDATE signal_items SET status = 'triaged_rejected', error = ?, processed_at = datetime('now') WHERE id = ?"
    ).run(outcome.reason.slice(0, 500), itemId);
    return { kind: 'triaged', decision: 'rejected', reason: outcome.reason, similarity: match.similarity };
  } catch (e: any) {
    const msg = String(e?.message || e).slice(0, 500);
    db.prepare(
      "UPDATE signal_items SET status = 'error', error = ?, processed_at = datetime('now') WHERE id = ?"
    ).run(msg, itemId);
    return { kind: 'error', error: msg };
  }
}

export function getMonitorStatus(): MonitorStatus {
  const db = getDb();
  const sourcesCount = (db.prepare('SELECT COUNT(*) AS c FROM monitor_sources').get() as any).c as number;
  const enabledCount = (db.prepare('SELECT COUNT(*) AS c FROM monitor_sources WHERE enabled = 1').get() as any).c as number;
  const ed = embedderState();
  const counts = db.prepare(`
    SELECT
      SUM(CASE WHEN datetime(fetched_at) >= datetime('now','-1 day') THEN 1 ELSE 0 END) AS ingested,
      SUM(CASE WHEN status IN ('candidate','triaged_strong','triaged_weak','triaged_rejected','qualified') AND datetime(fetched_at) >= datetime('now','-1 day') THEN 1 ELSE 0 END) AS candidates,
      SUM(CASE WHEN status IN ('triaged_strong','qualified') AND datetime(fetched_at) >= datetime('now','-1 day') THEN 1 ELSE 0 END) AS triagedStrong,
      SUM(CASE WHEN status = 'qualified' AND datetime(fetched_at) >= datetime('now','-1 day') THEN 1 ELSE 0 END) AS qualified
    FROM signal_items
  `).get() as any;
  return {
    running,
    sources: sourcesCount,
    enabledSources: enabledCount,
    embedderReady: ed.state === 'ready',
    embedderState: ed.state,
    embedderError: ed.error,
    last24h: {
      ingested: Number(counts?.ingested || 0),
      candidates: Number(counts?.candidates || 0),
      triagedStrong: Number(counts?.triagedStrong || 0),
      qualified: Number(counts?.qualified || 0)
    }
  };
}
