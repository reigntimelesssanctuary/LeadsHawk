import { Agent, fetch as undiciFetch } from 'undici';
import { getSettings } from './settings.js';
import { recordApiCall } from './spend.js';
import type { LlmStage } from './pricing.js';

const PPLX_SYNC_URL = 'https://api.perplexity.ai/chat/completions';
const PPLX_ASYNC_SUBMIT_URL = 'https://api.perplexity.ai/v1/async/sonar';
const PPLX_ASYNC_GET_URL = (id: string) => `https://api.perplexity.ai/v1/async/sonar/${id}`;

/**
 * Generous bodyTimeout for the SYNC endpoint (sonar / sonar-pro etc).
 * `sonar-deep-research` no longer uses this path — see completePerplexityAsync.
 */
const PPLX_AGENT = new Agent({
  bodyTimeout: 5 * 60 * 1000,     // 5 min — sync endpoint kills connections ~120s anyway
  headersTimeout: 60 * 1000
});

const TRANSIENT_ERROR_RE = /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|UND_ERR|socket hang up|HeadersTimeoutError|BodyTimeoutError/i;

/**
 * Models that should always go through Perplexity's async endpoint.
 * Sync /chat/completions has a server-side gateway timeout (~120s) that
 * kills long sonar-deep-research calls before they complete. The async
 * endpoint submits a job and lets us poll for completion over the full
 * research duration without keeping any single HTTP connection open.
 */
function isLongRunningModel(model: string): boolean {
  return /deep-research/i.test(model);
}

