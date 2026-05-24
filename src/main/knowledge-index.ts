/**
 * v1.6 — Real knowledge indexing.
 *
 * Until now, knowledge_items.status='indexed' was a misnomer — it only
 * meant "has at least 200 chars of content". This module makes the name
 * honest: every knowledge_item is chunked (~500 chars, ~50-char overlap),
 * each chunk is embedded on-device via the existing MiniLM model (free),
 * and stored in `knowledge_chunks` for retrieval at scan time.
 *
 * Used by:
 *  - The cast-nets engine (manual + deep scans) to retrieve top-K
 *    knowledge chunks per product as scan prompt context.
 *  - Brand research as supporting material when the raw knowledge is
 *    too large to fit in the prompt verbatim.
 */

import { getDb } from './db.js';
import { embedText, cosineSim } from './monitor/embed.js';
import type { KnowledgeItem } from '@shared/types';

const CHUNK_SIZE = 500;
const CHUNK_OVERLAP = 50;
const MAX_CHARS_PER_ITEM = 60_000; // hard cap so a single huge doc can't lock the embedder

/**
 * Split text into roughly CHUNK_SIZE-char chunks at sentence/paragraph
 * boundaries when possible, with CHUNK_OVERLAP characters of overlap so
 * concepts that span boundaries are still retrievable.
 */
export function chunkText(raw: string): string[] {
  const text = (raw || '').replace(/\r\n/g, '\n').trim();
  if (!text) return [];
  const limited = text.length > MAX_CHARS_PER_ITEM ? text.slice(0, MAX_CHARS_PER_ITEM) : text;
  const chunks: string[] = [];
  let i = 0;
  while (i < limited.length) {
    let end = Math.min(i + CHUNK_SIZE, limited.length);
    // Prefer to break at the nearest paragraph / sentence end before `end`.
    if (end < limited.length) {
      const slice = limited.slice(i, end);
      const para = slice.lastIndexOf('\n\n');
      const sent = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '));
      const breakAt = para > CHUNK_SIZE * 0.5 ? para + 2
                    : sent > CHUNK_SIZE * 0.5 ? sent + 2
                    : -1;
      if (breakAt > 0) end = i + breakAt;
    }
    const chunk = limited.slice(i, end).trim();
    if (chunk.length > 0) chunks.push(chunk);
    if (end >= limited.length) break;
    i = end - CHUNK_OVERLAP;
    if (i < 0) i = 0;
  }
  return chunks;
}

/**
 * Embed the item's content into the knowledge_chunks table. Idempotent:
 * deletes any existing chunks for the item first. Safe to call repeatedly.
 *
 * Called fire-and-forget from every knowledge insert path; failures are
 * logged but don't bubble up (so a bad embedder state doesn't block uploads).
 */
export async function chunkAndEmbedKnowledgeItem(itemId: number): Promise<void> {
  const db = getDb();
  const item = db.prepare('SELECT * FROM knowledge_items WHERE id = ?').get(itemId) as KnowledgeItem | undefined;
  if (!item) return;
  if (!item.content || item.content.length < 50) {
    // Nothing meaningful to embed — but flag as indexed so the backfill
    // doesn't keep retrying.
    db.prepare("UPDATE knowledge_items SET indexed_at = datetime('now') WHERE id = ?").run(itemId);
    return;
  }

  // Clear existing chunks (re-indexing an updated item).
  db.prepare('DELETE FROM knowledge_chunks WHERE item_id = ?').run(itemId);

  const chunks = chunkText(item.content);
  if (chunks.length === 0) {
    db.prepare("UPDATE knowledge_items SET indexed_at = datetime('now') WHERE id = ?").run(itemId);
    return;
  }

  const insert = db.prepare(
    'INSERT INTO knowledge_chunks(item_id, ord, text, embedding) VALUES (?, ?, ?, ?)'
  );
  for (let ord = 0; ord < chunks.length; ord++) {
    try {
      const vec = await embedText(chunks[ord]);
      insert.run(itemId, ord, chunks[ord], JSON.stringify(vec));
    } catch (e: any) {
      console.warn(`[knowledge-index] chunk ${ord} of item ${itemId} failed:`, e?.message || e);
      // keep going — partial indexing is better than zero
    }
  }
  db.prepare("UPDATE knowledge_items SET indexed_at = datetime('now') WHERE id = ?").run(itemId);
}

