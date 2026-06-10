/**
 * v1.20.0 — Hunter.io client.
 *
 * Used as a SECONDARY email finder: when Apollo's /people/match returns a
 * contact name + work but no email, we ask Hunter to find the email by
 * (first_name, last_name, domain). Hunter's database is different from
 * Apollo's; lift on Apollo's null-email cases is typically 10-30%.
 *
 * Free tier reality (verified against Hunter docs 2026-06):
 *   - 50 credits/month, 1 credit per SUCCESSFUL find (0 on miss)
 *   - API works on free tier, no plan-tier email masking
 *   - Returns full email + verification status + confidence score
 *
 * Different from Apollo:
 *   - Hunter is name+domain → email, not a "find people at company" platform
 *   - We never call Hunter to discover NEW contacts; only to finish what
 *     Apollo's search started
 *
 * Endpoints used:
 *   GET /v2/email-finder ?domain=... &first_name=... &last_name=...
 *     Returns: { data: { email, score, verification: { status, ... } } }
 *   GET /v2/account
 *     Free, used to validate the API key on Settings save.
 */

import { fetch as undiciFetch } from 'undici';
import { getDb } from './db.js';
import { getSettings } from './settings.js';

const HUNTER_BASE = 'https://api.hunter.io/v2';

// On the Starter plan ($34/mo annual / $49/mo monthly for 2,000 credits):
// $0.017 / credit. Free tier: no marginal cost, but we still log to api_calls
// at the Starter rate so the Cost Management view shows what it WOULD cost
// at scale. User can mentally discount while on free.
export const HUNTER_COST_PER_CREDIT_USD = 0.017;

export type HunterFinderResult = {
  email: string | null;
  email_status: 'verified' | 'webmail' | 'invalid' | 'accept_all' | 'disposable' | 'unknown' | null;
  confidence: number | null;   // 0..100
  raw: any;
};

/**
 * Validate the configured Hunter API key by hitting /v2/account.
 * /account is free — same auth-test pattern as Apollo's /auth/health.
 */
export async function validateHunterKey(
  key?: string
): Promise<{ ok: boolean; error?: string; planName?: string | null; creditsLeft?: number | null }> {
  const apiKey = (key ?? getSettings().hunterApiKey ?? '').trim();
  if (!apiKey) return { ok: false, error: 'No API key configured.' };
  try {
    const url = new URL(`${HUNTER_BASE}/account`);
    url.searchParams.set('api_key', apiKey);
    const r = await undiciFetch(url.toString(), { method: 'GET' });
    if (r.status === 401) {
      return { ok: false, error: 'Hunter rejected the key (HTTP 401). Check it on hunter.io → API.' };
    }
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      return { ok: false, error: `Hunter returned HTTP ${r.status}. Response: ${text.slice(0, 200)}` };
    }
    const body: any = await r.json().catch(() => null);
    const data = body?.data || {};
    return {
      ok: true,
      planName: typeof data.plan_name === 'string' ? data.plan_name : null,
      creditsLeft:
        typeof data?.calls?.available === 'number'
          ? (data.calls.available - (data.calls.used ?? 0))
          : null
    };
  } catch (e: any) {
    return { ok: false, error: `Network error: ${String(e?.message || e).slice(0, 200)}` };
  }
}

/**
 * Find an email via Hunter's Email Finder. Returns null email if Hunter
 * couldn't find one (which doesn't cost a credit — Hunter only bills on
 * success). Returns the verification status + confidence as well.
 *
 * Inputs:
 *   - firstName + lastName: required
 *   - domain: required (Hunter is domain-based)
 *
 * Use after Apollo's /people/match returns a person with email === null
 * AND we know the company's email domain (extracted from Apollo's
 * organization record, or derived from the opportunity's source_url).
 */