async function fetchJsonWithRetry<T = any>(
  url: string,
  init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string }
): Promise<T> {
  let lastErr: any;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await undiciFetch(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        dispatcher: PPLX_AGENT
      });
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Perplexity API ${resp.status}: ${text.slice(0, 500)}`);
      }
      return (await resp.json()) as T;
    } catch (e: any) {
      lastErr = e;
      const msg = String(e?.message || e);
      const transient = !msg.startsWith('Perplexity API ') && TRANSIENT_ERROR_RE.test(msg);
      if (!transient || attempt >= 1) throw e;
      console.warn(`[perplexity] transient error "${msg}" — retrying in 3s (attempt ${attempt + 2}/2)`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw lastErr;
}

export type PplxRecency = 'day' | 'week' | 'month' | 'year';

export type PplxOptions = {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  searchRecency?: PplxRecency;
  /** JSON schema for structured output. Triggers response_format=json_schema. */
  jsonSchema?: Record<string, any>;
  /** Domain allowlist for search (max 10) */
  searchDomainFilter?: string[];
  /** Telemetry: which pipeline stage spent this token budget. */
  stage?: LlmStage;
  /** Telemetry: opportunity_id / item_id / product_id this call relates to. */
  relatedId?: number | null;
};

export type PplxResponse<T = unknown> = {
  text: string;
  json: T | null;
  citations: string[];
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
  raw: any;
};

function getKey(): string {
  const { perplexityApiKey } = getSettings();
  if (!perplexityApiKey) {
    throw new Error(
      'Perplexity API key not configured. Open Settings and paste your key from perplexity.ai/settings/api.'
    );
  }
  return perplexityApiKey;
}

function buildBody(system: string, user: string, opts: PplxOptions): any {
  const body: any = {
    model: opts.model || 'sonar-pro',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    max_tokens: opts.maxTokens ?? 2500,
    temperature: opts.temperature ?? 0.2,
    return_citations: true
  };
  if (opts.searchRecency) body.search_recency_filter = opts.searchRecency;
  if (opts.searchDomainFilter && opts.searchDomainFilter.length) {
    body.search_domain_filter = opts.searchDomainFilter.slice(0, 10);
  }
  if (opts.jsonSchema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: { schema: opts.jsonSchema }
    };
  }
  return body;
}

function extractFromCompletion<T>(
  data: any,
  opts: PplxOptions
): PplxResponse<T> {
  const text: string = data?.choices?.[0]?.message?.content ?? '';
  const citations: string[] = Array.isArray(data?.citations)
    ? data.citations
    : Array.isArray(data?.search_results)
      ? data.search_results.map((r: any) => r.url).filter(Boolean)
      : [];
  let json: T | null = null;
  if (opts.jsonSchema) {
    json = tryParseJson<T>(text);
  }
  return { text, json, citations, usage: data?.usage ?? null, raw: data };
}

/**
 * Synchronous Perplexity call — used for sonar, sonar-pro, sonar-reasoning,
 * sonar-reasoning-pro. Models that don't trip the 120s gateway timeout.
 */
async function completePerplexitySync<T = unknown>(
  system: string,
  user: string,
  opts: PplxOptions
): Promise<PplxResponse<T>> {
  const key = getKey();
  const body = buildBody(system, user, opts);
  const data = await fetchJsonWithRetry<any>(PPLX_SYNC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
      accept: 'application/json'
    },
    body: JSON.stringify(body)
  });
  recordApiCall({
    provider: 'perplexity',
    model: body.model,
    stage: opts.stage ?? 'unknown',
    inputTokens: Number(data?.usage?.prompt_tokens ?? 0),
    outputTokens: Number(data?.usage?.completion_tokens ?? 0),
    relatedId: opts.relatedId ?? null
  });
  return extractFromCompletion<T>(data, opts);
}

/**
 * Asynchronous Perplexity call — required for sonar-deep-research because
 * the sync endpoint has a server-side gateway timeout (~120s) that kills
 * long research jobs. Async flow:
 *   1. POST /v1/async/sonar  with  { request: <sync body> }   → returns { id, status }
 *   2. GET  /v1/async/sonar/{id}   periodically until status === 'COMPLETED'
 *   3. Extract response.choices[0].message.content + citations + usage
 *
 * Polls every POLL_INTERVAL_MS for up to MAX_WAIT_MS. Each poll is a quick
 * GET so we never keep a long HTTP connection open.
 */
const POLL_INTERVAL_MS = 5_000;
const POLL_MAX_WAIT_MS = 20 * 60 * 1000; // 20 minutes — covers worst-case deep research

async function completePerplexityAsync<T = unknown>(
  system: string,
  user: string,
  opts: PplxOptions
): Promise<PplxResponse<T>> {
  // v1.8.5: retry on totally-empty completions (0 tokens, 0 chars).
  // v1.8.7: also retry on "lazy refusal" — the model returns the empty
  // JSON shape without actually searching. For deep_scan / qualify /
  // research / brand_research, citations.length === 0 means no web
  // search happened, which is a failure regardless of the JSON shape.
  let lastReason: string | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await submitAndPollOnce<T>(system, user, opts, attempt);
    const retryReason = shouldRetryResponse(result, opts);
    if (retryReason) {
      lastReason = retryReason;
      console.warn(`[perplexity-async] retrying — ${retryReason} (attempt ${attempt + 2}/2)`);
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    return result;
  }
  throw new Error(
    `Perplexity returned an inadequate response twice in a row (last: ${lastReason}). Likely a transient Perplexity API issue — try again shortly.`
  );
}

/**
 * Decide whether a completed Perplexity response is good enough to keep,
 * or whether we should retry. Returns a short reason string (suitable for
 * logs) if retry is warranted, or null if the response is acceptable.
 */
function shouldRetryResponse<T>(r: PplxResponse<T>, opts: PplxOptions): string | null {
  // 1. Totally empty: no content, no tokens. Always retry.
  if (isEmptyCompletion(r)) {
    const ct = Number(r.usage?.completion_tokens ?? 0);
    return `empty completion (${ct} tokens, ${(r.text || '').length} chars)`;
  }
  // 2. Stages where the model is REQUIRED to do live web search but
  //    returned zero citations — that's a "lazy refusal" (model produced
  //    the empty JSON shape without searching). Retry once. Note: stages
  //    like 'brief' are pure writing tasks and legitimately have zero
  //    citations, so they're excluded here.
  const SEARCH_REQUIRED_STAGES = new Set([
    'research', 'brand_research', 'brand_summary', 'refresh_signals',
    'manual_scan', 'deep_scan', 'qualify'
  ]);
  if (opts.stage && SEARCH_REQUIRED_STAGES.has(opts.stage) && r.citations.length === 0) {
    const ct = Number(r.usage?.completion_tokens ?? 0);
    return `no citations on ${opts.stage} stage (${ct} completion tokens, ${(r.text || '').length} chars) — model didn't search`;
  }
  return null;
}

function isEmptyCompletion<T>(r: PplxResponse<T>): boolean {
  const completionTokens = Number(r.usage?.completion_tokens ?? 0);
  const contentLen = (r.text || '').length;
  return completionTokens === 0 && contentLen === 0;
}

