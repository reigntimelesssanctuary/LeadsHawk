import { app } from 'electron';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { getDb } from '../db.js';
import type { Product } from '@shared/types';

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

let extractor: any = null;
let state: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
let lastError: string | null = null;
let loadPromise: Promise<void> | null = null;

export function embedderState() {
  return { state, error: lastError };
}

export async function ensureEmbedder(): Promise<void> {
  if (state === 'ready' && extractor) return;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    state = 'loading';
    lastError = null;
    try {
      const cacheDir = join(app.getPath('userData'), 'transformers-cache');
      mkdirSync(cacheDir, { recursive: true });
      const tf: any = await import('@huggingface/transformers');
      // Cache model files under userData so packaging is fine.
      tf.env.cacheDir = cacheDir;
      tf.env.allowLocalModels = false;
      tf.env.useBrowserCache = false;
      extractor = await tf.pipeline('feature-extraction', MODEL_ID);
      state = 'ready';
    } catch (e: any) {
      state = 'error';
      lastError = e?.message || String(e);
      extractor = null;
      throw e;
    } finally {
      loadPromise = null;
    }
  })();
  return loadPromise;
}

export async function embedText(text: string): Promise<number[]> {
  await ensureEmbedder();
  const cleaned = (text || '').replace(/\s+/g, ' ').trim().slice(0, 512);
  const out = await extractor(cleaned, { pooling: 'mean', normalize: true });
  // Tensor → JS array
  const data: Float32Array = out.data;
  return Array.from(data);
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  await ensureEmbedder();
  const out: number[][] = [];
  for (const t of texts) out.push(await embedText(t));
  return out;
}

export function cosineSim(a: number[], b: number[]): number {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Parse a product's signals bullet list into individual lines.
 */
export function parseProductSignals(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => l.replace(/^[-*•]\s*/, '').trim())
    .filter((l) => l.length > 0);
}

type SignalVector = { text: string; embedding: number[] };

export async function embedSignalsForProduct(productId: number): Promise<SignalVector[]> {
  const db = getDb();
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId) as Product | undefined;
  if (!product) return [];
  const bullets = parseProductSignals(product.signals);
  if (bullets.length === 0) {
    db.prepare(
      "UPDATE products SET signal_embeddings = NULL, updated_at = datetime('now') WHERE id = ?"
    ).run(productId);
    return [];
  }
  const vectors: SignalVector[] = [];
  for (const text of bullets) {
    const embedding = await embedText(text);
    vectors.push({ text, embedding });
  }
  db.prepare(
    "UPDATE products SET signal_embeddings = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(JSON.stringify(vectors), productId);
  return vectors;
}

export function loadCachedSignalsForProduct(productId: number): SignalVector[] {
  const db = getDb();
  const row = db
    .prepare('SELECT signal_embeddings FROM products WHERE id = ?')
    .get(productId) as { signal_embeddings: string | null } | undefined;
  if (!row || !row.signal_embeddings) return [];
  try {
    return JSON.parse(row.signal_embeddings) as SignalVector[];
  } catch {
    return [];
  }
}

/**
 * Ensure every researched scan-enabled product (whose brand is also enabled)
 * has embeddings cached. Called when the monitor starts.
 */
export async function ensureAllProductEmbeddings(log?: (m: string) => void): Promise<void> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT p.id, p.signal_embeddings, p.signals
       FROM products p
       JOIN brands b ON b.id = p.brand_id
       WHERE p.research_status = 'ready'
         AND p.scan_enabled = 1
         AND b.scan_enabled = 1
         AND p.signals IS NOT NULL
         AND length(trim(p.signals)) > 0`
    )
    .all() as Array<{ id: number; signal_embeddings: string | null; signals: string }>;

  for (const r of rows) {
    const bullets = parseProductSignals(r.signals);
    let cached: SignalVector[] = [];
    if (r.signal_embeddings) {
      try {
        cached = JSON.parse(r.signal_embeddings) as SignalVector[];
      } catch {
        cached = [];
      }
    }
    // Skip if cached set already covers current bullets
    const cachedTexts = new Set(cached.map((v) => v.text));
    const allCovered = bullets.every((b) => cachedTexts.has(b));
    if (allCovered && cached.length === bullets.length) continue;

    log?.(`embedding signals for product #${r.id}`);
    await embedSignalsForProduct(r.id);
  }
}

export type ProductMatch = {
  productId: number;
  brandId: number;
  similarity: number;          // post-penalty (used by the threshold gate)
  rawSimilarity: number;       // pre-penalty (for logging / debugging)
  disqualifyPenalty: number;   // 0 = none, 1 = full kill
  matchedSignal: string;
};

