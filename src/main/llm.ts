import Anthropic from '@anthropic-ai/sdk';
import { getSettings } from './settings.js';
import { recordApiCall } from './spend.js';
import type { LlmStage } from './pricing.js';

export function getClient(): Anthropic {
  const { anthropicApiKey } = getSettings();
  if (!anthropicApiKey) {
    throw new Error('Anthropic API key not configured. Open Settings to add it.');
  }
  return new Anthropic({ apiKey: anthropicApiKey });
}

/**
 * v1.10.1: Anthropic deprecated the `temperature` parameter for Claude Opus
 * 4.7 — passing it returns HTTP 400 `temperature is deprecated for this
 * model`. Future 4.7+ models may follow. Gate by an explicit known-deprecated
 * allowlist rather than guessing; add IDs here as Anthropic updates.
 *
 * Exported for smoke testing — kept simple (pure function) so the smoke
 * suite can inline a byte-identical copy per the existing convention.
 */
export function modelSupportsTemperature(modelId: string): boolean {
  const TEMPERATURE_DEPRECATED: RegExp[] = [
    /^claude-opus-4-7/i
  ];
  return !TEMPERATURE_DEPRECATED.some((re) => re.test(modelId));
}

type CompleteOpts = {
  maxTokens?: number;
  temperature?: number;
  stage?: LlmStage;
  relatedId?: number | null;
  /**
   * v1.9: optional model override so callers (e.g. the two-stage deep
   * scan's qualifier) can pick a Claude model independent of the
   * user's brief-generation default in Settings.
   */
  model?: string;
};

export async function complete(
  system: string,
  prompt: string,
  opts: CompleteOpts = {}
): Promise<string> {
  const client = getClient();
  const { model } = getSettings();
  const modelId = opts.model || model || 'claude-opus-4-7';
  // v1.10.1: Anthropic deprecated `temperature` on Opus 4.7. Only set it
  // for models where it's still supported.
  const req: Anthropic.MessageCreateParamsNonStreaming = {
    model: modelId,
    max_tokens: opts.maxTokens ?? 2000,
    system,
    messages: [{ role: 'user', content: prompt }]
  };
  if (modelSupportsTemperature(modelId)) {
    req.temperature = opts.temperature ?? 0.2;
  }
  const resp = await client.messages.create(req);
  recordApiCall({
    provider: 'anthropic',
    model: modelId,
    stage: opts.stage ?? 'unknown',
    inputTokens: Number((resp as any).usage?.input_tokens ?? 0),
    outputTokens: Number((resp as any).usage?.output_tokens ?? 0),
    relatedId: opts.relatedId ?? null
  });
  const parts = resp.content
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text);
  return parts.join('\n').trim();
}

export async function completeJson<T = any>(
  system: string,
  prompt: string,
  opts: CompleteOpts = {}
): Promise<T> {
  const raw = await complete(
    system + '\n\nAlways respond with strictly valid JSON only, no prose, no code fences.',
    prompt,
    opts
  );
  const cleaned = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const start = cleaned.indexOf('{');
    const startArr = cleaned.indexOf('[');
    const firstBrace =
      start === -1 ? startArr : startArr === -1 ? start : Math.min(start, startArr);
    if (firstBrace === -1) throw new Error('LLM returned non-JSON: ' + cleaned.slice(0, 200));
    const last = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'));
    return JSON.parse(cleaned.slice(firstBrace, last + 1));
  }
}
