#!/usr/bin/env node
/**
 * Self-contained smoke test for the pure-function logic the scanner
 * depends on. Run before shipping: `node scripts/smoke-perplexity.mjs`.
 *
 * Each test covers a code path that has bitten us in v1.7.x / v1.8.x:
 *  - tryParseJson on real-world sonar-deep-research output shapes
 *    (with <think> blocks, fenced JSON, nested/sequential blocks, truncated)
 *  - isEmptyCompletion detector for the v1.8.5 retry path
 *  - cleanUrl + pickBestSourceUrl for v1.5.4's URL hygiene
 *  - isOwnBrandCompany for v1.8.3's brand-self filter fix
 *
 * The test inlines copies of the functions from main/ rather than
 * importing them, because the main modules pull in electron / undici /
 * better-sqlite3 which can't run under plain `node`. The inlined copies
 * MUST stay byte-identical with the production source — when production
 * changes, update here too. (Yes, manual sync is fragile; we'll move to
 * vitest with proper module mocking when test count justifies it.)
 */

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}
function eq(actual, expected, what = '') {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what} — got ${a}, expected ${e}`);
}
function truthy(v, what = '') { if (!v) throw new Error(`${what || 'truthy'} — got ${JSON.stringify(v)}`); }
function falsy(v, what = '') { if (v) throw new Error(`${what || 'falsy'} — got ${JSON.stringify(v)}`); }

// ════════════════════════════════════════════════════════════════════════
// INLINED COPIES from src/main/perplexity.ts (tryParseJson, helpers)
// Keep byte-identical with production.
// ════════════════════════════════════════════════════════════════════════
function tryParseJson(raw) {
  if (!raw) return null;
  let s = raw;
  s = s.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
  s = s.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '');
  const fenceMatches = [...s.matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/gi)]
    .map((m) => m[1].trim())
    .filter((b) => b.length > 0)
    .sort((a, b) => b.length - a.length);
  for (const block of fenceMatches) {
    try { return JSON.parse(block); } catch { /* try next */ }
  }
  s = s.replace(/```(?:json)?\s*\n?/gi, '').replace(/```/g, '').trim();
  try { return JSON.parse(s); } catch { /* fall through */ }
  const blocks = extractBalancedBlocks(s).sort((a, b) => b.length - a.length);
  for (const block of blocks) {
    try { return JSON.parse(block); } catch { /* try next */ }
  }
  return null;
}
function extractBalancedBlocks(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '{' && c !== '[') continue;
    const end = findBalancedClose(s, i);
    if (end !== -1) out.push(s.slice(i, end + 1));
  }
  return out;
}
function findBalancedClose(s, startIdx) {
  const open = s[startIdx];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = startIdx; i < s.length; i++) {
    const c = s[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (c === '\\') escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return i; }
  }
  return -1;
}
function isEmptyCompletion(r) {
  const completionTokens = Number(r.usage?.completion_tokens ?? 0);
  const contentLen = (r.text || '').length;
  return completionTokens === 0 && contentLen === 0;
}

function shouldRetryResponse(r, opts) {
  if (isEmptyCompletion(r)) {
    const ct = Number(r.usage?.completion_tokens ?? 0);
    return `empty completion (${ct} tokens, ${(r.text || '').length} chars)`;
  }
  const SEARCH_REQUIRED_STAGES = new Set([
    'research', 'brand_research', 'brand_summary', 'refresh_signals',
    'manual_scan', 'deep_scan', 'deep_scan_discovery', 'qualify'
  ]);
  if (opts.stage && SEARCH_REQUIRED_STAGES.has(opts.stage) && r.citations.length === 0) {
    const ct = Number(r.usage?.completion_tokens ?? 0);
    return `no citations on ${opts.stage} stage (${ct} completion tokens, ${(r.text || '').length} chars) — model didn't search`;
  }
  return null;
}

// ════════════════════════════════════════════════════════════════════════
// INLINED COPY from src/main/source-research.ts (v1.13.0)
// Keep byte-identical with production.
// ════════════════════════════════════════════════════════════════════════
function buildGoogleNewsRssUrl(query) {
  const encoded = encodeURIComponent((query || '').trim());
  return `https://news.google.com/rss/search?q=${encoded}&hl=en-US&gl=US&ceid=US:en`;
}

// v1.13.1: computeTrialUntil — returns SQLite-format timestamp or null.
function computeTrialUntil(period, now = new Date()) {
  if (period === 'permanent') return null;
  const hours = period === '24h' ? 24 : period === '48h' ? 48 : 24 * 7;
  const t = new Date(now.getTime() + hours * 3600 * 1000);
  return t.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

// v1.13.1: groupSourcesByBrand — pure renderer-side grouping helper.
function groupSourcesByBrand(sources, brands) {
  const perBrandMap = new Map();
  const common = [];
  const unassigned = [];
  for (const s of sources) {
    let cfg = {};
    try { cfg = JSON.parse(s.config || '{}'); } catch { /* ignore */ }
    const ids = Array.isArray(cfg.serves_brand_ids) ? cfg.serves_brand_ids : [];
    if (ids.length === 0) {
      unassigned.push(s);
    } else if (ids.length === 1) {
      const bid = ids[0];
      if (!perBrandMap.has(bid)) perBrandMap.set(bid, []);
      perBrandMap.get(bid).push(s);
    } else {
      common.push(s);
    }
  }
  const perBrand = [];
  for (const b of brands) {
    const list = perBrandMap.get(b.id);
    if (list && list.length > 0) {
      list.sort((a, b) => a.name.localeCompare(b.name));
      perBrand.push({ brand: b, sources: list });
    }
  }
  for (const [bid, list] of perBrandMap.entries()) {
    if (!brands.find((b) => b.id === bid)) common.push(...list);
  }
  common.sort((a, b) => a.name.localeCompare(b.name));
  unassigned.sort((a, b) => a.name.localeCompare(b.name));
  return { perBrand, common, unassigned };
}

// ════════════════════════════════════════════════════════════════════════
// INLINED COPY from src/main/llm.ts (v1.10.1)
// Keep byte-identical with production.
// ════════════════════════════════════════════════════════════════════════
function modelSupportsTemperature(modelId) {
  const TEMPERATURE_DEPRECATED = [
    /^claude-opus-4-7/i
  ];
  return !TEMPERATURE_DEPRECATED.some((re) => re.test(modelId));
}

// ════════════════════════════════════════════════════════════════════════
// INLINED COPIES from src/main/spend.ts (v1.11.0 — Cost Management)
// Keep byte-identical with production.
// ════════════════════════════════════════════════════════════════════════
function operationForStage(stage) {
  switch (stage) {
    case 'brand_research':
    case 'brand_research_verify':
    case 'brand_research_strategic':
    case 'brand_research_factcheck':
    case 'brand_summary':
      return 'brand_research';
    case 'research':
    case 'product_research_verify':
    case 'product_research_strategic':
    case 'product_research_factcheck':
      return 'product_research';
    case 'brand_signals':
    case 'product_signals':
    case 'refresh_signals':
      return 'signal_research';
    case 'brand_source_research':
      return 'source_research';
    case 'manual_scan':
      return 'manual_scan';
    case 'deep_scan':
    case 'deep_scan_discovery':
    case 'deep_scan_qualify':
      return 'deep_scan';
    case 'triage':
    case 'qualify':
      return 'live_monitor';
    case 'brief':
      return 'sales_brief';
    case 'contact_archetype':
    case 'contact_draft':
    case 'contact_lookup':
      return 'contact_outreach';
    default:
      return 'other';
  }
}

const OPERATION_LABEL = {
  brand_research: 'Brand research (all 4 stages)',
  product_research: 'Product research (all 4 stages)',
  signal_research: 'Signal research (brand + product)',
  source_research: 'Source research (auto-discover feeds)',
  manual_scan: 'Manual scan',
  deep_scan: 'Deep scan (Stage 1 + Stage 2)',
  live_monitor: 'Live Monitor (triage + qualify)',
  sales_brief: 'Sales brief generation',
  other: 'Other / untagged'
};

const OPERATION_ORDER = [
  'brand_research', 'product_research', 'signal_research', 'source_research',
  'manual_scan', 'deep_scan', 'live_monitor', 'sales_brief', 'other'
];

function bucketByOperation(rows) {
  const buckets = new Map();
  for (const op of OPERATION_ORDER) {
    buckets.set(op, { operation: op, label: OPERATION_LABEL[op], calls: 0, cost: 0 });
  }
  for (const row of rows) {
    const op = operationForStage(row.stage);
    const b = buckets.get(op);
    b.calls += row.calls;
    b.cost += row.cost;
  }
  return OPERATION_ORDER.map((op) => buckets.get(op)).filter((b) => b.calls > 0);
}

// ════════════════════════════════════════════════════════════════════════
// INLINED COPY from src/renderer/src/pages/BrandsProducts.tsx (v1.10.3)
// Keep byte-identical with production.
// ════════════════════════════════════════════════════════════════════════
function stage4SourceCoverage(stage4Status) {
  if (!stage4Status) return null;
  const m = stage4Status.match(/(\d+)\s*\/\s*(\d+)\s*sources/i);
  if (!m) return null;
  const fetched = Number(m[1]);
  const attempted = Number(m[2]);
  if (!Number.isFinite(fetched) || !Number.isFinite(attempted) || attempted <= 0) return null;
  return fetched / attempted;
}

// ════════════════════════════════════════════════════════════════════════
// INLINED COPIES from src/main/research/dossier-factcheck.ts (v1.10.2)
// Keep byte-identical with production.
// ════════════════════════════════════════════════════════════════════════
function clampCitationList(urls, max) {
  const seen = new Set();
  const out = [];
  for (const u of urls || []) {
    const trimmed = (u || '').trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= max) break;
  }
  return out;
}
function shouldAttemptOpusCall(sourcesFetched, minRequired = 2) {
  return sourcesFetched >= minRequired;
}
function extractCitationsFromRawDossier(rawDossierJson) {
  if (!rawDossierJson) return [];
  try {
    const obj = JSON.parse(rawDossierJson);
    if (Array.isArray(obj?.citations)) {
      return obj.citations.filter((u) => typeof u === 'string');
    }
  } catch { /* ignore */ }
  return [];
}

// ════════════════════════════════════════════════════════════════════════
// INLINED COPIES from src/main/signal-research.ts (v1.9.3)
// Keep byte-identical with production.
// ════════════════════════════════════════════════════════════════════════
function extractSignalsField(json) {
  if (!json || typeof json !== 'object') return null;
  const candidateKeys = ['signals', 'signal', 'bullets', 'signal_list', 'signals_list', 'buying_signals'];
  for (const key of candidateKeys) {
    const v = json[key];
    if (typeof v === 'string') {
      const trimmed = v.trim();
      if (trimmed.length > 0) return trimmed;
    }
    if (Array.isArray(v)) {
      const strings = v
        .filter((x) => typeof x === 'string')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (strings.length === 0) continue;
      return strings.map((s) => (/^[-•*]\s+/.test(s) ? s : `- ${s}`)).join('\n');
    }
  }
  return null;
}

function extractBulletsFromText(text) {
  if (!text) return null;
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[-•*]\s+\S/.test(l));
  if (lines.length === 0) return null;
  return lines.map((l) => l.replace(/^[•*]\s+/, '- ')).join('\n');
}

// ════════════════════════════════════════════════════════════════════════
// INLINED COPIES from src/main/feedback.ts (v1.9.2)
// Keep byte-identical with production.
// ════════════════════════════════════════════════════════════════════════
const FEEDBACK_MAX_CHARS = 4000;
const FEEDBACK_BLOCK_MAX_CHARS = 16_000;

/** Validation half of addFeedback — same trim + length checks. */
function validateFeedbackInput(feedback) {
  const trimmed = (feedback || '').trim();
  if (!trimmed) throw new Error('Feedback cannot be empty.');
  if (trimmed.length > FEEDBACK_MAX_CHARS) {
    throw new Error(
      `Feedback is too long (${trimmed.length} / ${FEEDBACK_MAX_CHARS} chars). Trim it down or split across multiple submissions.`
    );
  }
  return trimmed;
}

/**
 * Mirror of buildFeedbackBlock but takes the entries directly (rather than
 * reading from the DB) so we can test it under bare Node.
 */
function buildFeedbackBlockFrom(entries) {
  if (!entries || entries.length === 0) return '';
  const header =
    '# Reviewer feedback to incorporate (apply these corrections)\n' +
    "Brand or product owners reviewed previous research output and asked for the following changes. Honour them — they outrank the model's own judgment for the items they cover.\n";
  const lines = [];
  let used = header.length;
  for (const entry of entries) {
    const date = entry.created_at.slice(0, 10);
    const block = `\n## Feedback from ${date}\n${entry.feedback}\n`;
    if (used + block.length > FEEDBACK_BLOCK_MAX_CHARS) break;
    lines.push(block);
    used += block.length;
  }
  if (lines.length === 0) return '';
  return header + lines.join('');
}