const DISQ_LEARNING_MIN_EXAMPLES = 3;
// Penalty curve: when item's max similarity to a disqualified example is
// above this threshold, scale the raw similarity down.
const DISQ_PENALTY_THRESHOLD = 0.70;
const DISQ_PENALTY_STRENGTH = 0.60;  // multiplier applied to the over-threshold similarity

/**
 * Compute the disqualification penalty for an item against a specific
 * product's past rejections. Returns a value in [0, 1]:
 *   0   = no penalty, this item looks nothing like past rejections
 *   1   = full kill, this item is nearly identical to something the user rejected
 *
 * Gated by DISQ_LEARNING_MIN_EXAMPLES so it doesn't fire on noise.
 * Caller may decide what to do with the value (we scale the similarity).
 */
function disqualifyPenalty(itemVec: number[], productId: number): number {
  const db = getDb();
  const rows = db
    .prepare('SELECT embedding FROM disqualify_vectors WHERE product_id = ?')
    .all(productId) as Array<{ embedding: string }>;
  if (rows.length < DISQ_LEARNING_MIN_EXAMPLES) return 0;
  let maxSim = 0;
  for (const r of rows) {
    let vec: number[];
    try { vec = JSON.parse(r.embedding); } catch { continue; }
    const s = cosineSim(itemVec, vec);
    if (s > maxSim) maxSim = s;
  }
  if (maxSim < DISQ_PENALTY_THRESHOLD) return 0;
  // Map [0.70, 1.0] → [0, 1] linearly, then dampen by strength constant.
  const over = (maxSim - DISQ_PENALTY_THRESHOLD) / (1 - DISQ_PENALTY_THRESHOLD);
  return Math.min(1, over * DISQ_PENALTY_STRENGTH);
}

/**
 * Score a signal item against every researched product. Returns the best match,
 * or null if no product has embeddings. The returned `similarity` is the raw
 * signal-match score scaled down by any disqualification penalty (Layer B).
 */
export async function bestProductMatch(itemText: string): Promise<ProductMatch | null> {
  const db = getDb();
  const products = db
    .prepare(
      `SELECT p.id AS productId, p.brand_id AS brandId, p.signal_embeddings
       FROM products p
       JOIN brands b ON b.id = p.brand_id
       WHERE p.research_status = 'ready'
         AND p.scan_enabled = 1
         AND b.scan_enabled = 1
         AND p.signal_embeddings IS NOT NULL`
    )
    .all() as Array<{ productId: number; brandId: number; signal_embeddings: string }>;
  if (products.length === 0) return null;

  const itemVec = await embedText(itemText);
  type RawBest = { productId: number; brandId: number; raw: number; matchedSignal: string };
  let raw: RawBest | null = null;
  for (const p of products) {
    let vectors: SignalVector[] = [];
    try {
      vectors = JSON.parse(p.signal_embeddings);
    } catch {
      continue;
    }
    for (const v of vectors) {
      const sim = cosineSim(itemVec, v.embedding);
      if (!raw || sim > raw.raw) {
        raw = {
          productId: p.productId,
          brandId: p.brandId,
          raw: sim,
          matchedSignal: v.text
        };
      }
    }
  }
  if (!raw) return null;

  const penalty = disqualifyPenalty(itemVec, raw.productId);
  const adjusted = raw.raw * (1 - penalty);
  return {
    productId: raw.productId,
    brandId: raw.brandId,
    similarity: adjusted,
    rawSimilarity: raw.raw,
    disqualifyPenalty: penalty,
    matchedSignal: raw.matchedSignal
  };
}

/**
 * Store a fingerprint for a disqualified opportunity so future similar items
 * get penalized in `bestProductMatch`. Fire-and-forget from the IPC handler;
 * any embedding failure is swallowed so it can't block the disqualify itself.
 */
export async function recordDisqualifyVector(
  productId: number,
  headline: string,
  reason: string | null,
  summary: string | null
): Promise<void> {
  const db = getDb();
  const text = [headline, summary || ''].filter(Boolean).join(' — ').trim();
  if (!text) return;
  try {
    const vec = await embedText(text);
    db.prepare(
      `INSERT INTO disqualify_vectors(product_id, headline, reason, embedding)
       VALUES (?, ?, ?, ?)`
    ).run(productId, headline, reason || null, JSON.stringify(vec));
  } catch (e: any) {
    console.warn('[recordDisqualifyVector] embed failed:', e?.message || e);
  }
}