export async function findEmailViaHunter(
  firstName: string,
  lastName: string,
  domain: string,
  relatedContactId: number | null = null
): Promise<{ result: HunterFinderResult | null; error: string | null }> {
  const { hunterApiKey } = getSettings();
  if (!hunterApiKey) return { result: null, error: 'No Hunter API key configured' };
  const fn = (firstName || '').trim();
  const ln = (lastName || '').trim();
  const dom = cleanDomain(domain);
  if (!fn || !ln) return { result: null, error: 'first_name and last_name required' };
  if (!dom) return { result: null, error: 'domain required' };

  const url = new URL(`${HUNTER_BASE}/email-finder`);
  url.searchParams.set('domain', dom);
  url.searchParams.set('first_name', fn);
  url.searchParams.set('last_name', ln);
  url.searchParams.set('api_key', hunterApiKey);

  let r;
  try {
    r = await undiciFetch(url.toString(), { method: 'GET' });
  } catch (e: any) {
    return { result: null, error: `Hunter network error: ${String(e?.message || e).slice(0, 200)}` };
  }
  if (r.status === 401 || r.status === 403) {
    const text = await r.text().catch(() => '');
    return { result: null, error: `Hunter rejected the key (HTTP ${r.status}): ${text.slice(0, 200)}` };
  }
  if (r.status === 429) {
    return { result: null, error: 'Hunter rate-limited the request.' };
  }
  if (r.status === 404) {
    // Email Finder returns 404 when no match — not an error, just a miss.
    return { result: { email: null, email_status: null, confidence: null, raw: null }, error: null };
  }
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    return { result: null, error: `Hunter HTTP ${r.status}: ${text.slice(0, 200)}` };
  }
  const body: any = await r.json().catch(() => null);
  if (!body) return { result: null, error: 'Hunter returned unparseable response' };

  const data = body.data || {};
  const email: string | null = typeof data.email === 'string' && data.email.length > 0 ? data.email : null;
  const verification = data.verification || {};
  const status = typeof verification.status === 'string' ? verification.status : null;
  const score = typeof data.score === 'number' ? data.score : null;

  // Record the credit spend only when Hunter actually returned an email
  // (Hunter's "only billed on success" model — verified against their docs).
  if (email) {
    recordHunterSpend('hunter_lookup', 1, relatedContactId);
  }

  return {
    result: {
      email,
      email_status: status as any,
      confidence: score,
      raw: body
    },
    error: null
  };
}

/**
 * Strip protocol + path + leading www from a URL or domain string so we
 * pass a clean domain to Hunter. Exported for smoke testing.
 *
 * Examples:
 *   "https://www.nvidia.com/news" → "nvidia.com"
 *   "nvidia.com"                  → "nvidia.com"
 *   "www.nvidia.com"              → "nvidia.com"
 *   "NVIDIA.COM"                  → "nvidia.com"
 */
export function cleanDomain(raw: string | null | undefined): string {
  if (!raw) return '';
  let s = String(raw).trim().toLowerCase();
  // Strip protocol
  s = s.replace(/^[a-z]+:\/\//, '');
  // Strip leading www.
  s = s.replace(/^www\./, '');
  // Strip path / query / fragment — everything after first /
  const slash = s.indexOf('/');
  if (slash !== -1) s = s.slice(0, slash);
  // Strip trailing dots
  s = s.replace(/\.+$/, '');
  return s;
}

// ─── Spend logging ────────────────────────────────────────────────
function recordHunterSpend(
  stage: 'hunter_lookup',
  credits: number,
  relatedId: number | null
): void {
  try {
    const db = getDb();
    const cost = Number((credits * HUNTER_COST_PER_CREDIT_USD).toFixed(6));
    db.prepare(
      `INSERT INTO api_calls(provider, model, stage, input_tokens, output_tokens, cost_usd, related_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('hunter', 'email-finder', stage, 0, credits, cost, relatedId);
  } catch (e) {
    console.warn('[hunter] spend log failed:', e);
  }
}