/** Single submit+poll cycle — extracted so the retry wrapper can call it twice. */
async function submitAndPollOnce<T = unknown>(
  system: string,
  user: string,
  opts: PplxOptions,
  attempt: number
): Promise<PplxResponse<T>> {
  const key = getKey();
  const body = buildBody(system, user, opts);
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${key}`,
    accept: 'application/json'
  };

  // Step 1: submit
  const submitResp = await fetchJsonWithRetry<{
    id: string;
    status?: string;
    model?: string;
  }>(PPLX_ASYNC_SUBMIT_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ request: body })
  });
  const jobId = submitResp.id;
  if (!jobId) {
    throw new Error('Perplexity async submit did not return an id.');
  }
  console.log(`[perplexity-async] submitted job ${jobId} (model=${body.model}, attempt ${attempt + 1})`);

  // Step 2: poll
  const start = Date.now();
  let polls = 0;
  while (Date.now() - start < POLL_MAX_WAIT_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    polls++;
    const poll = await fetchJsonWithRetry<{
      id: string;
      status: 'CREATED' | 'IN_PROGRESS' | 'STARTED' | 'COMPLETED' | 'FAILED';
      response?: any;
      error_message?: string | null;
    }>(PPLX_ASYNC_GET_URL(jobId), {
      method: 'GET',
      headers
    });
    if (poll.status === 'COMPLETED') {
      const elapsed = Math.round((Date.now() - start) / 1000);
      console.log(`[perplexity-async] job ${jobId} COMPLETED after ${elapsed}s (${polls} polls)`);
      // Always record spend even when content is empty — Perplexity may
      // still bill for the search cost.
      recordApiCall({
        provider: 'perplexity',
        model: body.model,
        stage: opts.stage ?? 'unknown',
        inputTokens: Number(poll.response?.usage?.prompt_tokens ?? 0),
        outputTokens: Number(poll.response?.usage?.completion_tokens ?? 0),
        relatedId: opts.relatedId ?? null
      });
      return extractFromCompletion<T>(poll.response, opts);
    }
    if (poll.status === 'FAILED') {
      throw new Error(
        `Perplexity async job ${jobId} FAILED: ${poll.error_message || 'no error message'}`
      );
    }
    // CREATED / IN_PROGRESS / STARTED — keep polling
  }
  throw new Error(
    `Perplexity async job ${jobId} did not complete within ${POLL_MAX_WAIT_MS / 60_000} minutes`
  );
}

/**
 * Top-level entrypoint. Auto-routes long-running models (sonar-deep-research)
 * to the async endpoint and everything else to the sync endpoint.
 */
export async function completePerplexity<T = unknown>(
  system: string,
  user: string,
  opts: PplxOptions = {}
): Promise<PplxResponse<T>> {
  const model = opts.model || 'sonar-pro';
  if (isLongRunningModel(model)) {
    return completePerplexityAsync<T>(system, user, opts);
  }
  return completePerplexitySync<T>(system, user, opts);
}

/**
 * Robust JSON extractor for Perplexity responses, especially sonar-deep-research
 * which mixes reasoning text with the final structured output.
 *
 * Strategy (in order of attempt):
 *  1. Strip <think>...</think> and <thinking>...</thinking> blocks (any case).
 *  2. Extract content from ```json fenced blocks first (if present, prefer them).
 *  3. Try parsing the whole cleaned string as JSON.
 *  4. Walk the string and extract every balanced {...} or [...] block. Try
 *     them in size-descending order — the largest block containing our
 *     expected structure is almost always the real answer.
 *
 * Returns null only after all attempts fail.
 */
export function tryParseJson<T>(raw: string): T | null {
  if (!raw) return null;
  let s = raw;

  // 1. Strip reasoning blocks. Models use varied tags + casing.
  s = s.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
  s = s.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '');

  // 2. If there are ```json (or plain ```) fenced blocks, prefer their content.
  //    Try each in size-descending order before falling through.
  const fenceMatches = [...s.matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/gi)]
    .map((m) => m[1].trim())
    .filter((b) => b.length > 0)
    .sort((a, b) => b.length - a.length);
  for (const block of fenceMatches) {
    try { return JSON.parse(block) as T; } catch { /* try next */ }
  }
  // Also clean fences out for the rest of the strategies.
  s = s.replace(/```(?:json)?\s*\n?/gi, '').replace(/```/g, '').trim();

  // 3. Direct parse on the cleaned string.
  try { return JSON.parse(s) as T; } catch { /* fall through */ }

  // 4. Extract every balanced {...} / [...] block in the string.
  //    Largest blocks first — the real structured response is almost
  //    always the biggest balanced block.
  const blocks = extractBalancedBlocks(s).sort((a, b) => b.length - a.length);
  for (const block of blocks) {
    try { return JSON.parse(block) as T; } catch { /* try next */ }
  }
  return null;
}

/** Walk the string and collect every balanced {...} / [...] substring. */
function extractBalancedBlocks(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '{' && c !== '[') continue;
    const end = findBalancedClose(s, i);
    if (end !== -1) {
      out.push(s.slice(i, end + 1));
      // Don't advance i past end — nested blocks are also valid candidates.
    }
  }
  return out;
}

function findBalancedClose(s: string, startIdx: number): number {
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
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