// ════════════════════════════════════════════════════════════════════════
// INLINED COPIES from src/main/url-hygiene.ts
// ════════════════════════════════════════════════════════════════════════
const PLACEHOLDER_HOSTS = new Set(['example.com', 'example.org', 'example.net', 'site.com']);
function cleanUrl(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (!s) return null;
  // v1.8.5: iterate to stable — handles nested wrappers like "(url).".
  let prev = '';
  while (prev !== s) {
    prev = s;
    s = s.replace(/^[<("'\[]+|[>)"'\]]+$/g, '');
    s = s.replace(/[.,;:!?]+$/, '');
  }
  const md = s.match(/\((https?:\/\/[^\s)]+)\)\s*$/);
  if (md) s = md[1];
  if (!/^https?:\/\//i.test(s)) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (PLACEHOLDER_HOSTS.has(u.hostname.toLowerCase())) return null;
  u.hash = '';
  return u.toString();
}
function canonicalize(s) {
  try {
    const u = new URL(s);
    let host = u.hostname.toLowerCase();
    if (host.startsWith('www.')) host = host.slice(4);
    const path = u.pathname.replace(/\/+$/, '');
    return host + path + (u.search || '');
  } catch { return s.toLowerCase(); }
}
function pickBestSourceUrl(llmUrl, citations) {
  const cleanedLlm = cleanUrl(llmUrl);
  const cleanedCites = (citations || [])
    .map((c) => cleanUrl(c))
    .filter((c) => !!c);
  if (cleanedLlm && cleanedCites.length > 0) {
    const llmCanon = canonicalize(cleanedLlm);
    const match = cleanedCites.find((c) => canonicalize(c) === llmCanon);
    if (match) return { url: match, source: 'llm' };
    const llmHost = (() => { try { return new URL(cleanedLlm).hostname.replace(/^www\./, ''); } catch { return ''; } })();
    if (llmHost) {
      const hostMatch = cleanedCites.find((c) => {
        try { return new URL(c).hostname.replace(/^www\./, '') === llmHost; } catch { return false; }
      });
      if (hostMatch) return { url: hostMatch, source: 'citation' };
    }
    return { url: cleanedCites[0], source: 'citation' };
  }
  if (!cleanedLlm && cleanedCites.length > 0) return { url: cleanedCites[0], source: 'citation' };
  if (cleanedLlm) return { url: cleanedLlm, source: 'llm_unverified' };
  return { url: null, source: 'llm_unverified' };
}

// ════════════════════════════════════════════════════════════════════════
// INLINED COPIES from src/main/lead-hygiene.ts (v1.8.3)
// ════════════════════════════════════════════════════════════════════════
function normalize(name) {
  if (!name) return '';
  let s = name.toLowerCase();
  s = s.replace(/[.,]/g, ' ');
  s = s.replace(/[^a-z0-9 &]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  const trail = /\s+(inc|incorporated|ltd|limited|llc|plc|gmbh|sa|nv|bv|co|company|corp|corporation|ag|kg|kk|sas|sarl)$/;
  for (let i = 0; i < 2; i++) s = s.replace(trail, '').trim();
  return s;
}
const SHORT_STEM_THRESHOLD = 5;
function isOwnBrandCompany(company, brands) {
  const c = normalize(company);
  if (!c) return false;
  for (const b of brands) {
    const n = normalize(b.name);
    if (!n) continue;
    if (c === n) return true;
    if (n.length >= SHORT_STEM_THRESHOLD && c.includes(n)) return true;
    if (c.length >= SHORT_STEM_THRESHOLD && n.includes(c)) return true;
  }
  return false;
}

// ════════════════════════════════════════════════════════════════════════
// TESTS
// ════════════════════════════════════════════════════════════════════════
console.log('\n[tryParseJson]');
test('plain JSON parses', () => {
  eq(tryParseJson('{"opportunities":[{"company":"X"}]}'), { opportunities: [{ company: 'X' }] });
});
test('JSON inside ```json fence', () => {
  eq(tryParseJson('Here is the result:\n```json\n{"opportunities":[]}\n```\nDone.'), { opportunities: [] });
});
test('JSON after <think>…</think> reasoning block', () => {
  eq(tryParseJson('<think>Let me research…</think>\n\n{"opportunities":[{"company":"Acme"}]}'),
     { opportunities: [{ company: 'Acme' }] });
});
test('multiple <thinking> blocks (mixed case)', () => {
  eq(tryParseJson('<thinking>step 1</thinking> prose <THINKING>step 2</THINKING>\n{"opportunities":[]}'),
     { opportunities: [] });
});
test('largest balanced block wins', () => {
  eq(tryParseJson('intro {"x":1} more {"opportunities":[{"company":"A"},{"company":"B"}]} tail'),
     { opportunities: [{ company: 'A' }, { company: 'B' }] });
});
test('truncated mid-reasoning returns null', () => {
  eq(tryParseJson('<think>Let me think… still thinking… running out of tokens — </think>'), null);
});
test('JSON with escaped quotes inside strings', () => {
  eq(tryParseJson('{"opportunities":[{"company":"Foo \\"Bar\\" Inc"}]}'),
     { opportunities: [{ company: 'Foo "Bar" Inc' }] });
});
test('empty string returns null', () => { eq(tryParseJson(''), null); });

console.log('\n[isEmptyCompletion]');
test('empty text + zero tokens → true', () => {
  truthy(isEmptyCompletion({ text: '', usage: { completion_tokens: 0 } }));
});
test('non-empty text → false even with 0 tokens', () => {
  falsy(isEmptyCompletion({ text: 'something', usage: { completion_tokens: 0 } }));
});
test('non-zero tokens → false even with empty text', () => {
  falsy(isEmptyCompletion({ text: '', usage: { completion_tokens: 5 } }));
});
test('null usage → treats tokens as 0 → empty if text empty', () => {
  truthy(isEmptyCompletion({ text: '', usage: null }));
});

console.log('\n[shouldRetryResponse — v1.8.7 lazy-refusal detector]');
test('deep_scan + 0 citations + valid empty JSON → RETRY (lazy refusal)', () => {
  // This is the exact Run #20 Zyeta failure: model returned the empty
  // JSON shape without searching. completion_tokens=7, citations=0.
  const r = {
    text: '{"opportunities": []}',
    usage: { completion_tokens: 7 },
    citations: []
  };
  const reason = shouldRetryResponse(r, { stage: 'deep_scan' });
  truthy(reason, `should retry; got: ${reason}`);
});
test('deep_scan + citations > 0 → keep (real research happened)', () => {
  const r = {
    text: '{"opportunities":[]}',
    usage: { completion_tokens: 843 },
    citations: ['https://reuters.com/a', 'https://wsj.com/b']
  };
  eq(shouldRetryResponse(r, { stage: 'deep_scan' }), null);
});
test('brief stage + 0 citations → keep (writing task, no search needed)', () => {
  const r = {
    text: 'Sales brief: …',
    usage: { completion_tokens: 800 },
    citations: []
  };
  eq(shouldRetryResponse(r, { stage: 'brief' }), null);
});
test('research + 0 citations → RETRY (research must search)', () => {
  const r = {
    text: '{"description":"..."}',
    usage: { completion_tokens: 200 },
    citations: []
  };
  truthy(shouldRetryResponse(r, { stage: 'research' }));
});
test('qualify + 0 citations → RETRY', () => {
  const r = {
    text: '{"is_opportunity":false}',
    usage: { completion_tokens: 50 },
    citations: []
  };
  truthy(shouldRetryResponse(r, { stage: 'qualify' }));
});
test('totally empty completion still triggers retry (regression check)', () => {
  truthy(shouldRetryResponse(
    { text: '', usage: { completion_tokens: 0 }, citations: [] },
    { stage: 'deep_scan' }
  ));
});
test('no stage provided → no retry on 0 citations (be conservative)', () => {
  const r = {
    text: '{"foo":1}',
    usage: { completion_tokens: 20 },
    citations: []
  };
  eq(shouldRetryResponse(r, {}), null);
});
test('v1.9: deep_scan_discovery + 0 citations → RETRY (search required)', () => {
  // Stage 1 of the two-stage deep scan goes through Perplexity and MUST
  // search the web. Zero citations means lazy refusal — retry.
  const r = {
    text: '{"candidates": []}',
    usage: { completion_tokens: 10 },
    citations: []
  };
  truthy(shouldRetryResponse(r, { stage: 'deep_scan_discovery' }));
});
test('v1.9: deep_scan_qualify + 0 citations → keep (Claude, no search expected)', () => {
  // Stage 2 of the two-stage deep scan goes through Claude (no web
  // search). It legitimately has 0 citations because it works only on
  // the candidate list Stage 1 surfaced. Note: deep_scan_qualify never
  // calls completePerplexity in production — this is a belt-and-braces
  // check that even if it were misrouted, no retry would fire.
  const r = {
    text: '{"opportunities":[],"rejected":[]}',
    usage: { completion_tokens: 200 },
    citations: []
  };
  eq(shouldRetryResponse(r, { stage: 'deep_scan_qualify' }), null);
});

console.log('\n[cleanUrl + pickBestSourceUrl]');
test('cleanUrl strips wrapping parens + trailing punct', () => {
  eq(cleanUrl('(https://example.org/path).'), null); // example.org is in placeholder list
  eq(cleanUrl('(https://reuters.com/path).'), 'https://reuters.com/path');
});
test('cleanUrl rejects example.com placeholder', () => {
  eq(cleanUrl('https://example.com'), null);
});
test('cleanUrl rejects non-http schemes', () => {
  eq(cleanUrl('javascript:alert(1)'), null);
});
test('pickBestSourceUrl returns LLM URL when matches citation', () => {
  eq(pickBestSourceUrl('https://reuters.com/article', ['https://reuters.com/article']),
     { url: 'https://reuters.com/article', source: 'llm' });
});
test('pickBestSourceUrl prefers same-host citation when LLM URL not in citations', () => {
  const r = pickBestSourceUrl('https://reuters.com/made-up-path', ['https://reuters.com/real-article']);
  eq(r.url, 'https://reuters.com/real-article');
  eq(r.source, 'citation');
});

console.log('\n[isOwnBrandCompany — v1.8.3 fix]');
test('Acme Inc matches "Acme" brand', () => {
  // "Acme Inc" normalizes to "acme", "Acme" normalizes to "acme" → exact match.
  truthy(isOwnBrandCompany('Acme, Inc.', [{ name: 'Acme' }]));
});
test('Zyeta matches "Zyeta" exactly', () => {
  truthy(isOwnBrandCompany('Zyeta', [{ name: 'Zyeta' }]));
});
test('v1.8.3: Neptune Energy no longer falsely matches Neptune Software', () => {
  // Pre-1.8.3: "Neptune Software" → "neptune" (stripped suffix) →
  // substring match against "Neptune Energy".
  // Post-1.8.3: suffix list dropped "software" → "neptune software"
  // stays as "neptune software" → no substring match against "neptune energy".
  falsy(isOwnBrandCompany('Neptune Energy', [{ name: 'Neptune Software' }]));
});
test('v1.8.3: Neptune Software, Inc. still matches Neptune Software', () => {
  truthy(isOwnBrandCompany('Neptune Software, Inc.', [{ name: 'Neptune Software' }]));
});
test('v1.8.3: short stem (≤4 chars) requires exact match', () => {
  // "Acme Energy" should NOT match brand "Acme" via substring.
  falsy(isOwnBrandCompany('Acme Energy', [{ name: 'Acme' }]));
});
test('regression: exact match on bare brand name still wins', () => {
  truthy(isOwnBrandCompany('Acme', [{ name: 'Acme' }]));
});

console.log('\n[buildGoogleNewsRssUrl — v1.13.0]');
test('encodes plain query into Google News RSS URL', () => {
  const u = buildGoogleNewsRssUrl('office expansion APAC');
  truthy(u.startsWith('https://news.google.com/rss/search?q='), `got: ${u}`);
  truthy(u.includes('hl=en-US'), `got: ${u}`);
  truthy(u.includes('office%20expansion%20APAC') || u.includes('office+expansion+APAC'), `got: ${u}`);
});
test('encodes Boolean operators safely', () => {
  const u = buildGoogleNewsRssUrl('"core banking" OR "digital banking platform"');
  truthy(u.includes('%22core%20banking%22'), `got: ${u}`);
  truthy(u.includes('%20OR%20') || u.includes('+OR+'), `got: ${u}`);
});
test('handles empty / whitespace query', () => {
  eq(buildGoogleNewsRssUrl('   ').endsWith('q=&hl=en-US&gl=US&ceid=US:en'), true);
  eq(buildGoogleNewsRssUrl('').endsWith('q=&hl=en-US&gl=US&ceid=US:en'), true);
});

console.log('\n[computeTrialUntil — v1.13.1 trial-mode helper]');
test('permanent → null', () => {
  eq(computeTrialUntil('permanent'), null);
});
test('24h → +24h timestamp', () => {
  const now = new Date('2026-05-27T10:00:00Z');
  const t = computeTrialUntil('24h', now);
  eq(t, '2026-05-28 10:00:00');
});
test('48h → +48h timestamp', () => {
  const now = new Date('2026-05-27T10:00:00Z');
  eq(computeTrialUntil('48h', now), '2026-05-29 10:00:00');
});
test('7d → +7d timestamp', () => {
  const now = new Date('2026-05-27T10:00:00Z');
  eq(computeTrialUntil('7d', now), '2026-06-03 10:00:00');
});

console.log('\n[groupSourcesByBrand — v1.13.1 source grouping]');
test('splits sources into per-brand, common, unassigned buckets', () => {
  const brands = [
    { id: 1, name: 'Zyeta' },
    { id: 2, name: 'Neptune' },
    { id: 3, name: 'Cisco' }
  ];
  const sources = [
    { id: 1, name: 'A', config: JSON.stringify({ serves_brand_ids: [1] }) },
    { id: 2, name: 'B', config: JSON.stringify({ serves_brand_ids: [2] }) },
    { id: 3, name: 'C', config: JSON.stringify({ serves_brand_ids: [1, 2] }) },
    { id: 4, name: 'D', config: null },
    { id: 5, name: 'E', config: '{}' }
  ];
  const g = groupSourcesByBrand(sources, brands);
  eq(g.perBrand.length, 2);
  eq(g.perBrand[0].brand.name, 'Zyeta');
  eq(g.perBrand[0].sources.map((s) => s.name), ['A']);
  eq(g.perBrand[1].brand.name, 'Neptune');
  eq(g.perBrand[1].sources.map((s) => s.name), ['B']);
  eq(g.common.map((s) => s.name), ['C']);
  eq(g.unassigned.map((s) => s.name), ['D', 'E']);
});
test('orphaned brand IDs (deleted brands) fall into common', () => {
  const brands = [{ id: 1, name: 'Zyeta' }];
  const sources = [
    { id: 1, name: 'A', config: JSON.stringify({ serves_brand_ids: [99] }) }  // deleted brand
  ];
  const g = groupSourcesByBrand(sources, brands);
  eq(g.perBrand.length, 0);
  eq(g.common.map((s) => s.name), ['A']);
});

console.log('\n[operationForStage — v1.11.0 Cost Management bucketing]');
test('brand_research_* and brand_summary → brand_research', () => {
  eq(operationForStage('brand_research'), 'brand_research');
  eq(operationForStage('brand_research_verify'), 'brand_research');
  eq(operationForStage('brand_research_strategic'), 'brand_research');
  eq(operationForStage('brand_research_factcheck'), 'brand_research');
  eq(operationForStage('brand_summary'), 'brand_research');
});
test('research + product_research_* → product_research', () => {
  eq(operationForStage('research'), 'product_research');
  eq(operationForStage('product_research_verify'), 'product_research');
  eq(operationForStage('product_research_strategic'), 'product_research');
  eq(operationForStage('product_research_factcheck'), 'product_research');
});
test('brand_signals + product_signals + refresh_signals → signal_research', () => {
  eq(operationForStage('brand_signals'), 'signal_research');
  eq(operationForStage('product_signals'), 'signal_research');
  eq(operationForStage('refresh_signals'), 'signal_research');
});
test('deep_scan_* and legacy deep_scan → deep_scan', () => {
  eq(operationForStage('deep_scan'), 'deep_scan');
  eq(operationForStage('deep_scan_discovery'), 'deep_scan');
  eq(operationForStage('deep_scan_qualify'), 'deep_scan');
});
test('triage + qualify → live_monitor', () => {
  eq(operationForStage('triage'), 'live_monitor');
  eq(operationForStage('qualify'), 'live_monitor');
});
test('brief → sales_brief', () => {
  eq(operationForStage('brief'), 'sales_brief');
});
test('unknown / unmapped stage → other', () => {
  eq(operationForStage('unknown'), 'other');
  eq(operationForStage('made_up_stage'), 'other');
  eq(operationForStage(''), 'other');
});
test('contact_* stages → contact_outreach (v1.19.0)', () => {
  eq(operationForStage('contact_archetype'), 'contact_outreach');
  eq(operationForStage('contact_draft'), 'contact_outreach');
  eq(operationForStage('contact_lookup'), 'contact_outreach');
});
test('brand_source_research → source_research (v1.13.0)', () => {
  eq(operationForStage('brand_source_research'), 'source_research');
});
test('bucketByOperation sums calls and cost per operation', () => {
  const rows = [
    { stage: 'brand_research', calls: 2, cost: 0.4 },
    { stage: 'brand_research_verify', calls: 2, cost: 0.8 },
    { stage: 'manual_scan', calls: 5, cost: 0.15 },
    { stage: 'triage', calls: 100, cost: 0.5 },
    { stage: 'qualify', calls: 8, cost: 0.16 }
  ];
  const buckets = bucketByOperation(rows);
  const get = (op) => buckets.find((b) => b.operation === op);
  const round = (n) => Math.round(n * 100) / 100;
  eq(get('brand_research').calls, 4);
  eq(round(get('brand_research').cost), 1.2);  // 0.4 + 0.8 = 1.2000…002 in JS
  eq(get('manual_scan').calls, 5);
  eq(get('live_monitor').calls, 108);
  eq(round(get('live_monitor').cost), 0.66);
});
test('bucketByOperation drops buckets with zero calls', () => {
  const rows = [{ stage: 'brief', calls: 1, cost: 0.5 }];
  const buckets = bucketByOperation(rows);
  eq(buckets.length, 1);
  eq(buckets[0].operation, 'sales_brief');
});
test('bucketByOperation preserves operation order', () => {
  const rows = [
    { stage: 'brief', calls: 1, cost: 0.5 },
    { stage: 'brand_research', calls: 1, cost: 0.5 },
    { stage: 'manual_scan', calls: 1, cost: 0.5 }
  ];
  const buckets = bucketByOperation(rows);
  eq(buckets.map((b) => b.operation), ['brand_research', 'manual_scan', 'sales_brief']);
});

console.log('\n[stage4SourceCoverage — v1.10.3 chip threshold helper]');
test('parses 9/10 sources → 0.9', () => {
  eq(stage4SourceCoverage('partial: 9/10 sources verified (1 unreachable)'), 0.9);
});
test('parses 5/10 sources → 0.5', () => {
  eq(stage4SourceCoverage('partial: 5/10 sources verified (5 unreachable)'), 0.5);
});
test('parses 1/10 sources → 0.1', () => {
  eq(stage4SourceCoverage('partial: only 1/10 sources reachable — skipped Opus call'), 0.1);
});
test('returns null for non-partial status', () => {
  eq(stage4SourceCoverage('completed'), null);
  eq(stage4SourceCoverage('failed: Opus API error'), null);
  eq(stage4SourceCoverage(undefined), null);
});
test('returns null when no K/N pattern present', () => {
  eq(stage4SourceCoverage('partial: something went wrong'), null);
});

console.log('\n[dossier-factcheck — v1.10.2 source-gating helpers]');
test('clampCitationList dedupes and caps to max', () => {
  const out = clampCitationList(['a', 'b', 'a', 'c', 'd', 'e'], 3);
  eq(out, ['a', 'b', 'c']);
});
test('clampCitationList drops empty and whitespace entries', () => {
  const out = clampCitationList(['', '  ', 'http://x', '   ', 'http://y'], 10);
  eq(out, ['http://x', 'http://y']);
});
test('clampCitationList returns [] on null/undefined input', () => {
  eq(clampCitationList(null, 5), []);
  eq(clampCitationList(undefined, 5), []);
});
test('shouldAttemptOpusCall requires at least 2 sources by default', () => {
  falsy(shouldAttemptOpusCall(0));
  falsy(shouldAttemptOpusCall(1));
  truthy(shouldAttemptOpusCall(2));
  truthy(shouldAttemptOpusCall(10));
});
test('extractCitationsFromRawDossier pulls citation array', () => {
  const raw = JSON.stringify({ stage1: { foo: 1 }, citations: ['http://a', 'http://b'] });
  eq(extractCitationsFromRawDossier(raw), ['http://a', 'http://b']);
});
test('extractCitationsFromRawDossier returns [] on malformed input', () => {
  eq(extractCitationsFromRawDossier(null), []);
  eq(extractCitationsFromRawDossier('not json'), []);
  eq(extractCitationsFromRawDossier('{}'), []);
  eq(extractCitationsFromRawDossier(JSON.stringify({ citations: 'not array' })), []);
});

console.log('\n[modelSupportsTemperature — v1.10.1]');
test('Claude Opus 4.7 returns false (deprecated)', () => {
  falsy(modelSupportsTemperature('claude-opus-4-7'));
});
test('Claude Sonnet 4.6 returns true', () => {
  truthy(modelSupportsTemperature('claude-sonnet-4-6'));
});
test('Claude Haiku 4.5 returns true', () => {
  truthy(modelSupportsTemperature('claude-haiku-4-5-20251001'));
});
test('Unknown future model returns true (default-allow)', () => {
  truthy(modelSupportsTemperature('claude-sonnet-5-0-future'));
});

console.log('\n[signal-research — v1.9.3 shape-tolerant parsing]');
test('extractSignalsField pulls canonical { signals: "..." }', () => {
  eq(extractSignalsField({ signals: '- a\n- b' }), '- a\n- b');
});
test('extractSignalsField coerces array signals to bullets', () => {
  eq(extractSignalsField({ signals: ['a', 'b'] }), '- a\n- b');
});
test('extractSignalsField accepts variant key names (bullets)', () => {
  eq(extractSignalsField({ bullets: '- one\n- two' }), '- one\n- two');
});
test('extractSignalsField accepts variant key names (signal singular)', () => {
  eq(extractSignalsField({ signal: '- x' }), '- x');
});
test('extractSignalsField returns null when no usable shape', () => {
  eq(extractSignalsField({ description: 'no signals here' }), null);
  eq(extractSignalsField(null), null);
  eq(extractSignalsField('a string'), null);
});
test('extractSignalsField skips empty string and empty array', () => {
  eq(extractSignalsField({ signals: '   ' }), null);
  eq(extractSignalsField({ signals: [] }), null);
});
test('extractBulletsFromText pulls markdown bullets out of raw text', () => {
  const text = 'Here are the signals:\n- alpha\n- beta\nThanks!';
  eq(extractBulletsFromText(text), '- alpha\n- beta');
});
test('extractBulletsFromText normalizes • and * bullets to -', () => {
  eq(extractBulletsFromText('• one\n* two\n- three'), '- one\n- two\n- three');
});
test('extractBulletsFromText returns null when no bullets present', () => {
  eq(extractBulletsFromText('just prose, no bullets'), null);
  eq(extractBulletsFromText(''), null);
});

console.log('\n[feedback — v1.9.2]');
test('validateFeedbackInput rejects empty string', () => {
  try {
    validateFeedbackInput('   ');
    throw new Error('expected to throw');
  } catch (e) {
    truthy(/cannot be empty/i.test(e.message), `got: ${e.message}`);
  }
});
test('validateFeedbackInput rejects 4001-char string', () => {
  const long = 'x'.repeat(4001);
  try {
    validateFeedbackInput(long);
    throw new Error('expected to throw');
  } catch (e) {
    truthy(/too long/i.test(e.message), `got: ${e.message}`);
  }
});
test('validateFeedbackInput accepts 4000-char string exactly', () => {
  const max = 'x'.repeat(4000);
  eq(validateFeedbackInput(max), max);
});
test('buildFeedbackBlockFrom returns empty string when no entries', () => {
  eq(buildFeedbackBlockFrom([]), '');
  eq(buildFeedbackBlockFrom(null), '');
});
test('buildFeedbackBlockFrom truncates oldest entries when over budget', () => {
  // Build 5 entries of ~4000 chars each = ~20K chars total.
  // FEEDBACK_BLOCK_MAX_CHARS = 16000, so only the first ~3-4 newest entries
  // should fit. Verify newest-first ordering and that older ones drop.
  const entries = [];
  for (let i = 0; i < 5; i++) {
    entries.push({
      feedback: 'F' + String(i) + ' '.repeat(3998),
      created_at: `2026-05-${20 + i}T00:00:00`
    });
  }
  // Sort newest-first like the DB query would.
  entries.sort((a, b) => b.created_at.localeCompare(a.created_at));
  const block = buildFeedbackBlockFrom(entries);
  truthy(block.length <= FEEDBACK_BLOCK_MAX_CHARS, `block.length=${block.length}`);
  truthy(block.includes('F4'), 'newest (F4) should be included');
  // The oldest (F0) shouldn't fit in 16K when entries are ~4K each.
  falsy(block.includes('F0 '), 'oldest (F0) should be truncated out');
});

// ════════════════════════════════════════════════════════════════════════
// v1.14.0 — cron-free scheduler helpers (src/shared/schedule.ts).
//
// MUST stay byte-identical with the production source per the file-header
// rule. Renderer's Settings card no longer accepts a cron string; instead
// users pick a frequency + time and we synthesize the cron via
// scheduleToCron. cronToSchedule reads the persisted string back into
// picker state on app load. Defensive: cronToSchedule never throws — it
// falls back to DEFAULT_SCHEDULE on any unrecognized pattern.
// ════════════════════════════════════════════════════════════════════════

const DEFAULT_SCHEDULE = { freq: 'twice', hours: [9, 21], dayOfWeek: 1 };

function clampHour(h) {
  if (!Number.isFinite(h)) return 9;
  return Math.max(0, Math.min(23, Math.round(h)));
}
function clampDow(d) {
  if (!Number.isFinite(d)) return 1;
  return Math.max(0, Math.min(6, Math.round(d)));
}

function scheduleToCron(s) {
  switch (s.freq) {
    case 'daily': {
      const h = clampHour(s.hours[0] ?? 9);
      return `0 ${h} * * *`;
    }
    case 'twice': {
      const h1 = clampHour(s.hours[0] ?? 9);
      const h2 = clampHour(s.hours[1] ?? 21);
      return `0 ${h1},${h2} * * *`;
    }
    case 'every6':
      return '0 */6 * * *';
    case 'every12':
      return '0 */12 * * *';
    case 'weekly': {
      const h = clampHour(s.hours[0] ?? 9);
      const d = clampDow(s.dayOfWeek);
      return `0 ${h} * * ${d}`;
    }
  }
}

function cronToSchedule(cron) {
  if (!cron || typeof cron !== 'string') return { ...DEFAULT_SCHEDULE };
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return { ...DEFAULT_SCHEDULE };
  const [min, hour, dom, month, dow] = parts;
  if (min !== '0' || dom !== '*' || month !== '*') return { ...DEFAULT_SCHEDULE };
  if (hour === '*/6' && dow === '*')  return { freq: 'every6',  hours: [], dayOfWeek: 1 };
  if (hour === '*/12' && dow === '*') return { freq: 'every12', hours: [], dayOfWeek: 1 };
  if (dow !== '*' && /^\d+$/.test(hour) && /^\d+$/.test(dow)) {
    const h = Number(hour);
    const d = Number(dow);
    if (h >= 0 && h <= 23 && d >= 0 && d <= 6) {
      return { freq: 'weekly', hours: [h], dayOfWeek: d };
    }
  }
  if (dow === '*' && /^\d+,\d+$/.test(hour)) {
    const [h1, h2] = hour.split(',').map(Number);
    if ([h1, h2].every((h) => Number.isFinite(h) && h >= 0 && h <= 23)) {
      return { freq: 'twice', hours: [h1, h2], dayOfWeek: 1 };
    }
  }
  if (dow === '*' && /^\d+$/.test(hour)) {
    const h = Number(hour);
    if (h >= 0 && h <= 23) {
      return { freq: 'daily', hours: [h], dayOfWeek: 1 };
    }
  }
  return { ...DEFAULT_SCHEDULE };
}

test('scheduleToCron — daily at 9am', () => {
  eq(scheduleToCron({ freq: 'daily', hours: [9], dayOfWeek: 1 }), '0 9 * * *');
});
test('scheduleToCron — daily at midnight', () => {
  eq(scheduleToCron({ freq: 'daily', hours: [0], dayOfWeek: 1 }), '0 0 * * *');
});
test('scheduleToCron — twice daily 9am/9pm', () => {
  eq(scheduleToCron({ freq: 'twice', hours: [9, 21], dayOfWeek: 1 }), '0 9,21 * * *');
});
test('scheduleToCron — every 6 hours ignores hours/dow', () => {
  eq(scheduleToCron({ freq: 'every6', hours: [99], dayOfWeek: 9 }), '0 */6 * * *');
});
test('scheduleToCron — every 12 hours', () => {
  eq(scheduleToCron({ freq: 'every12', hours: [], dayOfWeek: 1 }), '0 */12 * * *');
});
test('scheduleToCron — weekly Monday 9am', () => {
  eq(scheduleToCron({ freq: 'weekly', hours: [9], dayOfWeek: 1 }), '0 9 * * 1');
});
test('scheduleToCron — weekly Sunday 6pm', () => {
  eq(scheduleToCron({ freq: 'weekly', hours: [18], dayOfWeek: 0 }), '0 18 * * 0');
});
test('scheduleToCron — clamps out-of-range hour', () => {
  eq(scheduleToCron({ freq: 'daily', hours: [25], dayOfWeek: 1 }), '0 23 * * *');
});
test('scheduleToCron — clamps negative hour', () => {
  eq(scheduleToCron({ freq: 'daily', hours: [-5], dayOfWeek: 1 }), '0 0 * * *');
});

test('cronToSchedule — daily at 9am', () => {
  eq(cronToSchedule('0 9 * * *'), { freq: 'daily', hours: [9], dayOfWeek: 1 });
});
test('cronToSchedule — twice daily 9am/9pm', () => {
  eq(cronToSchedule('0 9,21 * * *'), { freq: 'twice', hours: [9, 21], dayOfWeek: 1 });
});
test('cronToSchedule — every 6 hours', () => {
  eq(cronToSchedule('0 */6 * * *'), { freq: 'every6', hours: [], dayOfWeek: 1 });
});
test('cronToSchedule — every 12 hours', () => {
  eq(cronToSchedule('0 */12 * * *'), { freq: 'every12', hours: [], dayOfWeek: 1 });
});
test('cronToSchedule — weekly Mon 9am', () => {
  eq(cronToSchedule('0 9 * * 1'), { freq: 'weekly', hours: [9], dayOfWeek: 1 });
});
test('cronToSchedule — falls back to default on garbage', () => {
  eq(cronToSchedule('this is not cron'), DEFAULT_SCHEDULE);
});
test('cronToSchedule — falls back on partial cron', () => {
  eq(cronToSchedule('0 9'), DEFAULT_SCHEDULE);
});
test('cronToSchedule — falls back on non-zero minute (we only produce minute=0)', () => {
  eq(cronToSchedule('15 9 * * *'), DEFAULT_SCHEDULE);
});
test('cronToSchedule — falls back on null/undefined', () => {
  eq(cronToSchedule(null), DEFAULT_SCHEDULE);
  eq(cronToSchedule(undefined), DEFAULT_SCHEDULE);
});

// Round-trip property: every cron we emit must parse back to the schedule
// that produced it. Guards against drift between the two helpers.
test('round-trip — daily 9am', () => {
  const s = { freq: 'daily', hours: [9], dayOfWeek: 1 };
  eq(cronToSchedule(scheduleToCron(s)), s);
});
test('round-trip — twice daily 9am/9pm', () => {
  const s = { freq: 'twice', hours: [9, 21], dayOfWeek: 1 };
  eq(cronToSchedule(scheduleToCron(s)), s);
});
test('round-trip — every 6 hours', () => {
  const s = { freq: 'every6', hours: [], dayOfWeek: 1 };
  eq(cronToSchedule(scheduleToCron(s)), s);
});
test('round-trip — every 12 hours', () => {
  const s = { freq: 'every12', hours: [], dayOfWeek: 1 };
  eq(cronToSchedule(scheduleToCron(s)), s);
});
test('round-trip — weekly Saturday 3pm', () => {
  const s = { freq: 'weekly', hours: [15], dayOfWeek: 6 };
  eq(cronToSchedule(scheduleToCron(s)), s);
});

// ════════════════════════════════════════════════════════════════════════
// v1.15.0 — signals helpers (src/shared/signals.ts).
//
// MUST stay byte-identical with production. The renderer's
// EditableSignalList writes via these for serialization, and
// signal-research.ts reads via these for the post-LLM merge that
// enforces locked signals across re-research.
// ════════════════════════════════════════════════════════════════════════

function parseSignalsBlob(raw) {
  if (!raw) return [];
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => l.replace(/^[-*•]\s*/, '').trim())
    .filter((l) => l.length > 0);
}

function serializeSignals(bullets) {
  return bullets
    .map((b) => b.trim())
    .filter((b) => b.length > 0)
    .map((b) => `- ${b}`)
    .join('\n');
}

function parseLockedSignals(raw) {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((s) => typeof s === 'string' && s.trim().length > 0);
  } catch {
    return [];
  }
}

function serializeLockedSignals(locked) {
  return JSON.stringify(locked.filter((s) => typeof s === 'string' && s.trim().length > 0));
}

function mergeLockedIntoSignals(llmBullets, locked) {
  const cleanLocked = locked.map((s) => s.trim()).filter((s) => s.length > 0);
  const lockedSet = new Set(cleanLocked);
  const fresh = llmBullets
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .filter((s) => !lockedSet.has(s));
  return [...cleanLocked, ...fresh];
}

function renameLockedSignal(locked, oldText, newText) {
  const newTrim = newText.trim();
  if (!newTrim) return locked.filter((s) => s !== oldText);
  return locked.map((s) => (s === oldText ? newTrim : s));
}

function removeLockedSignal(locked, text) {
  return locked.filter((s) => s !== text);
}

// parseSignalsBlob ───────────────────────────────────────────────
test('parseSignalsBlob — strips - bullet marker', () => {
  eq(parseSignalsBlob('- foo\n- bar'), ['foo', 'bar']);
});
test('parseSignalsBlob — strips * and • markers', () => {
  eq(parseSignalsBlob('* foo\n• bar'), ['foo', 'bar']);
});
test('parseSignalsBlob — drops empty + whitespace lines', () => {
  eq(parseSignalsBlob('- foo\n\n  \n- bar'), ['foo', 'bar']);
});
test('parseSignalsBlob — returns [] for null/empty', () => {
  eq(parseSignalsBlob(null), []);
  eq(parseSignalsBlob(''), []);
  eq(parseSignalsBlob(undefined), []);
});

// serializeSignals ──────────────────────────────────────────────
test('serializeSignals — round-trips through parse', () => {
  const bullets = ['APAC HQ relocation', 'Lease renewal'];
  eq(parseSignalsBlob(serializeSignals(bullets)), bullets);
});
test('serializeSignals — drops empty strings', () => {
  eq(serializeSignals(['foo', '', '  ', 'bar']), '- foo\n- bar');
});

// parseLockedSignals ────────────────────────────────────────────
test('parseLockedSignals — parses JSON array', () => {
  eq(parseLockedSignals('["foo","bar"]'), ['foo', 'bar']);
});
test('parseLockedSignals — returns [] for malformed JSON', () => {
  eq(parseLockedSignals('not json'), []);
  eq(parseLockedSignals('{"oops": true}'), []);
});
test('parseLockedSignals — drops non-string entries', () => {
  eq(parseLockedSignals('["foo", 42, null, "bar"]'), ['foo', 'bar']);
});
test('parseLockedSignals — returns [] for null/empty', () => {
  eq(parseLockedSignals(null), []);
  eq(parseLockedSignals(''), []);
});

// mergeLockedIntoSignals ────────────────────────────────────────
test('mergeLocked — locked first, LLM fresh follows', () => {
  eq(
    mergeLockedIntoSignals(['c', 'd'], ['a', 'b']),
    ['a', 'b', 'c', 'd']
  );
});
test('mergeLocked — dedupes LLM output that matches locked', () => {
  eq(
    mergeLockedIntoSignals(['a', 'c', 'b'], ['a', 'b']),
    ['a', 'b', 'c']
  );
});
test('mergeLocked — force-inserts locked even when LLM dropped them', () => {
  // Critical regression guard: this is the safety net for when Perplexity
  // ignores the prompt-side instruction to keep locked signals.
  eq(
    mergeLockedIntoSignals(['x', 'y'], ['pinned1', 'pinned2']),
    ['pinned1', 'pinned2', 'x', 'y']
  );
});
test('mergeLocked — no locked = LLM output unchanged (just trimmed)', () => {
  eq(
    mergeLockedIntoSignals(['  foo  ', 'bar'], []),
    ['foo', 'bar']
  );
});
test('mergeLocked — all locked (LLM returned nothing new)', () => {
  eq(
    mergeLockedIntoSignals([], ['a', 'b']),
    ['a', 'b']
  );
});
test('mergeLocked — near-duplicates pass through (no semantic dedupe)', () => {
  // Recommend-accept-duplicate decision: we don't auto-dedupe by similarity
  // because it risks silently dropping legitimately different signals.
  eq(
    mergeLockedIntoSignals(['APAC HQ relocations'], ['APAC headquarter relocations']),
    ['APAC headquarter relocations', 'APAC HQ relocations']
  );
});

// renameLockedSignal ────────────────────────────────────────────
test('renameLocked — replaces matching entry in place', () => {
  eq(
    renameLockedSignal(['a', 'b', 'c'], 'b', 'B-new'),
    ['a', 'B-new', 'c']
  );
});
test('renameLocked — no-op when old text not locked', () => {
  eq(
    renameLockedSignal(['a', 'b'], 'z', 'Z-new'),
    ['a', 'b']
  );
});
test('renameLocked — empty new text removes the lock', () => {
  eq(
    renameLockedSignal(['a', 'b'], 'b', '   '),
    ['a']
  );
});

// removeLockedSignal ────────────────────────────────────────────
test('removeLocked — removes exact match', () => {
  eq(removeLockedSignal(['a', 'b', 'c'], 'b'), ['a', 'c']);
});
test('removeLocked — no-op when not present', () => {
  eq(removeLockedSignal(['a', 'b'], 'z'), ['a', 'b']);
});

// Round-trip integrity ─────────────────────────────────────────
test('signals round-trip — serialize→parse preserves bullets', () => {
  const bullets = ['First signal', 'Second signal', 'Third signal'];
  eq(parseSignalsBlob(serializeSignals(bullets)), bullets);
});
test('locked round-trip — serialize→parse preserves locks', () => {
  const locked = ['pinned A', 'pinned B'];
  eq(parseLockedSignals(serializeLockedSignals(locked)), locked);
});

// ════════════════════════════════════════════════════════════════════════
// v1.16.0 — lifecycle event log (src/shared/lifecycle.ts).
//
// MUST stay byte-identical with production. projectOpportunityState is
// the source of truth for derived state; the main process uses it to
// populate opportunity_state_cache, and the renderer uses it through the
// state cache to render lifecycle widgets.
//
// Key correctness properties tested:
//   - Empty event list returns null (no opportunity, no state).
//   - Reopen-after-close clears close_value but keeps history.
//   - Latest close event wins for learning (effective_close_event_id).
//   - delivered_at is set only on the FIRST delivered event (idempotent).
//   - Cycle days computed as floor((closed - delivered) / 1 day).
//   - eventValidator enforces controlled vocab on rejected/lost/won.
//   - timeDecayWeight follows half-life math correctly.
// ════════════════════════════════════════════════════════════════════════

const REJECTION_REASONS = [
  { code: 'not_icp_fit', label: 'Not ICP fit' },
  { code: 'wrong_industry', label: 'Wrong industry' },
  { code: 'too_small', label: 'Company too small' },
  { code: 'too_large', label: 'Company too large' },
  { code: 'bad_timing', label: 'Bad timing' },
  { code: 'bad_data', label: 'Bad data / hallucination' },
  { code: 'duplicate', label: 'Already in pipeline (duplicate)' },
  { code: 'other', label: 'Other' }
];

const CLOSE_LOST_REASONS = [
  { code: 'budget', label: 'No budget' },
  { code: 'timing', label: 'Timing mismatch' },
  { code: 'competitor_won', label: 'Competitor won' },
  { code: 'no_decision', label: 'No decision made' },
  { code: 'internal_priority_shift', label: 'Internal priority shift' },
  { code: 'fit_mismatch', label: 'Product fit mismatch' },
  { code: 'champion_left', label: 'Champion left the company' },
  { code: 'other', label: 'Other' }
];

const CLOSE_WON_FACTORS = [
  { code: 'compelling_event', label: 'Compelling event' },
  { code: 'relationship', label: 'Existing relationship' },
  { code: 'product_fit', label: 'Strong product fit' },
  { code: 'price', label: 'Price advantage' },
  { code: 'urgency', label: 'Urgency / deadline' },
  { code: 'other', label: 'Other' }
];

function parsePayload(json) {
  if (!json) return null;
  try { return JSON.parse(json); } catch { return null; }
}

function computeCycleDaysFromAnchors(deliveredAt, closedAt) {
  if (!deliveredAt || !closedAt) return null;
  const start = Date.parse(deliveredAt);
  const end = Date.parse(closedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  const days = Math.floor((end - start) / 86400000);
  return days < 0 ? 0 : days;
}

function projectOpportunityState(events) {
  if (events.length === 0) return null;
  const sorted = [...events].sort((a, b) => {
    const t = (a.occurred_at || '').localeCompare(b.occurred_at || '');
    return t !== 0 ? t : a.id - b.id;
  });

  let stage = 'created';
  let delivered_at = null;
  let accepted_at = null;
  let closed_at = null;
  let close_value = null;
  let close_currency = null;
  let primary_factor = null;
  let is_closed_won = false;
  let is_closed_lost = false;
  let effective_close_event_id = null;

  for (const event of sorted) {
    const payload = parsePayload(event.payload_json);
    switch (event.event_type) {
      case 'created':
        stage = 'created';
        break;
      case 'delivered':
        stage = 'delivered';
        if (!delivered_at) delivered_at = event.occurred_at;
        break;
      case 'accepted':
        stage = 'accepted';
        if (!accepted_at) accepted_at = event.occurred_at;
        is_closed_won = false;
        is_closed_lost = false;
        close_value = null;
        close_currency = null;
        primary_factor = null;
        closed_at = null;
        effective_close_event_id = null;
        break;
      case 'rejected':
        stage = 'rejected';
        break;
      case 'engaged':
        stage = 'engaged';
        break;
      case 'proposal_sent':
        stage = 'proposal_sent';
        break;
      case 'closed_won':
        stage = 'closed_won';
        closed_at = event.occurred_at;
        close_value = typeof payload?.amount === 'number' ? payload.amount : null;
        close_currency = typeof payload?.currency === 'string' ? payload.currency : 'USD';
        primary_factor = typeof payload?.primary_factor === 'string' ? payload.primary_factor : null;
        is_closed_won = true;
        is_closed_lost = false;
        effective_close_event_id = event.id;
        break;
      case 'closed_lost':
        stage = 'closed_lost';
        closed_at = event.occurred_at;
        close_value = null;
        close_currency = null;
        primary_factor = typeof payload?.reason_code === 'string' ? payload.reason_code : null;
        is_closed_won = false;
        is_closed_lost = true;
        effective_close_event_id = event.id;
        break;
      case 'archived':
        stage = 'archived';
        break;
      case 'reopened':
        if (accepted_at) {
          stage = 'accepted';
        } else if (delivered_at) {
          stage = 'delivered';
        } else {
          stage = 'created';
        }
        is_closed_won = false;
        is_closed_lost = false;
        close_value = null;
        close_currency = null;
        primary_factor = null;
        closed_at = null;
        effective_close_event_id = null;
        break;
    }
  }

  const cycle_days = computeCycleDaysFromAnchors(delivered_at, closed_at);
  const last = sorted[sorted.length - 1];

  return {
    current_stage: stage,
    delivered_at,
    accepted_at,
    closed_at,
    close_value,
    close_currency,
    cycle_days,
    primary_factor,
    is_closed_won,
    is_closed_lost,
    effective_close_event_id,
    last_event_id: last.id,
    last_event_at: last.occurred_at
  };
}

function eventValidator(type, payload) {
  switch (type) {
    case 'created':
    case 'delivered':
    case 'accepted':
    case 'archived':
    case 'reopened':
    case 'engaged':
    case 'proposal_sent':
      return null;
    case 'rejected':
      if (payload?.reason_code && !REJECTION_REASONS.some((r) => r.code === payload.reason_code)) {
        return `rejected.reason_code must be one of: ${REJECTION_REASONS.map((r) => r.code).join(', ')}`;
      }
      return null;
    case 'closed_won':
      if (payload?.amount !== undefined && payload.amount !== null) {
        if (typeof payload.amount !== 'number' || !Number.isFinite(payload.amount) || payload.amount < 0) {
          return 'closed_won.amount must be a non-negative number';
        }
      }
      if (payload?.primary_factor && !CLOSE_WON_FACTORS.some((f) => f.code === payload.primary_factor)) {
        return `closed_won.primary_factor must be one of: ${CLOSE_WON_FACTORS.map((f) => f.code).join(', ')}`;
      }
      return null;
    case 'closed_lost':
      if (!payload?.reason_code) {
        return 'closed_lost.reason_code is required for learning';
      }
      if (!CLOSE_LOST_REASONS.some((r) => r.code === payload.reason_code)) {
        return `closed_lost.reason_code must be one of: ${CLOSE_LOST_REASONS.map((r) => r.code).join(', ')}`;
      }
      return null;
    default:
      return `unknown event type: ${type}`;
  }
}

function isStale(events, thresholdDays, nowIso) {
  const state = projectOpportunityState(events);
  if (!state) return false;
  const workingStages = ['delivered', 'accepted', 'engaged', 'proposal_sent'];
  if (!workingStages.includes(state.current_stage)) return false;
  const now = Date.parse(nowIso);
  const last = Date.parse(state.last_event_at);
  if (Number.isNaN(now) || Number.isNaN(last)) return false;
  const ageMs = now - last;
  return ageMs > thresholdDays * 86400000;
}

function timeDecayWeight(occurredAt, halfLifeDays, nowIso) {
  const occurred = Date.parse(occurredAt);
  const now = Date.parse(nowIso);
  if (Number.isNaN(occurred) || Number.isNaN(now) || halfLifeDays <= 0) return 1;
  const ageDays = Math.max(0, (now - occurred) / 86400000);
  return Math.pow(0.5, ageDays / halfLifeDays);
}

// Test helpers ─────────────────────────────────────────────────────────
let nextEventId = 1;
function mkEvent(type, occurredAt, payload) {
  return {
    id: nextEventId++,
    tenant_id: 1,
    opportunity_id: 1,
    event_type: type,
    payload_json: payload ? JSON.stringify(payload) : null,
    occurred_at: occurredAt,
    recorded_at: occurredAt,
    actor_kind: 'user',
    actor_id: null,
    provenance: null,
    embedding: null
  };
}
function resetEventIds() { nextEventId = 1; }

// projectOpportunityState ──────────────────────────────────────────────
test('project — empty events → null', () => {
  eq(projectOpportunityState([]), null);
});
test('project — single created event', () => {
  resetEventIds();
  const s = projectOpportunityState([mkEvent('created', '2026-05-01T10:00:00Z')]);
  eq(s.current_stage, 'created');
  eq(s.delivered_at, null);
  eq(s.is_closed_won, false);
});
test('project — full happy path: created → delivered → accepted → engaged → closed_won', () => {
  resetEventIds();
  const events = [
    mkEvent('created',       '2026-05-01T10:00:00Z'),
    mkEvent('delivered',     '2026-05-02T10:00:00Z'),
    mkEvent('accepted',      '2026-05-03T10:00:00Z'),
    mkEvent('engaged',       '2026-05-05T10:00:00Z'),
    mkEvent('closed_won',    '2026-05-20T10:00:00Z', { amount: 50000, primary_factor: 'product_fit' })
  ];
  const s = projectOpportunityState(events);
  eq(s.current_stage, 'closed_won');
  eq(s.is_closed_won, true);
  eq(s.close_value, 50000);
  eq(s.primary_factor, 'product_fit');
  eq(s.cycle_days, 18);  // delivered 2026-05-02 → closed 2026-05-20 = 18 days
  truthy(s.effective_close_event_id !== null);
});
test('project — closed_won without amount still records the win', () => {
  resetEventIds();
  const events = [
    mkEvent('delivered',  '2026-05-02T10:00:00Z'),
    mkEvent('closed_won', '2026-05-10T10:00:00Z') // no payload
  ];
  const s = projectOpportunityState(events);
  eq(s.is_closed_won, true);
  eq(s.close_value, null);
});
test('project — closed_lost requires reason_code in payload', () => {
  resetEventIds();
  const events = [
    mkEvent('delivered',   '2026-05-02T10:00:00Z'),
    mkEvent('closed_lost', '2026-05-10T10:00:00Z', { reason_code: 'budget' })
  ];
  const s = projectOpportunityState(events);
  eq(s.is_closed_lost, true);
  eq(s.primary_factor, 'budget');
});
test('project — reopen-after-close clears close state but keeps stage as "accepted"', () => {
  resetEventIds();
  const events = [
    mkEvent('delivered',   '2026-05-02T10:00:00Z'),
    mkEvent('accepted',    '2026-05-03T10:00:00Z'),
    mkEvent('closed_lost', '2026-05-10T10:00:00Z', { reason_code: 'budget' }),
    mkEvent('reopened',    '2026-05-15T10:00:00Z', { note: 'budget freed up' })
  ];
  const s = projectOpportunityState(events);
  eq(s.current_stage, 'accepted');
  eq(s.is_closed_won, false);
  eq(s.is_closed_lost, false);
  eq(s.close_value, null);
  eq(s.effective_close_event_id, null);
});
test('project — reopen-then-close-again: latest close wins for learning', () => {
  // Per Decide 4: when reopened then closed again, the latest close is
  // authoritative for learning. History is preserved (4 events still in
  // the log) but only the final closed_won drives effective_close_event_id.
  resetEventIds();
  const events = [
    mkEvent('delivered',   '2026-05-02T10:00:00Z'),
    mkEvent('closed_lost', '2026-05-10T10:00:00Z', { reason_code: 'timing' }),
    mkEvent('reopened',    '2026-05-15T10:00:00Z'),
    mkEvent('closed_won',  '2026-05-20T10:00:00Z', { amount: 42000, primary_factor: 'urgency' })
  ];
  const s = projectOpportunityState(events);
  eq(s.current_stage, 'closed_won');
  eq(s.is_closed_won, true);
  eq(s.is_closed_lost, false);
  eq(s.close_value, 42000);
  // The effective close event is the LATEST (closed_won), not the earlier closed_lost.
  truthy(s.effective_close_event_id !== null);
  // events sorted by occurred_at — the closed_won is event #4.
  eq(s.effective_close_event_id, 4);
});
test('project — delivered_at is set only on the FIRST delivered event (idempotent on reset-reopen)', () => {
  resetEventIds();
  const events = [
    mkEvent('delivered', '2026-05-02T10:00:00Z'),
    mkEvent('accepted',  '2026-05-03T10:00:00Z'),
    mkEvent('delivered', '2026-05-10T10:00:00Z') // shouldn't overwrite original
  ];
  const s = projectOpportunityState(events);
  eq(s.delivered_at, '2026-05-02T10:00:00Z');
});
test('project — accepted-after-close clears close state (implicit reopen)', () => {
  resetEventIds();
  const events = [
    mkEvent('delivered',   '2026-05-02T10:00:00Z'),
    mkEvent('closed_won',  '2026-05-10T10:00:00Z', { amount: 50000 }),
    mkEvent('accepted',    '2026-05-15T10:00:00Z')
  ];
  const s = projectOpportunityState(events);
  eq(s.current_stage, 'accepted');
  eq(s.is_closed_won, false);
  eq(s.close_value, null);
});
test('project — cycle days never negative', () => {
  resetEventIds();
  const events = [
    mkEvent('delivered',  '2026-05-10T10:00:00Z'),
    mkEvent('closed_won', '2026-05-01T10:00:00Z') // earlier than delivered (data anomaly)
  ];
  const s = projectOpportunityState(events);
  // sorted by occurred_at, closed_won comes first; delivered comes later.
  // So delivered_at is set after the close. Cycle would compute negative
  // if we used the events directly, but we clamp to 0.
  eq(s.cycle_days, 0);
});

// eventValidator ───────────────────────────────────────────────────────
test('validator — closed_lost without reason_code → error', () => {
  const err = eventValidator('closed_lost', {});
  truthy(err !== null);
});
test('validator — closed_lost with unknown reason_code → error', () => {
  const err = eventValidator('closed_lost', { reason_code: 'made_up' });
  truthy(err !== null);
});
test('validator — closed_lost with valid reason_code → null', () => {
  eq(eventValidator('closed_lost', { reason_code: 'budget' }), null);
});
test('validator — closed_won with negative amount → error', () => {
  const err = eventValidator('closed_won', { amount: -100 });
  truthy(err !== null);
});
test('validator — closed_won without amount → null (per Decide 5: optional)', () => {
  eq(eventValidator('closed_won', {}), null);
});
test('validator — closed_won with unknown primary_factor → error', () => {
  const err = eventValidator('closed_won', { primary_factor: 'wishful_thinking' });
  truthy(err !== null);
});
test('validator — rejected with unknown reason_code → error', () => {
  const err = eventValidator('rejected', { reason_code: 'just_because' });
  truthy(err !== null);
});
test('validator — unknown event_type → error', () => {
  const err = eventValidator('teleported', {});
  truthy(err !== null);
});

// isStale ───────────────────────────────────────────────────────────────
test('isStale — opportunity 30 days untouched in accepted → stale', () => {
  resetEventIds();
  const events = [
    mkEvent('delivered', '2026-04-01T10:00:00Z'),
    mkEvent('accepted',  '2026-04-15T10:00:00Z')
  ];
  truthy(isStale(events, 14, '2026-05-29T10:00:00Z'));
});
test('isStale — opportunity 5 days old → not stale', () => {
  resetEventIds();
  const events = [
    mkEvent('delivered', '2026-05-20T10:00:00Z'),
    mkEvent('accepted',  '2026-05-25T10:00:00Z')
  ];
  falsy(isStale(events, 14, '2026-05-29T10:00:00Z'));
});
test('isStale — closed opportunities are never stale', () => {
  resetEventIds();
  const events = [
    mkEvent('delivered',  '2026-01-01T10:00:00Z'),
    mkEvent('closed_won', '2026-01-10T10:00:00Z', { amount: 1000 })
  ];
  falsy(isStale(events, 14, '2026-05-29T10:00:00Z'));
});

// timeDecayWeight ──────────────────────────────────────────────────────
test('timeDecayWeight — same day → weight ≈ 1', () => {
  const w = timeDecayWeight('2026-05-29T10:00:00Z', 180, '2026-05-29T10:00:00Z');
  truthy(Math.abs(w - 1) < 1e-6, `got ${w}`);
});
test('timeDecayWeight — 180 days ago with 180d half-life → weight ≈ 0.5', () => {
  const w = timeDecayWeight('2025-11-30T10:00:00Z', 180, '2026-05-29T10:00:00Z');
  truthy(Math.abs(w - 0.5) < 0.01, `got ${w}`);
});
test('timeDecayWeight — 360 days ago with 180d half-life → weight ≈ 0.25', () => {
  const w = timeDecayWeight('2025-06-03T10:00:00Z', 180, '2026-05-29T10:00:00Z');
  truthy(Math.abs(w - 0.25) < 0.01, `got ${w}`);
});
test('timeDecayWeight — future occurrence (data clock skew) → weight = 1', () => {
  const w = timeDecayWeight('2027-01-01T10:00:00Z', 180, '2026-05-29T10:00:00Z');
  eq(w, 1);
});

// ════════════════════════════════════════════════════════════════════════
// v1.16.1 — Stage 1 loose-mode retry decision.
//
// MUST stay byte-identical with shouldAttemptLooseRetry in
// src/main/scanner/stage1-discovery.ts.
//
// Decision matrix:
//   parseSucceeded=true,  candidates=[]  → RETRY (loose mode)
//   parseSucceeded=true,  candidates=[…] → DON'T retry (already have results)
//   parseSucceeded=false, candidates=[]  → DON'T retry (parse failure ≠
//                                          empty-result signal; loose mode
//                                          would likely hit the same token
//                                          budget overflow)
// ════════════════════════════════════════════════════════════════════════

function shouldAttemptLooseRetry(result) {
  return result.parseSucceeded && result.candidates.length === 0;
}

test('shouldAttemptLooseRetry — parsed + 0 candidates → true', () => {
  eq(shouldAttemptLooseRetry({ candidates: [], citations: [], raw: {}, parseSucceeded: true }), true);
});
test('shouldAttemptLooseRetry — parsed + 1 candidate → false', () => {
  eq(shouldAttemptLooseRetry({ candidates: [{ company: 'X' }], citations: [], raw: {}, parseSucceeded: true }), false);
});
test('shouldAttemptLooseRetry — parsed + many candidates → false', () => {
  const candidates = Array.from({ length: 25 }, (_, i) => ({ company: `Co${i}` }));
  eq(shouldAttemptLooseRetry({ candidates, citations: [], raw: {}, parseSucceeded: true }), false);
});
test('shouldAttemptLooseRetry — unparsed + 0 candidates → false (parse failure case)', () => {
  // Critical: this is the case where Perplexity ran out of tokens in <think>
  // mode. A loose-mode retry would likely hit the same overflow.
  eq(shouldAttemptLooseRetry({ candidates: [], citations: ['url1'], raw: null, parseSucceeded: false }), false);
});
test('shouldAttemptLooseRetry — unparsed + (impossible) some candidates → false', () => {
  // Defensive: shouldn't happen in production but if parse failed we trust
  // the parseSucceeded flag over the candidate count.
  eq(shouldAttemptLooseRetry({ candidates: [{ company: 'X' }], citations: [], raw: null, parseSucceeded: false }), false);
});

// ════════════════════════════════════════════════════════════════════════
// v1.17.0 — learning loop math (src/shared/learning.ts).
//
// MUST stay byte-identical with production. These functions drive:
//   - smoothedCloseRate: Bayesian smoothing toward a 20% prior so small
//     samples don't lie ("1/1 won" smooths to 33%, not 100%)
//   - wilsonScoreInterval: 95% CI on the raw rate so UI can show width
//   - meetsLearningThreshold: cold-start gate (≥5 won AND ≥5 lost)
//   - extractDimensions: which (dim, value) pairs an opportunity scores
//     against (product_id, industry, matched_signal, confidence_bucket)
//   - findRelevantLearnings: which learned rows fire for a candidate
//   - applyPriorAdjustment: capped confidence delta (±0.15 default)
//   - buildLearningPriorsBlock: the Stage 2 prompt block (empty when
//     no dimension meets threshold — cold start = no-op)
// ════════════════════════════════════════════════════════════════════════

const DEFAULT_BAYESIAN_ALPHA = 1;
const DEFAULT_BAYESIAN_BETA = 4;
const MIN_SAMPLES_FOR_THRESHOLD = 5;
const MAX_PRIOR_ADJUSTMENT = 0.15;
const BASELINE_CLOSE_RATE = 0.2;
const MAX_PRIOR_ROWS_IN_PROMPT = 10;
const DIMENSION_LABELS = {
  product_id: 'Product',
  industry: 'Industry',
  matched_signal: 'Signal type',
  confidence_bucket: 'Initial confidence'
};

function smoothedCloseRate(nWon, nLost, alpha = DEFAULT_BAYESIAN_ALPHA, beta = DEFAULT_BAYESIAN_BETA) {
  if (alpha < 0 || beta < 0 || nWon < 0 || nLost < 0) return 0;
  const denom = alpha + beta + nWon + nLost;
  if (denom === 0) return 0;
  return (alpha + nWon) / denom;
}

function wilsonScoreInterval(nWon, nTotal, confidence = 0.95) {
  if (nTotal === 0) return { lower: 0, upper: 1 };
  if (nWon < 0 || nWon > nTotal) return { lower: 0, upper: 1 };
  const z = confidence >= 0.99 ? 2.576
          : confidence >= 0.95 ? 1.96
          : confidence >= 0.90 ? 1.645
          : 1.96;
  const p = nWon / nTotal;
  const z2 = z * z;
  const denominator = 1 + z2 / nTotal;
  const centre = (p + z2 / (2 * nTotal)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p) + z2 / (4 * nTotal)) / nTotal)) / denominator;
  return {
    lower: Math.max(0, centre - margin),
    upper: Math.min(1, centre + margin)
  };
}

