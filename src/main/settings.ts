import Store from 'electron-store';
import type { Settings } from '@shared/types';

const defaults: Settings = {
  anthropicApiKey: '',
  perplexityApiKey: '',
  scanRecency: 'week',
  // Deep Research scan defaults to twice daily, 9 AM and 9 PM local.
  // Opt-in: more expensive than the regular scan.
  deepScanCron: '0 9,21 * * *',
  deepScanEnabled: false,
  deepScanModel: 'sonar-deep-research',
  // v1.10.0: Opus dossier verification + strategic intel ON by default for
  // both brand and product research. Uncheck to revert to v1.9.x Stage-1-only.
  brandResearchAdvanced: true,
  productResearchAdvanced: true,
  // v1.10.2: Stage 4 fact-check ON by default. Uncheck to skip the
  // fetch + Opus verify pass that runs after Stages 2+3.
  brandResearchFactCheck: true,
  productResearchFactCheck: true,
  factCheckMaxSources: 10,
  minConfidence: 0.55,
  maxItemsPerScan: 30,
  liveMonitoringEnabled: false,
  // v1.12.1: lowered default 0.55 → 0.40 for NEW installs (existing user
  // settings preserved by electron-store). 0.55 was too strict in
  // practice — most real product-signal vs news-headline matches sit
  // around 0.40-0.50. Sonnet triage downstream is the cheap filter for
  // false positives; the embedding pre-filter should cast a wider net.
  embedSimilarityThreshold: 0.40,
  notifyOnNewOpportunity: true,
  openAtLogin: false,
  crossMatchEnabled: true
};

const store = new Store<Settings>({ name: 'settings', defaults });

export function getSettings(): Settings {
  return {
    anthropicApiKey: (store as any).get('anthropicApiKey') as string,
    perplexityApiKey: (store as any).get('perplexityApiKey') as string,
    scanRecency: (store as any).get('scanRecency') as 'day' | 'week' | 'month' | 'year',
    deepScanCron: (store as any).get('deepScanCron') as string,
    deepScanEnabled: (store as any).get('deepScanEnabled') as boolean,
    deepScanModel: (store as any).get('deepScanModel') as string,
    brandResearchAdvanced: (store as any).get('brandResearchAdvanced') as boolean,
    productResearchAdvanced: (store as any).get('productResearchAdvanced') as boolean,
    brandResearchFactCheck: (store as any).get('brandResearchFactCheck') as boolean,
    productResearchFactCheck: (store as any).get('productResearchFactCheck') as boolean,
    factCheckMaxSources: (store as any).get('factCheckMaxSources') as number,
    minConfidence: (store as any).get('minConfidence') as number,
    maxItemsPerScan: (store as any).get('maxItemsPerScan') as number,
    liveMonitoringEnabled: (store as any).get('liveMonitoringEnabled') as boolean,
    embedSimilarityThreshold: (store as any).get('embedSimilarityThreshold') as number,
    notifyOnNewOpportunity: (store as any).get('notifyOnNewOpportunity') as boolean,
    openAtLogin: (store as any).get('openAtLogin') as boolean,
    crossMatchEnabled: (store as any).get('crossMatchEnabled') as boolean
  };
}

export function updateSettings(patch: Partial<Settings>): Settings {
  for (const [k, v] of Object.entries(patch)) {
    (store as any).set(k, v);
  }
  return getSettings();
}
