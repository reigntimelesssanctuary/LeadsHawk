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

type CompleteOpts = {
  maxTokens?: number;
  temperature?: number;
  stage?: LlmStage;
  relatedId?: number | null;
};

export async function complete(
  system: string,
  prompt: string,
  opts: CompleteOpts = {}
): Promise<string> {
  const client = getClient();
  const { model } = getSettings();
  const modelId = model || 'claude-opus-4-7';
  const resp = await client.messages.create({
    model: modelId,
    max_tokens: opts.maxTokens ?? 2000,
    temperature: opts.temperature ?? 0.2,
    system,
    messages: [{ role: 'user', content: prompt }]
  });
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
