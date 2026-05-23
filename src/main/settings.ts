import Store from 'electron-store';
import type { Settings } from '@shared/types';

const defaults: Settings = {
  anthropicApiKey: '',
  model: 'claude-opus-4-7',
  triageModel: 'claude-sonnet-4-6',
  perplexityApiKey: '',
  perplexityResearchModel: 'sonar-deep-research',
  perplexityScanModel: 'sonar-pro',
  scanRecency: 'week',
  scanCron: '0 */6 * * *',
  scanEnabled: false,
  minConfidence: 0.55,
  maxItemsPerScan: 30,
  liveMonitoringEnabled: false,
  embedSimilarityThreshold: 0.55,
  notifyOnNewOpportunity: true,
  openAtLogin: false
};

const store = new Store<Settings>({ name: 'settings', defaults });

export function getSettings(): Settings {
  return {
    anthropicApiKey: (store as any).get('anthropicApiKey') as string,
    model: (store as any).get('model') as string,
    triageModel: (store as any).get('triageModel') as string,
    perplexityApiKey: (store as any).get('perplexityApiKey') as string,
    perplexityResearchModel: (store as any).get('perplexityResearchModel') as string,
    perplexityScanModel: (store as any).get('perplexityScanModel') as string,
    scanRecency: (store as any).get('scanRecency') as 'day' | 'week' | 'month',
    scanCron: (store as any).get('scanCron') as string,
    scanEnabled: (store as any).get('scanEnabled') as boolean,
    minConfidence: (store as any).get('minConfidence') as number,
    maxItemsPerScan: (store as any).get('maxItemsPerScan') as number,
    liveMonitoringEnabled: (store as any).get('liveMonitoringEnabled') as boolean,
    embedSimilarityThreshold: (store as any).get('embedSimilarityThreshold') as number,
    notifyOnNewOpportunity: (store as any).get('notifyOnNewOpportunity') as boolean,
    openAtLogin: (store as any).get('openAtLogin') as boolean
  };
}

export function updateSettings(patch: Partial<Settings>): Settings {
  for (const [k, v] of Object.entries(patch)) {
    (store as any).set(k, v);
  }
  return getSettings();
}
