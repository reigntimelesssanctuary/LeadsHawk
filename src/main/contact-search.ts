/**
 * v1.19.0 — contact-search orchestrator.
 *
 * Owns the Stage 1 (archetype) → Stage 2 (Apollo) → Stage 3 (rank +
 * persist) pipeline triggered by the operator clicking "Search contacts"
 * on the Dashboard (single or bulk).
 *
 * Smart-replace semantics on re-search (see src/shared/contacts-merge.ts):
 *   - Existing contacts in any non-pending state (drafted, sent, skipped,
 *     replied, bounced, etc.) are preserved.
 *   - Existing contacts in 'pending' state are replaced unless Apollo
 *     surfaces the same apollo_id again (in which case kept as-is).
 *   - New contacts are inserted with hunt_rank continuing from the
 *     highest preserved rank.
 *
 * Failure handling — every search writes a contact_searches audit row
 * regardless of outcome, so the operator always has a record of what
 * happened. Opportunity's hunt_status reflects the latest run.
 */

import { getDb } from './db.js';
import { deriveArchetype } from './contact-archetype.js';
import { searchPeople, enrichPersonByApolloId, normaliseSeniority, type ApolloPerson } from './apollo.js';
import { rankContacts, HUNT_MIN_CONTACTS, HUNT_MAX_CONTACTS } from '@shared/hunt.js';
import { planSmartReplace, type MergeContactRow } from '@shared/contacts-merge.js';
import type {
  Brand, Product, Opportunity, Contact, ContactArchetype, ApolloSeniority
} from '@shared/types';

export type SearchOutcome = {
  oppId: number;
  status: 'hunted' | 'no_contacts' | 'search_failed';
  contactsFound: number;
  preservedCount: number;
  insertedCount: number;
  removedCount: number;
  apolloCredits: number;
  error: string | null;
};

/**
 * Run the full contact-search pipeline for one opportunity. Always
 * writes a contact_searches audit row and updates opportunities.hunt_status.
 * Returns a structured outcome for the UI to render.
 */
