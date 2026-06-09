/**
 * v1.19.0 — Apollo API client wrapper.
 *
 * Used by contact-search.ts (Phase 1 of outbound). Two endpoints:
 *   - POST /v1/mixed_people/search     — find contacts by company + filters
 *   - GET  /v1/auth/health             — validate key (free, used in Settings)
 *
 * Spend is logged into the existing api_calls table with provider='apollo'
 * and stage='contact_lookup' at the per-credit rate (Apollo charges 1
 * credit per person returned with full data on the Starter plan).
 *
 * Per CLAUDE.md §7b, the inline copy of any new pure-function logic must
 * land in scripts/smoke-perplexity.mjs in the same commit. This file is
 * mostly I/O glue, no new pure-function logic to test.
 */

import { fetch as undiciFetch } from 'undici';
import { getDb } from './db.js';
import { getSettings } from './settings.js';
import type { ApolloSeniority, ContactArchetype } from '@shared/types';
import { APOLLO_SEARCH_PAGE_SIZE } from '@shared/hunt.js';

const APOLLO_BASE = 'https://api.apollo.io/v1';

// Apollo Starter plan: $49 / 1,000 credits = $0.049 / credit.
// Free tier costs the user nothing but we still track credits internally so
// the UI can warn before exhausting the 60/mo allowance.
export const APOLLO_COST_PER_CREDIT_USD = 0.049;

export type ApolloPerson = {
  id?: string;                       // Apollo's internal id
  first_name?: string;
  last_name?: string;
  name?: string;
  title?: string;
  seniority?: string;                // their enum: c_suite, vp, director, …
  department?: string | null;
  email?: string | null;
  email_status?: string | null;      // verified | guessed | unavailable | unverified
  linkedin_url?: string | null;
  organization?: {
    id?: string;
    name?: string;
    website_url?: string;
  } | null;
};

export type ApolloSearchResult = {
  people: ApolloPerson[];
  creditsUsed: number;
  raw: any;
};

/**
 * Validates the configured API key by hitting Apollo's /auth/health.
 * Returns shape suitable for Settings UI feedback.
 */
export async function validateApolloKey(
  key?: string
): Promise<{ ok: boolean; error?: string; remainingCredits?: number | null }> {
  const apiKey = (key ?? getSettings().apolloApiKey ?? '').trim();
  if (!apiKey) return { ok: false, error: 'No API key configured.' };
  try {
    // v1.19.1: same dual-auth pattern as searchPeople — header + query
    // string. /auth/health works with either, but matching searchPeople's
    // auth shape means "Test connection" pass-fail status matches what
    // happens during real calls.
    const url = new URL(`${APOLLO_BASE}/auth/health`);
    url.searchParams.set('api_key', apiKey);
    const r = await undiciFetch(url.toString(), {
      method: 'GET',
      headers: {
        'Cache-Control': 'no-cache',
        'Content-Type': 'application/json',
        'X-Api-Key': apiKey
      }
    });
    if (r.status === 401 || r.status === 403) {
      const text = await r.text().catch(() => '');
      return { ok: false, error: `Apollo rejected the key (HTTP ${r.status}). Response: ${text.slice(0, 200)}` };
    }
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      return { ok: false, error: `Apollo returned HTTP ${r.status}. Response: ${text.slice(0, 200)}` };
    }
    const body: any = await r.json().catch(() => null);
    // Apollo's auth health response doesn't always include credit data;
    // best-effort: pull from common field names if present.
    const remaining =
      typeof body?.credits_remaining === 'number' ? body.credits_remaining :
      typeof body?.credits?.remaining === 'number' ? body.credits.remaining :
      null;
    return { ok: true, remainingCredits: remaining };
  } catch (e: any) {
    return { ok: false, error: `Network error: ${String(e?.message || e).slice(0, 200)}` };
  }
}

/**
 * Search for contacts at a named organization using filters derived from
 * a Sonnet-produced archetype. Returns Apollo's raw person list (caller
 * runs them through the ranker).
 */
