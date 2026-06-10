import { contextBridge, ipcRenderer } from 'electron';

const api = {
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (patch: any) => ipcRenderer.invoke('settings:update', patch),
    // v1.19.0 — Apollo API key validation (Settings → Contact API "Test" button).
    validateApolloKey: (key?: string) => ipcRenderer.invoke('settings:validateApolloKey', key),
    // v1.20.0 — Hunter.io API key validation.
    validateHunterKey: (key?: string) => ipcRenderer.invoke('settings:validateHunterKey', key)
  },
  dashboard: {
    stats: () => ipcRenderer.invoke('dashboard:stats')
  },
  brands: {
    list: () => ipcRenderer.invoke('brands:list'),
    get: (id: number) => ipcRenderer.invoke('brands:get', id),
    create: (p: any) => ipcRenderer.invoke('brands:create', p),
    update: (id: number, p: any) => ipcRenderer.invoke('brands:update', id, p),
    delete: (id: number) => ipcRenderer.invoke('brands:delete', id),
    research: (id: number, opts?: { feedback?: string }) =>
      ipcRenderer.invoke('brands:research', id, opts),
    researchSignals: (id: number, opts?: { feedback?: string }) =>
      ipcRenderer.invoke('brands:researchSignals', id, opts),
    // v1.15.0: persist edits to brand-level signals + lock state.
    updateSignals: (id: number, signalsText: string, lockedJson: string) =>
      ipcRenderer.invoke('brands:updateSignals', id, signalsText, lockedJson),
    researchSources: (id: number, opts?: { feedback?: string }) =>
      ipcRenderer.invoke('brands:researchSources', id, opts),
    addSuggestedSources: (
      id: number,
      suggestions: any[],
      opts?: { trialPeriod?: '24h' | '48h' | '7d' | 'permanent' }
    ) => ipcRenderer.invoke('brands:addSuggestedSources', id, suggestions, opts),
    pendingSources: (id: number) => ipcRenderer.invoke('brands:pendingSources', id),
    pendingSourcesSummary: () => ipcRenderer.invoke('brands:pendingSourcesSummary'),
    dismissPendingSources: (id: number) =>
      ipcRenderer.invoke('brands:dismissPendingSources', id),
    setScanEnabled: (id: number, enabled: boolean) =>
      ipcRenderer.invoke('brands:setScanEnabled', id, enabled)
  },
  products: {
    list: (brandId?: number) => ipcRenderer.invoke('products:list', brandId),
    get: (id: number) => ipcRenderer.invoke('products:get', id),
    create: (p: any) => ipcRenderer.invoke('products:create', p),
    update: (id: number, p: any) => ipcRenderer.invoke('products:update', id, p),
    delete: (id: number) => ipcRenderer.invoke('products:delete', id),
    research: (id: number, opts?: { feedback?: string }) =>
      ipcRenderer.invoke('products:research', id, opts),
    researchSignals: (id: number, opts?: { feedback?: string }) =>
      ipcRenderer.invoke('products:researchSignals', id, opts),
    // v1.15.0: persist edits to product-level signals + lock state.
    // Main also auto-re-embeds after the write, so Live Monitor's
    // pre-filter stays in sync.
    updateSignals: (id: number, signalsText: string, lockedJson: string) =>
      ipcRenderer.invoke('products:updateSignals', id, signalsText, lockedJson),
    reembed: (id: number) => ipcRenderer.invoke('products:reembed', id),
    embeddingStatus: (): Promise<Record<number, number>> =>
      ipcRenderer.invoke('products:embeddingStatus'),
    setScanEnabled: (id: number, enabled: boolean) =>
      ipcRenderer.invoke('products:setScanEnabled', id, enabled)
  },
  feedback: {
    list: (kind: 'brand' | 'product' | 'brand_signals' | 'product_signals' | 'brand_sources', targetId: number) =>
      ipcRenderer.invoke('feedback:list', kind, targetId),
    delete: (id: number) => ipcRenderer.invoke('feedback:delete', id)
  },
  knowledge: {
    list: (brandId?: number) => ipcRenderer.invoke('knowledge:list', brandId),
    addNote: (p: { brandId: number; productId?: number | null; title: string; content: string }) =>
      ipcRenderer.invoke('knowledge:addNote', p),
    addLink: (p: { brandId: number; productId?: number | null; url: string }) =>
      ipcRenderer.invoke('knowledge:addLink', p),
    upload: (brandId: number, productId?: number | null) =>
      ipcRenderer.invoke('knowledge:upload', brandId, productId ?? null),
    delete: (id: number) => ipcRenderer.invoke('knowledge:delete', id)
  },
  sources: {
    list: () => ipcRenderer.invoke('sources:list'),
    create: (p: any) => ipcRenderer.invoke('sources:create', p),
    update: (id: number, p: any) => ipcRenderer.invoke('sources:update', id, p),
    delete: (id: number) => ipcRenderer.invoke('sources:delete', id)
  },
  rules: {
    list: (productId: number) => ipcRenderer.invoke('rules:list', productId),
    create: (p: { productId: number; kind: 'include' | 'exclude'; text: string }) =>
      ipcRenderer.invoke('rules:create', p),
    update: (id: number, p: any) => ipcRenderer.invoke('rules:update', id, p),
    delete: (id: number) => ipcRenderer.invoke('rules:delete', id),
    listGlobal: () => ipcRenderer.invoke('rules:listGlobal'),
    createGlobal: (p: { kind: 'include' | 'exclude'; text: string }) =>
      ipcRenderer.invoke('rules:createGlobal', p)
  },
  scan: {
    // v1.12.0: manual scan retired. `run` is gone; use `runDeep`.
    runDeep: () => ipcRenderer.invoke('scan:runDeep'),
    runs: () => ipcRenderer.invoke('scan:runs'),
    runGet: (id: number) => ipcRenderer.invoke('scan:run:get', id)
  },
  opps: {
    list: (status?: string) => ipcRenderer.invoke('opps:list', status),
    get: (id: number) => ipcRenderer.invoke('opps:get', id),
    setStatus: (id: number, status: string) =>
      ipcRenderer.invoke('opps:setStatus', id, status),
    disqualify: (id: number, reason?: string | null) =>
      ipcRenderer.invoke('opps:disqualify', id, reason ?? null),
    delete: (id: number) => ipcRenderer.invoke('opps:delete', id),
    deleteMany: (ids: number[]) => ipcRenderer.invoke('opps:deleteMany', ids),
    exportXlsx: (ids: number[]) => ipcRenderer.invoke('opps:exportXlsx', ids),
    brief: (id: number) => ipcRenderer.invoke('opps:brief', id),
    dispatch: (id: number, target: string, payload: string) =>
      ipcRenderer.invoke('opps:dispatch', id, target, payload),
    // v1.16.0: derived lifecycle state for a single opportunity.
    state: (id: number) => ipcRenderer.invoke('opps:state', id)
  },
  // v1.16.0: opportunity lifecycle event log.
  events: {
    append: (opportunityId: number, eventType: string, payload?: any) =>
      ipcRenderer.invoke('events:append', opportunityId, eventType, payload),
    list: (opportunityId: number) => ipcRenderer.invoke('events:list', opportunityId)
  },
  pipeline: {
    summary: () => ipcRenderer.invoke('pipeline:summary'),
    staleIds: (thresholdDays: number = 14) =>
      ipcRenderer.invoke('pipeline:staleIds', thresholdDays)
  },
  // v1.17.0: learning loop status (per-dimension counts + informing rows).
  learning: {
    status: () => ipcRenderer.invoke('learning:status')
  },
  spend: {
    summary: () => ipcRenderer.invoke('spend:summary')
  },
  cost: {
    summary: () => ipcRenderer.invoke('cost:summary')
  },
  // v1.19.0 — Contact search + drafts (Phase 1 of outbound).
  contacts: {
    search: (oppId: number) => ipcRenderer.invoke('contacts:search', oppId),
    searchBatch: (oppIds: number[]) => ipcRenderer.invoke('contacts:searchBatch', oppIds),
    listForOpp: (oppId: number) => ipcRenderer.invoke('contacts:listForOpp', oppId),
    listDrafts: (contactId: number) => ipcRenderer.invoke('contacts:listDrafts', contactId),
    draftEmail: (contactId: number, opts?: { feedback?: string | null }) =>
      ipcRenderer.invoke('contacts:draftEmail', contactId, opts),
    setActiveDraft: (contactId: number, draftId: number) =>
      ipcRenderer.invoke('contacts:setActiveDraft', contactId, draftId),
    updateDraft: (draftId: number, subject: string, body: string) =>
      ipcRenderer.invoke('contacts:updateDraft', draftId, subject, body),
    markSent: (contactId: number) => ipcRenderer.invoke('contacts:markSent', contactId),
    skip: (contactId: number) => ipcRenderer.invoke('contacts:skip', contactId),
    unskip: (contactId: number) => ipcRenderer.invoke('contacts:unskip', contactId),
    delete: (contactId: number) => ipcRenderer.invoke('contacts:delete', contactId)
  },
  openExternal: (url: string) => ipcRenderer.invoke('openExternal', url),
  monitor: {
    status: () => ipcRenderer.invoke('monitor:status'),
    start: () => ipcRenderer.invoke('monitor:start'),
    stop: () => ipcRenderer.invoke('monitor:stop'),
    running: () => ipcRenderer.invoke('monitor:running'),
    log: () => ipcRenderer.invoke('monitor:log'),
    items: (limit?: number) => ipcRenderer.invoke('monitor:items', limit),
    sources: () => ipcRenderer.invoke('monitor:sources'),
    sourceCreate: (p: any) => ipcRenderer.invoke('monitor:sources:create', p),
    sourceUpdate: (id: number, p: any) => ipcRenderer.invoke('monitor:sources:update', id, p),
    sourceDelete: (id: number) => ipcRenderer.invoke('monitor:sources:delete', id),
    sourcesHealth: () => ipcRenderer.invoke('monitor:sources:health'),
    promoteTrial: (id: number) => ipcRenderer.invoke('monitor:sources:promoteTrial', id),
    extendTrial: (id: number, days: number) => ipcRenderer.invoke('monitor:sources:extendTrial', id, days),
    intake: (p: { url: string; title?: string }) => ipcRenderer.invoke('monitor:intake', p)
  },
  onNavigate: (cb: (data: { kind: string; id: number }) => void) => {
    ipcRenderer.on('navigate', (_e, data) => cb(data));
  }
};

contextBridge.exposeInMainWorld('lh', api);
export type LhApi = typeof api;