export async function searchContactsForOpportunity(oppId: number): Promise<SearchOutcome> {
  const db = getDb();
  const opp = db.prepare('SELECT * FROM opportunities WHERE id = ?').get(oppId) as Opportunity | undefined;
  if (!opp) {
    return zero(oppId, 'search_failed', 0, 'Opportunity not found');
  }
  const brand = opp.brand_id
    ? (db.prepare('SELECT * FROM brands WHERE id = ?').get(opp.brand_id) as Brand | undefined)
    : undefined;
  const product = opp.product_id
    ? (db.prepare('SELECT * FROM products WHERE id = ?').get(opp.product_id) as Product | undefined)
    : undefined;
  if (!brand || !product) {
    setHuntStatus(oppId, 'search_failed');
    return zero(oppId, 'search_failed', 0, 'Opportunity is missing brand/product attribution');
  }

  // Mark in-flight so the Dashboard chip can render 'searching…'
  setHuntStatus(oppId, 'searching');

  // ─── Stage 1 — Archetype reasoning ──────────────────────────────
  const arch = await deriveArchetype(brand, product, opp);
  // Open the audit row immediately so failures still leave a record.
  const insAudit = db.prepare(`
    INSERT INTO contact_searches (opportunity_id, archetype_json, reasoning, run_status)
    VALUES (?, ?, ?, 'pending')
  `).run(
    oppId,
    JSON.stringify(arch.archetype),
    arch.archetype.reasoning || null
  );
  const searchId = Number(insAudit.lastInsertRowid);

  // ─── Stage 2 — Apollo search ────────────────────────────────────
  let apolloPeople: ApolloPerson[] = [];
  let apolloCredits = 0;
  try {
    const r = await searchPeople(opp.company, arch.archetype);
    apolloPeople = r.people;
    apolloCredits = r.creditsUsed;
  } catch (e: any) {
    const err = String(e?.message || e).slice(0, 300);
    db.prepare(`
      UPDATE contact_searches
         SET contacts_found = 0, apollo_credits = 0, run_status = 'search_failed'
       WHERE id = ?
    `).run(searchId);
    setHuntStatus(oppId, 'search_failed');
    return zero(oppId, 'search_failed', 0, err);
  }

  // ─── Stage 3 — Pass-1 rank (title-only) → Enrich top N → Re-rank ───
  // Apollo's /mixed_people/api_search returns LIGHT records (name, title,
  // sometimes LinkedIn) — no email, often no seniority/department. The
  // enrichment endpoint (/people/match) is a separate billed call. So we:
  //   a. Score the api_search results by title alone (archetype_title is
  //      the only component that works on light data — seniority/dept
  //      will be 0 since Apollo didn't return them).
  //   b. Pick top HUNT_MAX_CONTACTS by that pass-1 score.
  //   c. Enrich each in parallel — fills in email + seniority + dept.
  //   d. Re-rank those enriched contacts so the persisted order reflects
  //      the full data the operator will actually see.
  const signalText = [opp.signal_summary, opp.headline].filter(Boolean).join(' — ');
  const allRankable = apolloPeople.map(toRankable);
  const pass1Ranked = rankContacts(allRankable, arch.archetype, signalText);

  // Enrich the top N in parallel — 1 Apollo credit each. The
  // recordApolloSpend call inside enrichPersonByApolloId logs each into
  // api_calls so Cost Management surfaces the total.
  const enrichTargets = pass1Ranked.slice(0, HUNT_MAX_CONTACTS);
  const enrichResults = await Promise.all(
    enrichTargets.map((c) =>
      c.apollo_id
        ? enrichPersonByApolloId(c.apollo_id, null)
        : Promise.resolve({ person: null, error: 'no apollo_id' })
    )
  );
  apolloCredits += enrichResults.filter((r) => r.person).length;

  // Merge enriched fields onto the rankable rows, preserving the row's
  // identity. Anything enrich didn't fill stays at its pass-1 value.
  const enrichedRankable = enrichTargets.map((c, i) => {
    const enriched = enrichResults[i].person;
    if (!enriched) {
      // Log the per-contact enrich failure into the search log; the row
      // still gets persisted with whatever pass-1 had.
      return c;
    }
    return {
      ...c,
      // Override only fields enrichment actually filled.
      title: enriched.title ?? c.title,
      seniority: (normaliseSeniority(enriched.seniority) ?? c.seniority) as any,
      department:
        (Array.isArray((enriched as any).departments) && (enriched as any).departments.length > 0
          ? (enriched as any).departments[0]
          : null) ?? enriched.department ?? c.department,
      email: enriched.email ?? c.email,
      email_status: enriched.email_status ?? c.email_status,
      linkedin_url: enriched.linkedin_url ?? c.linkedin_url
    };
  });

  // Pass-2 rank on enriched data so the persisted order reflects what
  // the operator will see.
  const ranked = rankContacts(enrichedRankable, arch.archetype, signalText);

  // Fewer than HUNT_MIN_CONTACTS after ranking = no_contacts. Apollo may
  // have returned junk; not enough quality to declare success.
  if (ranked.length < HUNT_MIN_CONTACTS) {
    db.prepare(`
      UPDATE contact_searches
         SET contacts_found = ?, apollo_credits = ?, run_status = 'no_contacts'
       WHERE id = ?
    `).run(ranked.length, apolloCredits, searchId);
    setHuntStatus(oppId, 'no_contacts');
    return {
      oppId,
      status: 'no_contacts',
      contactsFound: ranked.length,
      preservedCount: 0,
      insertedCount: 0,
      removedCount: 0,
      apolloCredits,
      error: null
    };
  }

  // ─── Smart-replace plan ─────────────────────────────────────────
  const existing = db.prepare('SELECT * FROM contacts WHERE opportunity_id = ?').all(oppId) as Contact[];
  const freshAsMergeRows = ranked.map((r) => ({
    // Pre-merge: ids are null (about to be inserted), apollo_id and rank
    // come from the ranker, status is pending.
    id: null as number | null,
    apollo_id: r.apollo_id,
    contact_status: 'pending',
    hunt_rank: r.hunt_rank,
    // Carry the rest of the rankable row for the insert step.
    payload: r
  }));
  const existingForMerge: (MergeContactRow & { row: Contact })[] = existing.map((c) => ({
    id: c.id,
    apollo_id: c.apollo_id,
    contact_status: c.contact_status,
    hunt_rank: c.hunt_rank,
    row: c
  }));

  const { plan, stats } = planSmartReplace(existingForMerge, freshAsMergeRows);

  // Apply the plan in one transaction.
  const tx = db.transaction(() => {
    for (const item of plan) {
      if (item.kind === 'delete') {
        db.prepare('DELETE FROM contacts WHERE id = ?').run(item.id);
      } else if (item.kind === 'insert') {
        const p: any = (item.row as any).payload;
        db.prepare(`
          INSERT INTO contacts (
            opportunity_id, search_id, apollo_id, full_name, first_name, last_name,
            title, seniority, department, email, email_status, linkedin_url,
            hunt_rank, hunt_score, rank_components, contact_status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
        `).run(
          oppId,
          searchId,
          p.apollo_id,
          p.full_name,
          p.first_name ?? null,
          p.last_name ?? null,
          p.title ?? null,
          p.seniority ?? null,
          p.department ?? null,
          p.email ?? null,
          p.email_status ?? null,
          p.linkedin_url ?? null,
          item.row.hunt_rank,
          p.hunt_score,
          JSON.stringify(p.rank_components)
        );
      }
      // 'keep' is a no-op; existing rows already in DB.
    }
  });
  try {
    tx();
  } catch (e: any) {
    const err = String(e?.message || e).slice(0, 300);
    db.prepare(`
      UPDATE contact_searches
         SET contacts_found = 0, apollo_credits = ?, run_status = 'search_failed'
       WHERE id = ?
    `).run(apolloCredits, searchId);
    setHuntStatus(oppId, 'search_failed');
    return zero(oppId, 'search_failed', apolloCredits, `Persist error: ${err}`);
  }

  // ─── Audit + status update ──────────────────────────────────────
  const totalContacts = stats.preserved + stats.dedupedByApollo + stats.insertedNew;
  db.prepare(`
    UPDATE contact_searches
       SET contacts_found = ?, apollo_credits = ?, run_status = 'completed'
     WHERE id = ?
  `).run(totalContacts, apolloCredits, searchId);
  setHuntStatus(oppId, 'hunted');

  return {
    oppId,
    status: 'hunted',
    contactsFound: totalContacts,
    preservedCount: stats.preserved + stats.dedupedByApollo,
    insertedCount: stats.insertedNew,
    removedCount: stats.removedPending,
    apolloCredits,
    error: null
  };
}

