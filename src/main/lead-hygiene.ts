/**
 * Lead-hygiene helpers — filters out obvious garbage before opportunities
 * land in front of the user.
 *
 * The flagship rule: the brand company itself cannot be a customer of
 * itself. If the user sells Neptune Software's products, an article ABOUT
 * Neptune Software is not a buying signal for Neptune Software — they ARE
 * the seller. The scanner's LLM call usually gets this right but
 * occasionally confuses the two roles, so we belt-and-braces it both in
 * the prompt and as a post-filter here.
 */

import type { Brand } from '@shared/types';

/**
 * Normalize a company / brand name for fuzzy compare:
 *   "Neptune Software, Inc."  →  "neptune software"
 *   "Acme   Corp."            →  "acme corp"
 *   "Foo-Bar Ltd"             →  "foo bar ltd"
 *
 * Strips trailing legal suffixes that vary between feeds.
 */
function normalize(name: string): string {
  if (!name) return '';
  let s = name.toLowerCase();
  s = s.replace(/[.,]/g, ' ');
  s = s.replace(/[^a-z0-9 &]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  // Strip common trailing legal suffixes (idempotent — run twice in case
  // of "Foo Inc Limited" type stacking).
  const trail = /\s+(inc|incorporated|ltd|limited|llc|plc|gmbh|sa|nv|bv|co|company|corp|corporation|holdings|holding|group|software|technologies|technology|systems|solutions|services)$/;
  for (let i = 0; i < 2; i++) s = s.replace(trail, '').trim();
  return s;
}

/**
 * True when `company` looks like one of OUR brands (case/punctuation/suffix-tolerant).
 * Used to drop candidate opportunities where the LLM picked our own organization
 * as the customer.
 */
export function isOwnBrandCompany(company: string, brands: Brand[]): boolean {
  const c = normalize(company);
  if (!c) return false;
  for (const b of brands) {
    const n = normalize(b.name);
    if (!n) continue;
    if (c === n) return true;
    // substring either way — "Neptune" should still match "Neptune Software"
    // and "Neptune Software Ltd" should still match "Neptune Software".
    if (c.includes(n) || n.includes(c)) return true;
  }
  return false;
}

/**
 * Prompt-ready block listing our brands so the LLM doesn't pick them
 * as the customer. Always include this in any scan / qualify prompt.
 */
export function buildOwnBrandsBlock(brands: Brand[]): string {
  if (!brands.length) return '';
  const names = brands.map((b) => `- ${b.name}`).join('\n');
  return `# Our own brands — NEVER select these as the customer/opportunity
We sell on behalf of the following organizations. They are the seller, not
the buyer. Articles about them, their product launches, their executive
changes, etc. are not buying signals for themselves. Do not set "company"
(or matched_brand's company) to any of these:
${names}`;
}
