import { contextBridge, ipcRenderer } from 'electron';

const api = {
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (patch: any) => ipcRenderer.invoke('settings:update', patch)
  },
  dashboard: {
    stats: () => ipcRenderer.invoke('dashboard:stats')
  },
  brands: {
    list: () => ipcRenderer.invoke('brands:list'),
    get: (id: number) => ipcRenderer.invoke('brands:get', id),
    create: (p: any) => ipcRenderer.invoke('brands:create', p),
    update: (id: number, p: any) => ipcRenderer.invoke('brands:update', id, p),
    delete: (id: number) => ipcRenderer.invoke('brands:delete', id)
  },
  products: {
    list: (brandId?: number) => ipcRenderer.invoke('products:list', brandId),
    get: (id: number) => ipcRenderer.invoke('products:get', id),
    create: (p: any) => ipcRenderer.invoke('products:create', p),
    update: (id: number, p: any) => ipcRenderer.invoke('products:update', id, p),
    delete: (id: number) => ipcRenderer.invoke('products:delete', id),
    research: (id: number) => ipcRenderer.invoke('products:research', id)
  },
  knowledge: {
    list: (brandId?: number) => ipcRenderer.invoke('knowledge:list', brandId),
    addNote: (p: any) => ipcRenderer.invoke('knowledge:addNote', p),
    addLink: (p: any) => ipcRenderer.invoke('knowledge:addLink', p),
    upload: (brandId: number) => ipcRenderer.invoke('knowledge:upload', brandId),
    delete: (id: number) => ipcRenderer.invoke('knowledge:delete', id)
  },
  sources: {
    list: () => ipcRenderer.invoke('sources:list'),
    create: (p: any) => ipcRenderer.invoke('sources:create', p),
    update: (id: number, p: any) => ipcRenderer.invoke('sources:update', id, p),
    delete: (id: number) => ipcRenderer.invoke('sources:delete', id)
  },
  scan: {
    run: () => ipcRenderer.invoke('scan:run'),
    runs: () => ipcRenderer.invoke('scan:runs'),
    runGet: (id: number) => ipcRenderer.invoke('scan:run:get', id)
  },
  opps: {
    list: (status?: string) => ipcRenderer.invoke('opps:list', status),
    get: (id: number) => ipcRenderer.invoke('opps:get', id),
    setStatus: (id: number, status: string) =>
      ipcRenderer.invoke('opps:setStatus', id, status),
    brief: (id: number) => ipcRenderer.invoke('opps:brief', id),
    dispatch: (id: number, target: string, payload: string) =>
      ipcRenderer.invoke('opps:dispatch', id, target, payload)
  },
  openExternal: (url: string) => ipcRenderer.invoke('openExternal', url)
};

contextBridge.exposeInMainWorld('lh', api);
export type LhApi = typeof api;
