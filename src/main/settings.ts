import Store from 'electron-store';
import type { Settings } from '@shared/types';

const defaults: Settings = {
  anthropicApiKey: '',
  model: 'claude-opus-4-7',
  perplexityApiKey: '',
  perplexityResearchModel: 'sonar-deep-research',
  perplexityScanModel: 'sonar-pro',
  scanRecency: 'week',
  scanCron: '0 */6 * * *',
  scanEnabled: false,
  minConfidence: 0.55,
  maxItemsPerScan: 30
};

const store = new Store<Settings>({ name: 'settings', defaults });

export function getSettings(): Settings {
  return {
    anthropicApiKey: (store as any).get('anthropicApiKey') as string,
    model: (store as any).get('model') as string,
    perplexityApiKey: (store as any).get('perplexityApiKey') as string,
    perplexityResearchModel: (store as any).get('perplexityResearchModel') as string,
    perplexityScanModel: (store as any).get('perplexityScanModel') as string,
    scanRecency: (store as any).get('scanRecency') as 'day' | 'week' | 'month',
    scanCron: (store as any).get('scanCron') as string,
    scanEnabled: (store as any).get('scanEnabled') as boolean,
    minConfidence: (store as any).get('minConfidence') as number,
    maxItemsPerScan: (store as any).get('maxItemsPerScan') as number
  };
}

export function updateSettings(patch: Partial<Settings>): Settings {
  for (const [k, v] of Object.entries(patch)) {
    (store as any).set(k, v);
  }
  return getSettings();
}
