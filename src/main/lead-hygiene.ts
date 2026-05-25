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
 *   "Acme, Inc."          →  "acme"
 *   "Foo-Bar Ltd"         →  "foo bar"
 *   "Neptune Software"    →  "neptune software"   ← v1.8.3: stem retained
 *
 * Strips trailing LEGAL suffixes only (Inc / Ltd / LLC / etc.). v1.8.3:
 * dropped descriptive trailing words like "software", "technology", "systems",
 * "solutions", "services", "group", "holdings" from the strip list. Stripping
 * those left over-broad stems — e.g. "Neptune Software" → "neptune" was then
 * substring-matching "Neptune Energy" / "Neptune Wellness" as the same org.
 */
function normalize(name: string): string {
  if (!name) return '';
  let s = name.toLowerCase();
  s = s.replace(/[.,]/g, ' ');
  s = s.replace(/[^a-z0-9 &]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  // Strip only true legal-entity suffixes — never descriptive words.
  const trail = /\s+(inc|incorporated|ltd|limited|llc|plc|gmbh|sa|nv|bv|co|company|corp|corporation|ag|kg|kk|sas|sarl)$/;
  for (let i = 0; i < 2; i++) s = s.replace(trail, '').trim();
  return s;
}

const SHORT_STEM_THRESHOLD = 5;

/**
 * True when `company` looks like one of OUR brands (case/punctuation/suffix-tolerant).
 * Used to drop candidate opportunities where the LLM picked our own organization
 * as the customer.
 *
 * v1.8.3: substring match is now gated by stem length — short stems (≤ 4 chars)
 * require exact-match equality, not substring containment. Otherwise a brand
 * called "Neptune" / "Acme" / "Zyeta" silently filters every company whose name
 * happens to contain those letters.
 */
export function isOwnBrandCompany(company: string, brands: Brand[]): boolean {
  const c = normalize(company);
  if (!c) return false;
  for (const b of brands) {
    const n = normalize(b.name);
    if (!n) continue;
    if (c === n) return true;
    // Substring matching is dangerous for short stems — gate on length.
    if (n.length >= SHORT_STEM_THRESHOLD && c.includes(n)) return true;
    if (c.length >= SHORT_STEM_THRESHOLD && n.includes(c)) return true;
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