export async function searchPeople(
  organizationName: string,
  archetype: ContactArchetype
): Promise<ApolloSearchResult> {
  const { apolloApiKey } = getSettings();
  if (!apolloApiKey) throw new Error('Apollo API key not configured. Add it in Settings → Contact API.');

  // Defensive: at least one of org name + filter dimensions must be set,
  // else Apollo returns a global firehose.
  const cleanOrg = (organizationName || '').trim();
  if (!cleanOrg) throw new Error('Apollo search requires a company name.');

  // v1.19.1: Apollo's POST search endpoints are inconsistent about WHERE
  // the API key is expected. /auth/health works with the X-Api-Key header
  // alone, but /mixed_people/search has historically required the key as
  // `api_key` in the request body (their older convention) AND/OR in the
  // header. Sending both is defensive — Apollo accepts either, and we
  // avoid the "works in Test connection but fails on real call" trap.
  const body: Record<string, any> = {
    api_key: apolloApiKey,        // body-level auth (legacy POST convention)
    organization_names: [cleanOrg],
    page: 1,
    per_page: APOLLO_SEARCH_PAGE_SIZE
  };
  if (archetype.target_seniorities.length > 0) {
    body.person_seniorities = archetype.target_seniorities;
  }
  if (archetype.target_titles.length > 0) {
    // Apollo accepts multiple title patterns via q_keywords or
    // person_titles; person_titles is the stricter filter, q_keywords
    // is broader. Use person_titles for precision.
    body.person_titles = archetype.target_titles;
  }

  let r;
  try {
    // v1.19.2: Apollo deprecated /mixed_people/search for API callers.
    // The new endpoint is /mixed_people/api_search (per their 422 response
    // pointing at https://docs.apollo.io/reference/people-api-search). Same
    // request shape, same auth pattern — purely an endpoint rename.
    r = await undiciFetch(`${APOLLO_BASE}/mixed_people/api_search`, {
      method: 'POST',
      headers: {
        'Cache-Control': 'no-cache',
        'Content-Type': 'application/json',
        // Apollo accepts both casings; send the documented header form.
        'X-Api-Key': apolloApiKey
      },
      body: JSON.stringify(body)
    });
  } catch (e: any) {
    throw new Error(`Apollo network error: ${String(e?.message || e).slice(0, 200)}`);
  }
  if (r.status === 401 || r.status === 403) {
    // v1.19.1: surface Apollo's actual response body so we can see WHY the
    // key was rejected (insufficient plan, wrong scope, master-key needed,
    // etc.) instead of the previous opaque "rejected the key" message.
    const text = await r.text().catch(() => '');
    let hint = '';
    if (/master/i.test(text)) {
      hint = ' (Apollo says you need a master API key — generate one at apollo.io → Settings → Integrations → API.)';
    } else if (/plan|subscription|upgrade/i.test(text)) {
      hint = ' (Apollo says your plan does not include this endpoint — the people-search API may require a paid tier.)';
    }
    throw new Error(`Apollo rejected the API key for people search (HTTP ${r.status}).${hint} Response: ${text.slice(0, 300)}`);
  }
  if (r.status === 422) {
    // Unprocessable entity — usually a malformed query. Surface the body.
    const text = await r.text().catch(() => '');
    throw new Error(`Apollo rejected the search query (HTTP 422). Response: ${text.slice(0, 300)}`);
  }
  if (r.status === 429) {
    throw new Error('Apollo rate-limited the request. Please try again in a moment.');
  }
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`Apollo HTTP ${r.status}: ${text.slice(0, 300)}`);
  }
  const raw: any = await r.json().catch(() => null);
  if (!raw) throw new Error('Apollo returned an unparseable response.');

  const people: ApolloPerson[] = Array.isArray(raw.people) ? raw.people : [];

  // Each returned person counts as 1 Apollo credit on the Starter plan.
  // Free tier uses the same counting model — we just don't have a direct
  // way to assert how Apollo's free-tier metering works, so we log credits
  // optimistically and the user's Apollo dashboard is the source of truth.
  const creditsUsed = people.length;
  recordApolloSpend('contact_lookup', creditsUsed, null);

  return { people, creditsUsed, raw };
}

