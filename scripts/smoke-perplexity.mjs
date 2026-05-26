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

console.log(`\nResult: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