/**
 * Bulk: run searchContactsForOpportunity sequentially over an array of
 * opp ids. Sequential (not parallel) because:
 *   - Apollo's rate limits are generous but we don't want a single bulk
 *     run to spike them.
 *   - LLM stage isolation: a Sonnet hiccup on opp #3 shouldn't
 *     interfere with opp #5's archetype call.
 *   - Operator sees deterministic progress.
 */
export async function searchContactsBatch(oppIds: number[]): Promise<SearchOutcome[]> {
  const out: SearchOutcome[] = [];
  for (const id of oppIds) {
    try {
      const result = await searchContactsForOpportunity(id);
      out.push(result);
    } catch (e: any) {
      out.push(zero(id, 'search_failed', 0, String(e?.message || e).slice(0, 300)));
    }
  }
  return out;
}

// ─── Helpers ─────────────────────────────────────────────────────

function setHuntStatus(oppId: number, status: string): void {
  const db = getDb();
  db.prepare('UPDATE opportunities SET hunt_status = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .run(status, oppId);
}

function zero(
  oppId: number,
  status: 'hunted' | 'no_contacts' | 'search_failed',
  apolloCredits: number,
  error: string | null
): SearchOutcome {
  return {
    oppId, status, contactsFound: 0,
    preservedCount: 0, insertedCount: 0, removedCount: 0,
    apolloCredits, error
  };
}

function toRankable(p: ApolloPerson) {
  const full_name = (p.name || `${p.first_name ?? ''} ${p.last_name ?? ''}`).trim() || '(unknown)';
  return {
    // Carry every field the persist step needs.
    apollo_id: p.id ?? null,
    full_name,
    first_name: p.first_name ?? null,
    last_name: p.last_name ?? null,
    title: p.title ?? null,
    seniority: (normaliseSeniority(p.seniority) as ApolloSeniority | null),
    department: p.department ?? null,
    email: p.email ?? null,
    email_status: p.email_status ?? null,
    linkedin_url: p.linkedin_url ?? null
  };
}