function meetsLearningThreshold(row) {
  return row.n_closed_won >= MIN_SAMPLES_FOR_THRESHOLD &&
         row.n_closed_lost >= MIN_SAMPLES_FOR_THRESHOLD;
}

function extractDimensions(input) {
  const dims = [];
  if (typeof input.product_id === 'number' && input.product_id > 0) {
    dims.push({ dimension: 'product_id', dimension_value: String(input.product_id) });
  }
  if (typeof input.industry === 'string' && input.industry.trim()) {
    dims.push({ dimension: 'industry', dimension_value: input.industry.trim() });
  }
  const conf = typeof input.confidence === 'number' ? input.confidence : 0;
  let bucket;
  if (conf >= 0.75) bucket = 'high';
  else if (conf >= 0.55) bucket = 'medium';
  else bucket = 'low';
  dims.push({ dimension: 'confidence_bucket', dimension_value: bucket });
  let matched = typeof input.matched_signal === 'string' ? input.matched_signal.trim() : '';
  if (!matched && typeof input.raw_signal === 'string') {
    try {
      const parsed = JSON.parse(input.raw_signal);
      if (parsed && typeof parsed.matched_signal === 'string') {
        matched = parsed.matched_signal.trim();
      }
    } catch { /* skip */ }
  }
  if (matched) {
    dims.push({ dimension: 'matched_signal', dimension_value: matched });
  }
  return dims;
}