export type RetrievedChunk = {
  itemId: number;
  itemTitle: string;
  itemKind: 'file' | 'link' | 'note';
  itemSource: string;
  text: string;
  similarity: number;
};

/**
 * Retrieve top-K most relevant knowledge chunks for a query, scoped to a
 * brand (and optionally favouring a specific product's chunks).
 *
 * If no chunks exist for the brand at all, returns []; the caller falls
 * back to existing dossier-only context.
 */
export async function retrieveRelevantChunks(
  query: string,
  brandId: number,
  productId: number | null,
  k = 5
): Promise<RetrievedChunk[]> {
  if (!query || !query.trim()) return [];
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT c.text, c.embedding, i.id AS item_id, i.title AS item_title, i.kind AS item_kind,
              i.source AS item_source, i.product_id
       FROM knowledge_chunks c
       JOIN knowledge_items i ON i.id = c.item_id
       WHERE i.brand_id = ?`
    )
    .all(brandId) as Array<{
      text: string;
      embedding: string;
      item_id: number;
      item_title: string;
      item_kind: 'file' | 'link' | 'note';
      item_source: string;
      product_id: number | null;
    }>;
  if (rows.length === 0) return [];

  let queryVec: number[];
  try {
    queryVec = await embedText(query);
  } catch (e: any) {
    console.warn('[knowledge-index] embed query failed:', e?.message || e);
    return [];
  }

  const scored = rows.map((r) => {
    let v: number[] = [];
    try { v = JSON.parse(r.embedding); } catch { /* skip */ }
    let sim = v.length ? cosineSim(queryVec, v) : 0;
    // Small bonus for chunks scoped to the target product so they win ties.
    if (productId && r.product_id === productId) sim += 0.02;
    return { row: r, similarity: sim };
  });
  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, k).map((s) => ({
    itemId: s.row.item_id,
    itemTitle: s.row.item_title,
    itemKind: s.row.item_kind,
    itemSource: s.row.item_source,
    text: s.row.text,
    similarity: s.similarity
  }));
}

/**
 * Render retrieved chunks as a prompt-ready block.
 */
export function renderChunksBlock(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) return '';
  const lines = chunks.map((c, i) =>
    `### Snippet ${i + 1} — ${c.itemTitle} (${c.itemKind}; sim=${c.similarity.toFixed(2)})\n${c.text}`
  );
  return [
    '# Retrieved knowledge (most relevant excerpts from our uploaded files / links / notes)',
    'Use these as foundational context about who we are and how we sell. They are the user\'s own material — trust them.',
    '',
    ...lines
  ].join('\n');
}

/**
 * Background backfill — runs once on app boot. Embeds any knowledge_items
 * that have content but no chunks yet. Throttled to one at a time so the
 * MiniLM doesn't get hammered while the user's also using it from the
 * Live Monitor pre-filter.
 */
export async function backfillKnowledgeIndex(log?: (m: string) => void): Promise<void> {
  const db = getDb();
  const pending = db
    .prepare(
      `SELECT id FROM knowledge_items
       WHERE indexed_at IS NULL
         AND content IS NOT NULL
         AND length(content) >= 50
       ORDER BY id DESC
       LIMIT 500`
    )
    .all() as Array<{ id: number }>;
  if (pending.length === 0) return;
  log?.(`[backfill] embedding ${pending.length} knowledge item(s)…`);
  for (const row of pending) {
    try {
      await chunkAndEmbedKnowledgeItem(row.id);
    } catch (e: any) {
      console.warn(`[backfill] item ${row.id} failed:`, e?.message || e);
    }
  }
  log?.(`[backfill] done.`);
}