/**
 * v1.19.3 — Enrich a person by Apollo ID.
 *
 * `mixed_people/api_search` returns LIGHT records (name, title, sometimes
 * LinkedIn) — no email, often no seniority/department either. Apollo
 * charges separately for the "reveal" via `/v1/people/match`. We call it
 * for each top-ranked contact so the UI shows real emails + the ranker
 * gets seniority/department signals.
 *
 * Costs 1 credit per match on Apollo's billing.
 */
export async function enrichPersonByApolloId(
  apolloId: string,
  relatedContactId: number | null = null
): Promise<{ person: ApolloPerson | null; error: string | null }> {
  const { apolloApiKey } = getSettings();
  if (!apolloApiKey) {
    return { person: null, error: 'Apollo API key not configured' };
  }
  const body = {
    api_key: apolloApiKey,
    id: apolloId,
    // Apollo's documented reveal flags. Both default false; set explicitly
    // so the response includes the email + seniority + department fields
    // we actually want to surface.
    reveal_personal_emails: false,
    reveal_phone_number: false
  };
  let r;
  try {
    r = await undiciFetch(`${APOLLO_BASE}/people/match`, {
      method: 'POST',
      headers: {
        'Cache-Control': 'no-cache',
        'Content-Type': 'application/json',
        'X-Api-Key': apolloApiKey
      },
      body: JSON.stringify(body)
    });
  } catch (e: any) {
    return { person: null, error: `Apollo network error: ${String(e?.message || e).slice(0, 200)}` };
  }
  if (r.status === 401 || r.status === 403) {
    const text = await r.text().catch(() => '');
    return { person: null, error: `Apollo rejected enrich call (HTTP ${r.status}). Response: ${text.slice(0, 200)}` };
  }
  if (r.status === 429) {
    return { person: null, error: 'Apollo rate-limited the enrich call.' };
  }
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    return { person: null, error: `Apollo HTTP ${r.status}: ${text.slice(0, 300)}` };
  }
  const raw: any = await r.json().catch(() => null);
  if (!raw) {
    return { person: null, error: 'Apollo returned an unparseable enrich response.' };
  }
  // Per Apollo docs, /people/match returns { person: { ... } } on hit.
  // On a miss (Apollo can't resolve the id), it may return person: null
  // or omit the field — handle both.
  const person: ApolloPerson | null = raw.person ?? null;
  // Record the credit spend whether or not we got a useful payload —
  // Apollo bills on accepted calls regardless of result quality.
  recordApolloSpend('contact_lookup', 1, relatedContactId);
  if (!person) {
    return { person: null, error: 'Apollo could not match this contact (no person returned).' };
  }
  return { person, error: null };
}

/** Coerce Apollo's seniority string into our typed enum (or null). */
export function normaliseSeniority(s: string | null | undefined): ApolloSeniority | null {
  if (!s) return null;
  const known: ApolloSeniority[] = [
    'c_suite', 'vp', 'director', 'head', 'manager', 'senior', 'entry',
    'owner', 'partner', 'founder'
  ];
  const lower = s.toLowerCase();
  return (known.includes(lower as ApolloSeniority) ? (lower as ApolloSeniority) : null);
}

// ─── Spend logging ────────────────────────────────────────────────
// Apollo isn't in pricing.ts (which only knows about LLM rates), so we
// log directly into api_calls with provider='apollo' + cost computed
// from APOLLO_COST_PER_CREDIT_USD. Spend dashboard buckets it under the
// new 'contact_outreach' OperationType.

export function recordApolloSpend(
  stage: 'contact_lookup',
  credits: number,
  relatedId: number | null
): void {
  try {
    const db = getDb();
    const cost = Number((credits * APOLLO_COST_PER_CREDIT_USD).toFixed(6));
    db.prepare(
      `INSERT INTO api_calls(provider, model, stage, input_tokens, output_tokens, cost_usd, related_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('apollo', 'mixed_people_search', stage, 0, credits, cost, relatedId);
  } catch (e) {
    console.warn('[apollo] spend log failed:', e);
  }
}