function findRelevantLearnings(candidate, learnings) {
  const dims = extractDimensions({
    product_id: candidate.product_id ?? null,
    industry: candidate.industry ?? null,
    confidence: candidate.confidence,
    matched_signal: candidate.matched_signal ?? null
  });
  const keys = new Set(dims.map((d) => `${d.dimension}::${d.dimension_value}`));
  return learnings.filter(
    (l) => l.meets_threshold && keys.has(`${l.dimension}::${l.dimension_value}`)
  );
}

function applyPriorAdjustment(rawConfidence, candidate, learnings, cap = MAX_PRIOR_ADJUSTMENT) {
  const matches = findRelevantLearnings(candidate, learnings);
  if (matches.length === 0) {
    return { adjusted: rawConfidence, rawAdjustment: 0, capped: 0, matches: [] };
  }
  let weightedSum = 0;
  let totalWeight = 0;
  for (const m of matches) {
    const weight = Math.log(1 + m.n_closed_won + m.n_closed_lost);
    const delta = m.smoothed_close_rate - BASELINE_CLOSE_RATE;
    weightedSum += delta * weight;
    totalWeight += weight;
  }
  const avgDelta = totalWeight > 0 ? weightedSum / totalWeight : 0;
  const normalized = Math.max(-1, Math.min(1, avgDelta / 0.4));
  const rawAdjustment = normalized * cap;
  const capped = Math.max(-cap, Math.min(cap, rawAdjustment));
  const adjusted = Math.max(0, Math.min(1, rawConfidence + capped));
  return { adjusted, rawAdjustment, capped, matches };
}

