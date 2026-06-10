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
import { findEmailViaHunter } from './hunter.js';
import { getSettings } from './settings.js';
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

  // ─── Stage 2 — Apollo search (strict) ───────────────────────────
  let apolloPeople: ApolloPerson[] = [];
  let apolloCredits = 0;
  // v1.20.0: capture the resolved domain so the Hunter fallback can reuse
  // it without burning a fresh Apollo credit on re-resolution.
  let resolvedDomain: string | null = null;
  try {
    const r = await searchPeople(opp.company, arch.archetype, 'strict');
    apolloPeople = r.people;
    apolloCredits = r.creditsUsed;
    resolvedDomain = r.resolvedDomain;
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

  // ─── Stage 2b — v1.19.6 loose-mode retry ─────────────────────────
  // When the strict org_id-scoped search returns thin (< HUNT_MIN_CONTACTS
  // before ranking), retry once with broader filters: drop the strict
  // org filter (use q_keywords with company stem), drop person_titles
  // (Sonnet archetype titles can be too narrow), keep person_seniorities.
  // Post-filter (orgNamesMatch) still drops genuinely-wrong companies.
  // Caps the additional credit spend to one extra search call.
  if (apolloPeople.length < HUNT_MIN_CONTACTS) {
    console.warn(`[contact-search] strict pass returned ${apolloPeople.length} people for "${opp.company}"; trying loose retry`);
    try {
      const looseR = await searchPeople(opp.company, arch.archetype, 'loose');
      // Merge loose results into the candidate pool, dedup by apollo_id.
      const existing = new Set(apolloPeople.map((p) => p.id).filter(Boolean) as string[]);
      const fresh = looseR.people.filter((p) => p.id && !existing.has(p.id));
      apolloPeople = [...apolloPeople, ...fresh];
      apolloCredits += looseR.creditsUsed;
      console.warn(`[contact-search] loose retry added ${fresh.length} candidates (${looseR.creditsUsed} credits)`);
    } catch (e: any) {
      console.warn(`[contact-search] loose retry failed (non-fatal): ${String(e?.message || e).slice(0, 200)}`);
      // Fall through with whatever strict gave us.
    }
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

  // ─── v1.20.0 — Hunter secondary email finder ────────────────────
  // For any contact still missing an email after Apollo enrichment,
  // try Hunter's Email Finder (name + domain). Only runs when:
  //   - Hunter API key configured
  //   - We have a domain (from Apollo's resolved org or extracted from
  //     the opp's source_url)
  //   - The contact has first_name + last_name (Hunter requires both)
  // Hunter only bills on success (verified), so misses are free credits.
  const settings = getSettings();
  // Hunter needs a real company domain — the opportunity's source_url is
  // usually a news-article URL, not the target company's domain, so we
  // can't fall back to it safely. Use Apollo's resolved primary_domain
  // only; if Apollo couldn't resolve the org's domain, Hunter has nothing
  // useful to query and we skip.
  const hunterDomain = resolvedDomain;
  if (settings.hunterApiKey && hunterDomain) {
    const needsHunter = enrichedRankable
      .map((c, i) => ({ c, i }))
      .filter((x) => !x.c.email && x.c.first_name && x.c.last_name);
    if (needsHunter.length > 0) {
      console.warn(`[contact-search] Apollo left ${needsHunter.length}/${enrichedRankable.length} without email; trying Hunter`);
      const hunterResults = await Promise.all(
        needsHunter.map((x) =>
          findEmailViaHunter(x.c.first_name as string, x.c.last_name as string, hunterDomain, null)
        )
      );
      let hunterFound = 0;
      for (let k = 0; k < needsHunter.length; k++) {
        const result = hunterResults[k].result;
        if (result?.email) {
          const target = needsHunter[k];
          enrichedRankable[target.i] = {
            ...enrichedRankable[target.i],
            email: result.email,
            email_status: (result.email_status as any) ?? 'unverified'
          };
          hunterFound++;
        }
      }
      console.warn(`[contact-search] Hunter found ${hunterFound}/${needsHunter.length} additional emails`);
    }
  } else if (!settings.hunterApiKey) {
    // Helpful signal in dev console — operator may not have configured
    // Hunter yet, in which case Apollo-only behaviour applies.
    const stillNull = enrichedRankable.filter((c) => !c.email).length;
    if (stillNull > 0) {
      console.warn(`[contact-search] ${stillNull} contact(s) without email; add Hunter API key in Settings to enable secondary email finder`);
    }
  }

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

  // v1.19.4: build an apollo_id → enriched-payload lookup so kept rows
  // also receive the refreshed email / seniority / department / status /
  // linkedin_url. The previous behaviour only wrote enrichment onto NEW
  // (insert) rows, so re-search on the same contacts kept stale data.
  // Smart-replace preserves drafts + status + rank by NOT touching those
  // columns; we only refresh the pure-data fields enrichment fills.
  const enrichedById = new Map<string, any>();
  for (const r of ranked) {
    if (r.apollo_id) enrichedById.set(r.apollo_id, r);
  }

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
      // 'keep' was previously a pure no-op. v1.19.4: still leave the
      // row's identity / status / hunt_rank / drafts untouched, but
      // REFRESH the pure-data fields enrichment fills (email,
      // email_status, seniority, department, title, linkedin_url).
      // Otherwise re-search burns credits without updating what the
      // operator sees, which is exactly the "still no email" symptom
      // after upgrading the Apollo plan.
      else if (item.kind === 'keep') {
        const row = (item.row as any).row as Contact;
        if (row && row.apollo_id) {
          const enriched = enrichedById.get(row.apollo_id);
          if (enriched) {
            db.prepare(`
              UPDATE contacts
                 SET title         = COALESCE(?, title),
                     seniority     = COALESCE(?, seniority),
                     department    = COALESCE(?, department),
                     email         = COALESCE(?, email),
                     email_status  = COALESCE(?, email_status),
                     linkedin_url  = COALESCE(?, linkedin_url),
                     updated_at    = datetime('now')
               WHERE id = ?
            `).run(
              enriched.title ?? null,
              enriched.seniority ?? null,
              enriched.department ?? null,
              enriched.email ?? null,
              enriched.email_status ?? null,
              enriched.linkedin_url ?? null,
              row.id
            );
          }
        }
      }
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
