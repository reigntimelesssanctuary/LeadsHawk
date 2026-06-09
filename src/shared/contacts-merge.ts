/**
 * v1.19.0 — Smart-replace logic for contacts:search.
 *
 * When the operator clicks "Re-search" on an opp that has previously
 * been searched, we want to:
 *   - Preserve contacts in any non-pending state (drafted, sent,
 *     skipped, replied, bounced, etc.) — these represent decisions
 *     and outcomes the operator owns.
 *   - Replace pending contacts (just-discovered, no action taken) with
 *     the fresh search results.
 *   - Dedup by apollo_id so the same person doesn't appear twice when
 *     they're surfaced by both the old and new searches.
 *   - Continue hunt_rank numbering from max(existing) + 1 for new
 *     contacts so ordering is stable across operator views.
 *
 * Pure function — exported for smoke testing. The IPC orchestrator
 * (src/main/contact-search.ts) calls this then translates the result
 * into INSERT / DELETE statements within a single transaction.
 */

export type MergeContactRow = {
  /** DB id if existing; null for fresh-from-Apollo. */
  id: number | null;
  apollo_id: string | null;
  contact_status: string;
  hunt_rank: number;
};

export type MergePlanItem<T extends MergeContactRow> =
  | { kind: 'keep'; row: T }                        // existing row, unchanged
  | { kind: 'insert'; row: T }                      // brand-new contact to persist
  | { kind: 'delete'; id: number };                 // pending row no longer in fresh results

export type MergeStats = {
  preserved: number;       // count of non-pending rows kept
  insertedNew: number;     // count of new rows inserted
  removedPending: number;  // count of pending rows deleted
  dedupedByApollo: number; // count of fresh rows merged into existing (no insert needed)
};

export type SmartReplaceResult<T extends MergeContactRow> = {
  plan: MergePlanItem<T>[];
  stats: MergeStats;
};

const PENDING_STATUS = 'pending';

/**
 * Compute the merge plan. Caller applies it to the DB inside a
 * transaction. Pure function — does not touch the DB.
 *
 * @param existing  current contacts attached to the opportunity
 * @param fresh     newly-ranked Apollo results from the latest search
 */
export function planSmartReplace<T extends MergeContactRow>(
  existing: T[],
  fresh: T[]
): SmartReplaceResult<T> {
  const plan: MergePlanItem<T>[] = [];
  let preserved = 0;
  let insertedNew = 0;
  let removedPending = 0;
  let dedupedByApollo = 0;

  // Index existing by apollo_id so fresh results with the same id are
  // recognised as "already present" rather than re-inserted.
  const existingByApollo = new Map<string, T>();
  for (const row of existing) {
    if (row.apollo_id) existingByApollo.set(row.apollo_id, row);
  }

  // Find the highest hunt_rank in existing non-pending rows so we can
  // start new contacts after them.
  let maxRankPreserved = 0;
  for (const row of existing) {
    if (row.contact_status !== PENDING_STATUS) {
      maxRankPreserved = Math.max(maxRankPreserved, row.hunt_rank);
    }
  }

  // ─── 1. Preserve non-pending existing rows. ────────────────────
  for (const row of existing) {
    if (row.contact_status !== PENDING_STATUS) {
      plan.push({ kind: 'keep', row });
      preserved++;
    }
  }

  // ─── 2. Delete pending rows NOT present in fresh by apollo_id. ─
  // Pending rows that ARE in fresh would be redundant to delete-then-insert;
  // we keep them (they're effectively a re-confirmation of the same person).
  const freshApolloIds = new Set(
    fresh.map((f) => f.apollo_id).filter((id): id is string => Boolean(id))
  );
  for (const row of existing) {
    if (row.contact_status === PENDING_STATUS) {
      if (row.apollo_id && freshApolloIds.has(row.apollo_id)) {
        // Apollo returned this person again — keep the existing row.
        plan.push({ kind: 'keep', row });
        dedupedByApollo++;
      } else {
        plan.push({ kind: 'delete', id: row.id! });
        removedPending++;
      }
    }
  }

  // ─── 3. Insert fresh rows that aren't already present. ─────────
  // Rank starts at maxRankPreserved + 1; ties broken by fresh's incoming
  // order (which is already score-descending from rankContacts).
  let nextRank = maxRankPreserved + 1;
  for (const row of fresh) {
    if (row.apollo_id && existingByApollo.has(row.apollo_id)) {
      // Already present (either preserved non-pending or kept-pending above);
      // do not insert. Already counted in preserved or dedupedByApollo.
      continue;
    }
    plan.push({ kind: 'insert', row: { ...row, hunt_rank: nextRank } });
    insertedNew++;
    nextRank++;
  }

  return {
    plan,
    stats: { preserved, insertedNew, removedPending, dedupedByApollo }
  };
}