function buildLearningPriorsBlock(learnings) {
  const informing = learnings.filter((l) => l.meets_threshold);
  if (informing.length === 0) return '';
  const sorted = [...informing].sort(
    (a, b) =>
      Math.abs(b.smoothed_close_rate - BASELINE_CLOSE_RATE) -
      Math.abs(a.smoothed_close_rate - BASELINE_CLOSE_RATE)
  );
  const top = sorted.slice(0, MAX_PRIOR_ROWS_IN_PROMPT);
  const positives = top.filter((l) => l.smoothed_close_rate > 0.4);
  const negatives = top.filter((l) => l.smoothed_close_rate < 0.15);
  const neutral = top.filter((l) => l.smoothed_close_rate >= 0.15 && l.smoothed_close_rate <= 0.4);
  if (positives.length === 0 && negatives.length === 0 && neutral.length === 0) return '';
  let block = '# Historical performance (priors from your closed deals)\n\n';
  block += 'These patterns come from REAL outcomes in this portfolio, not the model\'s\ntraining data. Weight them heavily when deciding fit and confidence.\n\n';
  if (positives.length > 0) {
    block += 'Patterns that have CLOSED-WON well for this portfolio:\n';
    for (const p of positives) {
      const label = DIMENSION_LABELS[p.dimension] || p.dimension;
      const pct = Math.round(p.smoothed_close_rate * 100);
      block += `  - ${label}: "${p.dimension_value}" — ${p.n_closed_won}/${p.n_closed_won + p.n_closed_lost} closed-won (${pct}% smoothed rate)\n`;
    }
    block += '\n';
  }
  if (negatives.length > 0) {
    block += 'Patterns that have CLOSED-LOST often for this portfolio:\n';
    for (const n of negatives) {
      const label = DIMENSION_LABELS[n.dimension] || n.dimension;
      const pct = Math.round(n.smoothed_close_rate * 100);
      block += `  - ${label}: "${n.dimension_value}" — ${n.n_closed_won}/${n.n_closed_won + n.n_closed_lost} closed-won (${pct}% smoothed rate)\n`;
    }
    block += '\n';
  }
  block += 'GUIDANCE: if the new candidate shares POSITIVE patterns above, lean toward\nqualifying with confidence in the 0.65-0.85 range unless evidence is weak. If\nit shares NEGATIVE patterns, lean toward rejecting unless the rest of the\nevidence is exceptional. The downstream confidence adjuster will apply a\nsmall (±0.15) correction on top of your scoring — your job is the structural\nqualification call; the adjuster handles the magnitude tuning.\n\n';
  return block;
}

