import { getSettings } from './settings.js';

const PPLX_URL = 'https://api.perplexity.ai/chat/completions';

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

export async function completePerplexity<T = unknown>(
  system: string,
  user: string,
  opts: PplxOptions = {}
): Promise<PplxResponse<T>> {
  const key = getKey();
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

  const resp = await fetch(PPLX_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
      accept: 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Perplexity API ${resp.status}: ${text.slice(0, 500)}`);
  }
  const data = await resp.json();
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

  return {
    text,
    json,
    citations,
    usage: data?.usage ?? null,
    raw: data
  };
}

export function tryParseJson<T>(raw: string): T | null {
  if (!raw) return null;
  let s = raw.trim();
  // Strip <think>...</think> blocks that some reasoning models prepend
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  // Strip ```json fences
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    return JSON.parse(s) as T;
  } catch {
    const firstObj = s.indexOf('{');
    const firstArr = s.indexOf('[');
    const first =
      firstObj === -1 ? firstArr : firstArr === -1 ? firstObj : Math.min(firstObj, firstArr);
    if (first === -1) return null;
    const last = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
    if (last === -1) return null;
    try {
      return JSON.parse(s.slice(first, last + 1)) as T;
    } catch {
      return null;
    }
  }
}