// Helpers for building test learning rows.
function mkLearning(dimension, value, won, lost, meets = null) {
  const total = won + lost;
  const smoothed = smoothedCloseRate(won, lost);
  const ci = wilsonScoreInterval(won, total);
  return {
    dimension,
    dimension_value: value,
    n_closed_won: won,
    n_closed_lost: lost,
    sum_close_value: 0,
    smoothed_close_rate: smoothed,
    raw_close_rate: total > 0 ? won / total : 0,
    ci_low: ci.lower,
    ci_high: ci.upper,
    meets_threshold: meets !== null ? meets : meetsLearningThreshold({ n_closed_won: won, n_closed_lost: lost })
  };
}

// smoothedCloseRate ────────────────────────────────────────────────────
test('smoothedCloseRate — zero observations → prior mean 0.2', () => {
  eq(smoothedCloseRate(0, 0), 0.2);
});
test('smoothedCloseRate — 1 won, 0 lost → 33% (not 100%)', () => {
  const r = smoothedCloseRate(1, 0);
  truthy(Math.abs(r - 1/3) < 1e-6, `got ${r}`);
});
test('smoothedCloseRate — 10 won, 0 lost → ~73% (not 100%)', () => {
  const r = smoothedCloseRate(10, 0);
  truthy(Math.abs(r - 11/15) < 1e-6, `got ${r}`);
});
test('smoothedCloseRate — 0 won, 10 lost → ~7% (not 0%)', () => {
  const r = smoothedCloseRate(0, 10);
  truthy(Math.abs(r - 1/15) < 1e-6, `got ${r}`);
});
test('smoothedCloseRate — balanced large sample approaches raw rate', () => {
  // 50 won, 50 lost, raw rate 0.5. Smoothed = (1+50)/(5+100) = 51/105 ≈ 0.486
  const r = smoothedCloseRate(50, 50);
  truthy(Math.abs(r - 51/105) < 1e-6);
});
test('smoothedCloseRate — negative input defended', () => {
  eq(smoothedCloseRate(-1, 5), 0);
});

// wilsonScoreInterval ──────────────────────────────────────────────────
test('wilsonScoreInterval — zero samples → [0, 1]', () => {
  const ci = wilsonScoreInterval(0, 0);
  eq(ci.lower, 0);
  eq(ci.upper, 1);
});
test('wilsonScoreInterval — narrows as n grows', () => {
  const ci10 = wilsonScoreInterval(5, 10);
  const ci100 = wilsonScoreInterval(50, 100);
  const ci1000 = wilsonScoreInterval(500, 1000);
  const w10 = ci10.upper - ci10.lower;
  const w100 = ci100.upper - ci100.lower;
  const w1000 = ci1000.upper - ci1000.lower;
  truthy(w10 > w100 && w100 > w1000, `expected narrowing: ${w10}, ${w100}, ${w1000}`);
});
test('wilsonScoreInterval — 100% raw rate has upper bound = 1', () => {
  const ci = wilsonScoreInterval(10, 10);
  eq(ci.upper, 1);
  truthy(ci.lower < 1);
});

// meetsLearningThreshold ───────────────────────────────────────────────
test('meetsThreshold — 5W/5L → true (exactly at floor)', () => {
  eq(meetsLearningThreshold({ n_closed_won: 5, n_closed_lost: 5 }), true);
});
test('meetsThreshold — 4W/10L → false (won below floor)', () => {
  eq(meetsLearningThreshold({ n_closed_won: 4, n_closed_lost: 10 }), false);
});
test('meetsThreshold — 10W/4L → false (lost below floor)', () => {
  // This is the asymmetry that matters: you need BOTH sides to know
  // whether a pattern works. 10/10/0 looks promising but until you've
  // seen 5 losses you can't be sure.
  eq(meetsLearningThreshold({ n_closed_won: 10, n_closed_lost: 4 }), false);
});
test('meetsThreshold — 0/0 → false', () => {
  eq(meetsLearningThreshold({ n_closed_won: 0, n_closed_lost: 0 }), false);
});

// extractDimensions ────────────────────────────────────────────────────
test('extractDimensions — full input → 4 dims', () => {
  const dims = extractDimensions({
    product_id: 7,
    industry: 'Fintech',
    confidence: 0.65,
    matched_signal: 'CISO departure'
  });
  eq(dims.length, 4);
  truthy(dims.some((d) => d.dimension === 'product_id' && d.dimension_value === '7'));
  truthy(dims.some((d) => d.dimension === 'industry' && d.dimension_value === 'Fintech'));
  truthy(dims.some((d) => d.dimension === 'confidence_bucket' && d.dimension_value === 'medium'));
  truthy(dims.some((d) => d.dimension === 'matched_signal' && d.dimension_value === 'CISO departure'));
});
test('extractDimensions — confidence bucket boundaries', () => {
  eq(extractDimensions({ confidence: 0.74 }).find((d) => d.dimension === 'confidence_bucket').dimension_value, 'medium');
  eq(extractDimensions({ confidence: 0.75 }).find((d) => d.dimension === 'confidence_bucket').dimension_value, 'high');
  eq(extractDimensions({ confidence: 0.54 }).find((d) => d.dimension === 'confidence_bucket').dimension_value, 'low');
  eq(extractDimensions({ confidence: 0.55 }).find((d) => d.dimension === 'confidence_bucket').dimension_value, 'medium');
});
test('extractDimensions — falls back to raw_signal JSON for matched_signal', () => {
  const dims = extractDimensions({
    product_id: 3,
    raw_signal: JSON.stringify({ matched_signal: 'lease renewal' })
  });
  truthy(dims.some((d) => d.dimension === 'matched_signal' && d.dimension_value === 'lease renewal'));
});
test('extractDimensions — missing optional fields skip cleanly', () => {
  const dims = extractDimensions({ confidence: 0.6 });
  // Only confidence_bucket should appear.
  eq(dims.length, 1);
  eq(dims[0].dimension, 'confidence_bucket');
});

// findRelevantLearnings ────────────────────────────────────────────────
test('findRelevantLearnings — no learnings → empty', () => {
  const r = findRelevantLearnings({ product_id: 1, confidence: 0.6 }, []);
  eq(r.length, 0);
});
test('findRelevantLearnings — non-informing rows ignored', () => {
  // Too-thin row: only 3 won / 3 lost. Should NOT fire even though product matches.
  const learnings = [mkLearning('product_id', '1', 3, 3)];
  const r = findRelevantLearnings({ product_id: 1, confidence: 0.6 }, learnings);
  eq(r.length, 0);
});
test('findRelevantLearnings — informing row matches candidate dimension', () => {
  const learnings = [
    mkLearning('product_id', '1', 7, 6),
    mkLearning('industry', 'OtherIndustry', 10, 10)
  ];
  const r = findRelevantLearnings({ product_id: 1, industry: 'Fintech', confidence: 0.6 }, learnings);
  // Only product_id=1 should match — industry is OtherIndustry, not Fintech.
  eq(r.length, 1);
  eq(r[0].dimension, 'product_id');
});

// applyPriorAdjustment ─────────────────────────────────────────────────
test('applyPriorAdjustment — no matches → no-op (cold start safe)', () => {
  const r = applyPriorAdjustment(0.65, { product_id: 1, confidence: 0.65 }, []);
  eq(r.adjusted, 0.65);
  eq(r.capped, 0);
});
test('applyPriorAdjustment — positive pattern lifts confidence', () => {
  // Strong won-pattern: 20/5 → smoothed ≈ 0.7, well above 0.2 baseline.
  const learnings = [mkLearning('industry', 'Fintech', 20, 5)];
  const r = applyPriorAdjustment(0.55, { industry: 'Fintech', confidence: 0.55 }, learnings);
  truthy(r.adjusted > 0.55, `expected lift, got ${r.adjusted}`);
  truthy(r.capped > 0);
});
test('applyPriorAdjustment — negative pattern lowers confidence', () => {
  // Strong lost-pattern with sample passing threshold: 5W/50L → meets
  // ≥5W AND ≥5L gate, smoothed ≈ 0.10 (well below 0.2 baseline).
  const learnings = [mkLearning('industry', 'Retail', 5, 50)];
  const r = applyPriorAdjustment(0.6, { industry: 'Retail', confidence: 0.6 }, learnings);
  truthy(r.adjusted < 0.6, `expected drop, got ${r.adjusted}`);
  truthy(r.capped < 0);
});
test('applyPriorAdjustment — cap enforces maximum magnitude', () => {
  // Pathological: many strong matches all pointing the same way.
  const learnings = [
    mkLearning('industry', 'X', 50, 0),
    mkLearning('product_id', '1', 50, 0),
    mkLearning('matched_signal', 'win signal', 50, 0)
  ];
  const r = applyPriorAdjustment(0.5, {
    industry: 'X',
    product_id: 1,
    matched_signal: 'win signal',
    confidence: 0.5
  }, learnings);
  // capped must not exceed ±0.15
  truthy(Math.abs(r.capped) <= 0.15 + 1e-9, `capped=${r.capped} exceeded ±0.15`);
});
test('applyPriorAdjustment — confidence stays within [0, 1] after adjustment', () => {
  const learnings = [mkLearning('industry', 'X', 50, 0)];
  const r1 = applyPriorAdjustment(0.95, { industry: 'X', confidence: 0.95 }, learnings);
  truthy(r1.adjusted <= 1);
  const r2 = applyPriorAdjustment(0.05, { industry: 'X', confidence: 0.05 }, [mkLearning('industry', 'X', 0, 50)]);
  truthy(r2.adjusted >= 0);
});

// buildLearningPriorsBlock ─────────────────────────────────────────────
test('buildLearningPriorsBlock — no learnings → empty string (cold start)', () => {
  eq(buildLearningPriorsBlock([]), '');
});
test('buildLearningPriorsBlock — only non-informing rows → empty string', () => {
  const block = buildLearningPriorsBlock([
    mkLearning('industry', 'X', 3, 3),
    mkLearning('product_id', '1', 4, 4)
  ]);
  eq(block, '');
});
test('buildLearningPriorsBlock — positive pattern surfaces in block', () => {
  const block = buildLearningPriorsBlock([
    mkLearning('industry', 'Fintech', 20, 5)
  ]);
  truthy(block.includes('CLOSED-WON well'), `expected positive section, got: ${block.slice(0, 200)}`);
  truthy(block.includes('Fintech'));
});
test('buildLearningPriorsBlock — negative pattern surfaces in block', () => {
  // 5W/50L → meets threshold AND has smoothed ≈ 0.10 (well below the
  // 0.15 cutoff used for negatives in the prompt block).
  const block = buildLearningPriorsBlock([
    mkLearning('industry', 'Retail', 5, 50)
  ]);
  truthy(block.includes('CLOSED-LOST often'), `expected negatives section, got: ${block.slice(0, 300)}`);
  truthy(block.includes('Retail'));
});
test('buildLearningPriorsBlock — caps at top K most-informative rows', () => {
  // Build 15 informing rows; only top 10 should appear in the block.
  const rows = [];
  for (let i = 0; i < 15; i++) {
    // Vary the rate so absolute-distance-from-baseline ordering picks
    // the strongest signals first.
    rows.push(mkLearning('industry', `Industry${i}`, 10 + i, 5));
  }
  const block = buildLearningPriorsBlock(rows);
  // Count occurrences of "Industry" labels in the block.
  const matches = block.match(/Industry\d+/g) || [];
  truthy(matches.length <= 10, `expected ≤10 rows surfaced, got ${matches.length}`);
});

// ════════════════════════════════════════════════════════════════════════
// v1.17.2 — dossierLabelState helper (src/renderer/src/pages/BrandsProducts.tsx).
//
// MUST stay byte-identical with production. This decides whether to
// display "Opus verified" and "+ fact-checked" labels in the dossier
// header. Critical that it READS the latest status_detail and doesn't
// fall back to persistent timestamps when status_detail says the
// latest run failed — that was the v1.17.0 bug that caused
// "Opus verified + fact-checked" to display on Design and Build even
// though its latest re-research had Stage 2 failed and Stages 3/4
// skipped.
// ════════════════════════════════════════════════════════════════════════

function parseStatusDetail(raw) {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object') return null;
    return j;
  } catch { return null; }
}

function dossierLabelState(statusDetailRaw, lastAdvancedAt, lastFactCheckAt) {
  const parsed = parseStatusDetail(statusDetailRaw);
  if (parsed && (parsed.stage2 || parsed.stage1)) {
    const stage2Ok = parsed.stage2 === 'completed';
    const stage4Ok = parsed.stage4 === 'completed' ||
                     (!!parsed.stage4 && /^partial:/.test(parsed.stage4));
    return { verified: stage2Ok, factChecked: stage4Ok };
  }
  return {
    verified: !!lastAdvancedAt,
    factChecked: !!lastFactCheckAt
  };
}

test('dossierLabelState — latest run all-completed → verified + factChecked', () => {
  const detail = JSON.stringify({
    stage1: 'completed', stage2: 'completed', stage3: 'completed', stage4: 'completed'
  });
  const r = dossierLabelState(detail, '2026-01-01', '2026-01-01');
  eq(r.verified, true);
  eq(r.factChecked, true);
});

test('dossierLabelState — latest Stage 2 failed → both false even with stale timestamps', () => {
  // The exact bug from Design and Build screenshot: Stage 2 failed but
  // persistent timestamps from a previous successful run are still set.
  // Pre-fix, the label gated on the timestamps and lied. Post-fix, the
  // label reflects the latest run's reality.
  const detail = JSON.stringify({
    stage1: 'completed',
    stage2: 'failed: Unparseable Stage 2 response',
    stage3: 'skipped: stage2 failed',
    stage4: 'skipped: stage2 failed'
  });
  const r = dossierLabelState(detail, '2026-01-01T10:00:00Z', '2026-01-01T10:00:00Z');
  eq(r.verified, false);
  eq(r.factChecked, false);
});

test('dossierLabelState — Stage 2 OK but Stage 4 skipped (toggle off) → verified only', () => {
  const detail = JSON.stringify({
    stage1: 'completed', stage2: 'completed', stage3: 'completed',
    stage4: 'skipped: productResearchFactCheck toggle is off'
  });
  const r = dossierLabelState(detail, '2026-01-01', null);
  eq(r.verified, true);
  eq(r.factChecked, false);
});

test('dossierLabelState — Stage 4 partial → factChecked stays true', () => {
  // Partial Stage 4 (some sources couldn't be fetched) still counts as
  // fact-checked. The chip separately shows the partial percentage.
  const detail = JSON.stringify({
    stage1: 'completed', stage2: 'completed', stage3: 'completed',
    stage4: 'partial: 9/10 sources verified'
  });
  const r = dossierLabelState(detail, '2026-01-01', '2026-01-01');
  eq(r.verified, true);
  eq(r.factChecked, true);
});

test('dossierLabelState — null status_detail falls back to timestamps (legacy data)', () => {
  // Pre-v1.10.1 rows have status_detail = NULL. Don't strip the label
  // entirely just because the schema was newer than the row.
  const r = dossierLabelState(null, '2026-01-01T10:00:00Z', '2026-01-01T10:00:00Z');
  eq(r.verified, true);
  eq(r.factChecked, true);
});

test('dossierLabelState — malformed status_detail JSON falls back to timestamps', () => {
  const r = dossierLabelState('not json', '2026-01-01', null);
  eq(r.verified, true);
  eq(r.factChecked, false);
});

test('dossierLabelState — empty-object status_detail still falls back to timestamps', () => {
  // An empty object (no stage1/2 keys) is treated as "no data" and falls
  // back to timestamps. Defensive against unusual writes.
  const r = dossierLabelState('{}', '2026-01-01', '2026-01-01');
  eq(r.verified, true);
  eq(r.factChecked, true);
});

// ════════════════════════════════════════════════════════════════════════
// v1.18.0 — routeCandidate (src/main/scanner.ts).
//
// Pure routing decision for sub-threshold candidates from Stage 2 qualify
// and live-monitor qualify. The function settles the deep question:
// "what do we do with a faint but possibly early-stage opportunity?"
//
//   high-conf  (≥ minConfidence)                 → 'open'    (Dashboard)
//   low-conf   (< minConfidence) + 'early' stage → 'shadow'  (preserved, hidden)
//   low-conf   + 'mid' / 'late' / null stage      → 'drop'    (discarded)
//
// MUST stay byte-identical with production. The shadow bucket is the
// false-negative cohort we'll need 6+ months from now to validate (or
// refute) the "too late" critique with data, not guesses.
// ════════════════════════════════════════════════════════════════════════

function routeCandidate(confidence, stage, minConfidence) {
  if ((confidence ?? 0) >= minConfidence) return 'open';
  if (stage === 'early') return 'shadow';
  return 'drop';
}

test('routeCandidate — high-conf + early → open', () => {
  eq(routeCandidate(0.80, 'early', 0.55), 'open');
});
test('routeCandidate — high-conf + mid → open', () => {
  eq(routeCandidate(0.80, 'mid', 0.55), 'open');
});
test('routeCandidate — high-conf + late → open', () => {
  eq(routeCandidate(0.80, 'late', 0.55), 'open');
});
test('routeCandidate — high-conf + null stage → open', () => {
  // Classifier not tagging stage must NOT demote an otherwise-qualifying
  // lead; the threshold gate is independent of the stage axis.
  eq(routeCandidate(0.80, null, 0.55), 'open');
});
test('routeCandidate — low-conf + early → shadow (the whole point of v1.18.0)', () => {
  eq(routeCandidate(0.45, 'early', 0.55), 'shadow');
});
test('routeCandidate — low-conf + mid → drop', () => {
  // Mid-stage low-conf means we're catching it too late AND with weak
  // evidence. Not worth holding aside — most likely a fit miss.
  eq(routeCandidate(0.45, 'mid', 0.55), 'drop');
});
test('routeCandidate — low-conf + late → drop', () => {
  eq(routeCandidate(0.45, 'late', 0.55), 'drop');
});
test('routeCandidate — low-conf + null stage → drop (safe default)', () => {
  // When the classifier doesn't tag a stage we conservatively drop.
  // Shadowing requires explicit 'early' tagging — guesswork doesn't earn
  // a slot in the false-negative cohort.
  eq(routeCandidate(0.45, null, 0.55), 'drop');
});
test('routeCandidate — exactly-at-threshold counts as open (≥, not >)', () => {
  // Boundary check. The existing scanner used `< minConfidence` to drop,
  // so `>= minConfidence` is the open route. Preserves prior behaviour
  // at the boundary.
  eq(routeCandidate(0.55, 'early', 0.55), 'open');
  eq(routeCandidate(0.55, 'late', 0.55), 'open');
  eq(routeCandidate(0.55, null, 0.55), 'open');
});
test('routeCandidate — undefined confidence treated as 0 (defensive)', () => {
  // Matches the scanner's `cand.confidence ?? 0` coercion. A missing
  // confidence field shouldn't slip past the gate via NaN comparison.
  eq(routeCandidate(undefined, 'early', 0.55), 'shadow');
  eq(routeCandidate(undefined, 'late', 0.55), 'drop');
});
test('routeCandidate — undefined stage treated as null (drops sub-threshold)', () => {
  eq(routeCandidate(0.40, undefined, 0.55), 'drop');
});

// ════════════════════════════════════════════════════════════════════════
// v1.19.0 — Hunt-list ranking helpers (src/shared/hunt.ts).
//
// Pure deterministic scoring of Apollo-returned contacts against a Sonnet-
// derived archetype + opportunity signal context. MUST stay byte-identical
// with production. Manual sync flagged in the file header convention.
// ════════════════════════════════════════════════════════════════════════

const HUNT_WEIGHT_ARCHETYPE_TITLE = 0.40;
const HUNT_WEIGHT_SENIORITY       = 0.25;
const HUNT_WEIGHT_DEPARTMENT      = 0.15;
const HUNT_WEIGHT_ANTI_PATTERN    = 0.10;
const HUNT_WEIGHT_VERIFIED_EMAIL  = 0.05;
const HUNT_WEIGHT_SIGNAL_KEYWORD  = 0.05;
const HUNT_MAX_CONTACTS = 5;

const TITLE_NOISE = new Set([
  'vp', 'vice', 'president', 'svp', 'evp', 'avp',
  'chief', 'head', 'director', 'senior', 'sr', 'junior', 'jr',
  'manager', 'mgr', 'lead', 'principal', 'staff',
  'of', 'the', 'and', 'for', 'a', 'an', 'to',
  'global', 'regional', 'group', 'team'
]);

function tokenizeTitle(s) {
  if (!s) return [];
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0 && !TITLE_NOISE.has(t));
}

function archetypeTitleMatch(title, targetTitles) {
  const contactTokens = new Set(tokenizeTitle(title));
  if (contactTokens.size === 0 || targetTitles.length === 0) return 0;
  const targetTokens = new Set();
  for (const t of targetTitles) {
    for (const tok of tokenizeTitle(t)) targetTokens.add(tok);
  }
  if (targetTokens.size === 0) return 0;
  let intersection = 0;
  for (const t of contactTokens) if (targetTokens.has(t)) intersection++;
  return Math.min(1, intersection / targetTokens.size);
}

function seniorityMatch(contactSeniority, targetSeniorities) {
  if (!contactSeniority || targetSeniorities.length === 0) return 0;
  return targetSeniorities.includes(contactSeniority) ? 1 : 0;
}

function normaliseDept(s) {
  return s.toLowerCase().replace(/[_\-\s]+/g, ' ').trim();
}
function departmentMatch(contactDept, targetDepts) {
  if (!contactDept || targetDepts.length === 0) return 0;
  const c = normaliseDept(contactDept);
  for (const t of targetDepts) {
    if (!t) continue;
    const lower = normaliseDept(t);
    if (!lower) continue;
    if (c.includes(lower) || lower.includes(c)) return 1;
  }
  return 0;
}

function antiPatternPenalty(title, antiPatterns) {
  if (!title || antiPatterns.length === 0) return 0;
  const t = title.toLowerCase();
  for (const ap of antiPatterns) {
    if (!ap) continue;
    if (t.includes(ap.toLowerCase())) return HUNT_WEIGHT_ANTI_PATTERN;
  }
  return 0;
}

function verifiedEmailBonus(emailStatus) {
  return emailStatus === 'verified' ? HUNT_WEIGHT_VERIFIED_EMAIL : 0;
}

function signalKeywordMatch(title, signalText) {
  if (!title || !signalText) return 0;
  const titleTokens = new Set(tokenizeTitle(title));
  if (titleTokens.size === 0) return 0;
  const signalTokens = tokenizeTitle(signalText);
  let hits = 0;
  for (const t of signalTokens) if (titleTokens.has(t)) hits++;
  return hits >= 2 ? HUNT_WEIGHT_SIGNAL_KEYWORD : 0;
}

function huntScore(contact, archetype, signalText) {
  const archetype_title = archetypeTitleMatch(contact.title, archetype.target_titles);
  const seniority      = seniorityMatch(contact.seniority, archetype.target_seniorities);
  const department     = departmentMatch(contact.department, archetype.target_departments);
  const anti_pattern_penalty = antiPatternPenalty(contact.title, archetype.anti_patterns);
  const verified_bonus = verifiedEmailBonus(contact.email_status);
  const signal_keyword = signalKeywordMatch(contact.title, signalText);
  const raw =
      HUNT_WEIGHT_ARCHETYPE_TITLE * archetype_title
    + HUNT_WEIGHT_SENIORITY       * seniority
    + HUNT_WEIGHT_DEPARTMENT      * department
    - anti_pattern_penalty
    + verified_bonus
    + signal_keyword;
  return {
    score: Math.max(0, Math.min(1, raw)),
    components: { archetype_title, seniority, department, anti_pattern_penalty, verified_bonus, signal_keyword }
  };
}

function rankContacts(contacts, archetype, signalText) {
  const scored = contacts.map((c, idx) => {
    const { score, components } = huntScore(c, archetype, signalText);
    return { contact: c, idx, score, components };
  });
  scored.sort((a, b) => (b.score - a.score) || (a.idx - b.idx));
  const top = scored.slice(0, HUNT_MAX_CONTACTS);
  return top.map((s, rank) => ({
    ...s.contact,
    hunt_rank: rank + 1,
    hunt_score: Number(s.score.toFixed(4)),
    rank_components: s.components
  }));
}

// ─── Tests ────────────────────────────────────────────────────────
const ARCH_IT_INFRA = {
  target_seniorities: ['c_suite', 'vp', 'director'],
  target_titles: ['Head of Infrastructure', 'VP Engineering', 'Director of Network Operations'],
  target_departments: ['engineering', 'it_operations'],
  anti_patterns: ['sales', 'marketing', 'hr', 'legal'],
  reasoning: 'test'
};

test('archetypeTitleMatch — strong overlap → high score', () => {
  // "VP Infrastructure" tokenizes to ['infrastructure']. Target tokens after
  // noise-strip: 'infrastructure', 'engineering', 'network', 'operations'.
  // Coverage = 1 / 4 = 0.25. Real-world contacts rarely overlap densely
  // because titles are short; this is the expected magnitude.
  const s = archetypeTitleMatch('VP Infrastructure', ARCH_IT_INFRA.target_titles);
  truthy(s > 0.2, `got ${s}`);
});
test('archetypeTitleMatch — multi-word overlap scales up', () => {
  // "Director of Network Operations" gives us network + operations both — 2/4.
  const s = archetypeTitleMatch('Director of Network Operations', ARCH_IT_INFRA.target_titles);
  truthy(s >= 0.5, `got ${s}`);
});
test('archetypeTitleMatch — disjoint title → 0', () => {
  eq(archetypeTitleMatch('Chief Marketing Officer', ARCH_IT_INFRA.target_titles), 0);
});
test('archetypeTitleMatch — empty title returns 0', () => {
  eq(archetypeTitleMatch('', ARCH_IT_INFRA.target_titles), 0);
  eq(archetypeTitleMatch(null, ARCH_IT_INFRA.target_titles), 0);
});
test('archetypeTitleMatch — empty targets returns 0', () => {
  eq(archetypeTitleMatch('VP Engineering', []), 0);
});

test('seniorityMatch — in target → 1', () => {
  eq(seniorityMatch('vp', ARCH_IT_INFRA.target_seniorities), 1);
  eq(seniorityMatch('c_suite', ARCH_IT_INFRA.target_seniorities), 1);
});
test('seniorityMatch — not in target → 0', () => {
  eq(seniorityMatch('manager', ARCH_IT_INFRA.target_seniorities), 0);
  eq(seniorityMatch('entry', ARCH_IT_INFRA.target_seniorities), 0);
});
test('seniorityMatch — null seniority → 0 safely', () => {
  eq(seniorityMatch(null, ARCH_IT_INFRA.target_seniorities), 0);
});

test('departmentMatch — substring match → 1', () => {
  eq(departmentMatch('engineering', ARCH_IT_INFRA.target_departments), 1);
  eq(departmentMatch('IT Operations', ARCH_IT_INFRA.target_departments), 1);
});
test('departmentMatch — missing department → 0 (no penalty)', () => {
  eq(departmentMatch(null, ARCH_IT_INFRA.target_departments), 0);
  eq(departmentMatch('', ARCH_IT_INFRA.target_departments), 0);
});

test('antiPatternPenalty — matches → returns full penalty', () => {
  eq(antiPatternPenalty('VP Marketing', ARCH_IT_INFRA.anti_patterns), 0.10);
  eq(antiPatternPenalty('Head of Sales', ARCH_IT_INFRA.anti_patterns), 0.10);
});
test('antiPatternPenalty — clean title → 0', () => {
  eq(antiPatternPenalty('VP Infrastructure', ARCH_IT_INFRA.anti_patterns), 0);
});

test('verifiedEmailBonus — verified → 0.05', () => {
  eq(verifiedEmailBonus('verified'), 0.05);
});
test('verifiedEmailBonus — anything else → 0', () => {
  eq(verifiedEmailBonus('guessed'), 0);
  eq(verifiedEmailBonus('unverified'), 0);
  eq(verifiedEmailBonus(null), 0);
});

test('signalKeywordMatch — ≥2 token overlap → bonus', () => {
  // "VP Cloud Architecture" + "cloud migration architecture rollout" → cloud,
  // architecture both in title → ≥2 hits → 0.05 bonus.
  eq(signalKeywordMatch('VP Cloud Architecture', 'cloud migration architecture rollout'), 0.05);
});
test('signalKeywordMatch — 1 token overlap → 0', () => {
  eq(signalKeywordMatch('VP Sales', 'cloud migration architecture rollout'), 0);
});
test('signalKeywordMatch — disjoint → 0', () => {
  eq(signalKeywordMatch('VP Sales', 'cloud migration rollout'), 0);
});

test('huntScore — high archetype + matching seniority + verified email → near 1', () => {
  const r = huntScore(
    { title: 'Director of Network Operations', seniority: 'director', department: 'engineering', email_status: 'verified' },
    ARCH_IT_INFRA,
    'network operations modernization'
  );
  truthy(r.score >= 0.55, `expected near 1, got ${r.score}`);
  truthy(r.score <= 1, `must clamp to 1, got ${r.score}`);
});
test('huntScore — anti-pattern + low fit → near 0', () => {
  const r = huntScore(
    { title: 'VP Sales', seniority: 'vp', department: 'sales', email_status: null },
    ARCH_IT_INFRA,
    'network operations'
  );
  // Seniority matches (+0.25), anti-pattern penalty (-0.10), no other contribution.
  // Net: 0.15.
  truthy(r.score < 0.25, `got ${r.score}`);
});
test('huntScore — clamps to [0, 1]', () => {
  // Force a hypothetical above-1 input shape by having every component max.
  // With current weights the max raw is 0.40 + 0.25 + 0.15 + 0.05 + 0.05 = 0.90,
  // so we can't naturally exceed 1 — but the clamp is the safety net for
  // future weight changes. Cover the lower clamp instead.
  const r = huntScore(
    { title: 'VP Sales', seniority: null, department: 'sales', email_status: null },
    ARCH_IT_INFRA,
    null
  );
  truthy(r.score >= 0, `got ${r.score}`);
});

test('rankContacts — sorts score-descending, stable on ties', () => {
  const contacts = [
    { id: 'a', title: 'VP Sales',                          seniority: 'vp',       department: null,            email_status: null }, // low
    { id: 'b', title: 'Director of Network Operations',    seniority: 'director', department: 'engineering',   email_status: 'verified' }, // high
    { id: 'c', title: 'VP Infrastructure',                 seniority: 'vp',       department: 'it_operations', email_status: 'guessed' }, // mid
    { id: 'd', title: 'Chief Marketing Officer',           seniority: 'c_suite',  department: 'marketing',     email_status: null } // marketing anti-pattern bites
  ];
  const ranked = rankContacts(contacts, ARCH_IT_INFRA, 'network operations');
  eq(ranked[0].id, 'b', `top should be b, got ${ranked[0].id}`);
  truthy(ranked.length === 4, `got ${ranked.length}`);
  truthy(ranked[0].hunt_rank === 1);
});
test('rankContacts — caps at HUNT_MAX_CONTACTS (5)', () => {
  const contacts = Array.from({ length: 12 }, (_, i) => ({
    id: `c${i}`,
    title: 'Director of Network Operations',
    seniority: 'director',
    department: 'engineering',
    email_status: 'verified'
  }));
  const ranked = rankContacts(contacts, ARCH_IT_INFRA, null);
  eq(ranked.length, 5);
});

// ════════════════════════════════════════════════════════════════════════
// v1.19.0 — Smart-replace contacts (src/shared/contacts-merge.ts).
//
// Pure function: given existing contacts + fresh Apollo results, plan
// which to keep / insert / delete. MUST stay byte-identical with
// production.
// ════════════════════════════════════════════════════════════════════════

function planSmartReplace(existing, fresh) {
  const plan = [];
  let preserved = 0, insertedNew = 0, removedPending = 0, dedupedByApollo = 0;
  const existingByApollo = new Map();
  for (const row of existing) {
    if (row.apollo_id) existingByApollo.set(row.apollo_id, row);
  }
  let maxRankPreserved = 0;
  for (const row of existing) {
    if (row.contact_status !== 'pending') {
      maxRankPreserved = Math.max(maxRankPreserved, row.hunt_rank);
    }
  }
  for (const row of existing) {
    if (row.contact_status !== 'pending') {
      plan.push({ kind: 'keep', row });
      preserved++;
    }
  }
  const freshApolloIds = new Set(fresh.map((f) => f.apollo_id).filter(Boolean));
  for (const row of existing) {
    if (row.contact_status === 'pending') {
      if (row.apollo_id && freshApolloIds.has(row.apollo_id)) {
        plan.push({ kind: 'keep', row });
        dedupedByApollo++;
      } else {
        plan.push({ kind: 'delete', id: row.id });
        removedPending++;
      }
    }
  }
  let nextRank = maxRankPreserved + 1;
  for (const row of fresh) {
    if (row.apollo_id && existingByApollo.has(row.apollo_id)) continue;
    plan.push({ kind: 'insert', row: { ...row, hunt_rank: nextRank } });
    insertedNew++;
    nextRank++;
  }
  return { plan, stats: { preserved, insertedNew, removedPending, dedupedByApollo } };
}

test('planSmartReplace — preserves drafted/sent/skipped rows', () => {
  const existing = [
    { id: 1, apollo_id: 'a1', contact_status: 'drafted', hunt_rank: 1 },
    { id: 2, apollo_id: 'a2', contact_status: 'sent',    hunt_rank: 2 },
    { id: 3, apollo_id: 'a3', contact_status: 'skipped', hunt_rank: 3 }
  ];
  const fresh = []; // no fresh — pure preservation test
  const { plan, stats } = planSmartReplace(existing, fresh);
  eq(stats.preserved, 3);
  eq(stats.removedPending, 0);
  eq(stats.insertedNew, 0);
  truthy(plan.every((p) => p.kind === 'keep'));
});

test('planSmartReplace — removes pending rows not in fresh results', () => {
  const existing = [
    { id: 1, apollo_id: 'a1', contact_status: 'pending', hunt_rank: 1 },
    { id: 2, apollo_id: 'a2', contact_status: 'pending', hunt_rank: 2 }
  ];
  const fresh = []; // Apollo returned nothing this time
  const { stats } = planSmartReplace(existing, fresh);
  eq(stats.removedPending, 2);
  eq(stats.preserved, 0);
  eq(stats.insertedNew, 0);
});

test('planSmartReplace — apollo_id dedup keeps existing pending row', () => {
  const existing = [
    { id: 1, apollo_id: 'a1', contact_status: 'pending', hunt_rank: 1 }
  ];
  const fresh = [
    { id: null, apollo_id: 'a1', contact_status: 'pending', hunt_rank: 1 }
  ];
  const { plan, stats } = planSmartReplace(existing, fresh);
  eq(stats.dedupedByApollo, 1);
  eq(stats.insertedNew, 0);
  eq(stats.removedPending, 0);
  truthy(plan.length === 1 && plan[0].kind === 'keep');
});

test('planSmartReplace — inserts new contacts with rank continuing from max preserved', () => {
  const existing = [
    { id: 1, apollo_id: 'a1', contact_status: 'sent',    hunt_rank: 1 },
    { id: 2, apollo_id: 'a2', contact_status: 'drafted', hunt_rank: 2 }
  ];
  const fresh = [
    { id: null, apollo_id: 'a3', contact_status: 'pending', hunt_rank: 1 },
    { id: null, apollo_id: 'a4', contact_status: 'pending', hunt_rank: 2 }
  ];
  const { plan, stats } = planSmartReplace(existing, fresh);
  eq(stats.insertedNew, 2);
  const inserts = plan.filter((p) => p.kind === 'insert');
  // New rank starts at max preserved (2) + 1 = 3, 4
  eq(inserts[0].row.hunt_rank, 3);
  eq(inserts[1].row.hunt_rank, 4);
});

test('planSmartReplace — combined: preserves, removes stale, inserts new, dedups', () => {
  const existing = [
    { id: 1, apollo_id: 'a1', contact_status: 'sent',    hunt_rank: 1 }, // preserved
    { id: 2, apollo_id: 'a2', contact_status: 'pending', hunt_rank: 2 }, // stale → delete
    { id: 3, apollo_id: 'a3', contact_status: 'pending', hunt_rank: 3 }  // present in fresh → keep
  ];
  const fresh = [
    { id: null, apollo_id: 'a3', contact_status: 'pending', hunt_rank: 1 }, // dedup
    { id: null, apollo_id: 'a4', contact_status: 'pending', hunt_rank: 2 }, // new
    { id: null, apollo_id: 'a5', contact_status: 'pending', hunt_rank: 3 }  // new
  ];
  const { stats } = planSmartReplace(existing, fresh);
  eq(stats.preserved, 1);          // a1
  eq(stats.removedPending, 1);     // a2 was pending and not in fresh
  eq(stats.dedupedByApollo, 1);    // a3 was pending and IS in fresh
  eq(stats.insertedNew, 2);        // a4, a5
});

test('planSmartReplace — handles rows without apollo_id gracefully', () => {
  const existing = [
    { id: 1, apollo_id: null, contact_status: 'sent', hunt_rank: 1 } // manually added, no Apollo id
  ];
  const fresh = [
    { id: null, apollo_id: 'a2', contact_status: 'pending', hunt_rank: 1 }
  ];
  const { stats } = planSmartReplace(existing, fresh);
  eq(stats.preserved, 1);
  eq(stats.insertedNew, 1);
});

// ════════════════════════════════════════════════════════════════════════
// v1.19.5 — Apollo org-name helpers (src/main/apollo.ts).
//
// Pure functions: stripLegalSuffixes (clean noise off company names) and
// orgNamesMatch (fuzzy compare for the post-filter defense). MUST stay
// byte-identical with production.
// ════════════════════════════════════════════════════════════════════════

function stripLegalSuffixes(name) {
  if (!name) return '';
  const SUFFIX_RE = /\b(private\s+limited|pvt\s+ltd|pvt\.\s+ltd|p\s+ltd|pte\s+ltd|inc|incorporated|llc|ltd|limited|llp|corp|corporation|gmbh|sa|sas|sarl|nv|bv|ag|kg|kk|co|company|plc|holdings|group)\.?$/gi;
  let s = name.trim();
  for (let i = 0; i < 3; i++) {
    const stripped = s.replace(SUFFIX_RE, '').replace(/[,\s]+$/, '').trim();
    if (stripped === s || stripped.length === 0) break;
    s = stripped;
  }
  return s;
}

function orgNamesMatch(a, b) {
  if (!a || !b) return false;
  const ca = stripLegalSuffixes(a).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const cb = stripLegalSuffixes(b).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!ca || !cb) return false;
  if (ca === cb) return true;
  return ca.includes(cb) || cb.includes(ca);
}

test('stripLegalSuffixes — strips "Private Limited"', () => {
  // The exact case that triggered v1.19.5: Indian subsidiary naming.
  eq(stripLegalSuffixes('Nvidia Graphics Private Limited'), 'Nvidia Graphics');
});
test('stripLegalSuffixes — strips "Pvt Ltd"', () => {
  eq(stripLegalSuffixes('Acme Pvt Ltd'), 'Acme');
});
test('stripLegalSuffixes — strips "Inc."', () => {
  eq(stripLegalSuffixes('Foo Inc.'), 'Foo');
});
test('stripLegalSuffixes — strips "Inc" without period', () => {
  eq(stripLegalSuffixes('Foo Inc'), 'Foo');
});
test('stripLegalSuffixes — strips "LLC"', () => {
  eq(stripLegalSuffixes('Bar LLC'), 'Bar');
});
test('stripLegalSuffixes — strips "Corporation"', () => {
  eq(stripLegalSuffixes('Big Corporation'), 'Big');
});
test('stripLegalSuffixes — strips "GmbH"', () => {
  eq(stripLegalSuffixes('Schmidt GmbH'), 'Schmidt');
});
test('stripLegalSuffixes — strips trailing comma after suffix', () => {
  eq(stripLegalSuffixes('Acme, Inc'), 'Acme');
});
test('stripLegalSuffixes — leaves clean names alone', () => {
  eq(stripLegalSuffixes('Nvidia'), 'Nvidia');
  eq(stripLegalSuffixes('Apple'), 'Apple');
});
test('stripLegalSuffixes — only strips at trailing position', () => {
  // "Private Limited Partners Group" — "Private Limited" is part of the
  // company name, not a suffix. Trailing "Group" gets stripped though.
  // Conservative behavior: keep mid-string occurrences.
  const result = stripLegalSuffixes('Private Limited Partners Group');
  truthy(result.includes('Private Limited Partners'), `got "${result}"`);
});
test('stripLegalSuffixes — empty input safe', () => {
  eq(stripLegalSuffixes(''), '');
  eq(stripLegalSuffixes(null), '');
});

test('orgNamesMatch — exact match', () => {
  truthy(orgNamesMatch('Nvidia', 'Nvidia'));
});
test('orgNamesMatch — case-insensitive', () => {
  truthy(orgNamesMatch('NVIDIA', 'nvidia'));
});
test('orgNamesMatch — strips legal suffixes both sides', () => {
  truthy(orgNamesMatch('Nvidia Graphics Private Limited', 'Nvidia Graphics'));
  truthy(orgNamesMatch('Nvidia Inc', 'Nvidia Pvt Ltd'));
});
test('orgNamesMatch — substring either direction (parent ↔ subsidiary)', () => {
  // Resolver may pick parent for a subsidiary query or vice versa;
  // both should still match.
  truthy(orgNamesMatch('Nvidia', 'Nvidia Graphics'));
  truthy(orgNamesMatch('Nvidia Graphics', 'Nvidia'));
});
test('orgNamesMatch — disjoint companies → false', () => {
  // The bug fix this protects: Pfizer/Yum leakage when querying for Nvidia.
  falsy(orgNamesMatch('Nvidia Graphics', 'Pfizer'));
  falsy(orgNamesMatch('Nvidia Graphics', 'Yum Brands'));
});
test('orgNamesMatch — punctuation normalised', () => {
  truthy(orgNamesMatch('Foo & Bar', 'Foo  Bar'));
});
test('orgNamesMatch — empty inputs → false (safe default)', () => {
  falsy(orgNamesMatch('', 'Nvidia'));
  falsy(orgNamesMatch('Nvidia', null));
  falsy(orgNamesMatch(null, null));
});

console.log(`\nResult: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
