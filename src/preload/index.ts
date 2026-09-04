import { contextBridge, ipcRenderer } from 'electron'
import type { JobTrailApi, VelopackApi, WindowControlsApi } from '../shared/types'

const invoke = <T>(channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args) as Promise<T>

const jobTrailApi: JobTrailApi = {
  config: {
    get: () => invoke('config:get'),
    update: (input) => invoke('config:update', input),
  },
  statuses: {
    list: () => invoke('statuses:list'),
    create: (input) => invoke('statuses:create', input),
    update: (id, input) => invoke('statuses:update', id, input),
    delete: (id) => invoke('statuses:delete', id),
    reorder: (order) => invoke('statuses:reorder', order),
  },
  industries: {
    list: () => invoke('industries:list'),
    create: (input) => invoke('industries:create', input),
    update: (id, input) => invoke('industries:update', id, input),
    delete: (id) => invoke('industries:delete', id),
    reorder: (order) => invoke('industries:reorder', order),
  },
  companies: {
    search: (keyword) => invoke('companies:search', keyword),
    recent: () => invoke('companies:recent'),
    create: (input) => invoke('companies:create', input),
    update: (id, input) => invoke('companies:update', id, input),
    delete: (id) => invoke('companies:delete', id),
    aliases: {
      list: (companyId) => invoke('companies:aliases:list', companyId),
      create: (input) => invoke('companies:aliases:create', input),
      update: (id, input) => invoke('companies:aliases:update', id, input),
      delete: (id) => invoke('companies:aliases:delete', id),
    },
  },
  resumes: {
    list: () => invoke('resumes:list'),
    import: () => invoke('resumes:import'),
    open: (id) => invoke('resumes:open', id),
    update: (id, input) => invoke('resumes:update', id, input),
    delete: (id) => invoke('resumes:delete', id),
  },
  opportunities: {
    list: (query) => invoke('opportunities:list', query),
    create: (input) => invoke('opportunities:create', input),
    update: (id, input) => invoke('opportunities:update', id, input),
    delete: (id) => invoke('opportunities:delete', id),
    changeStatus: (id, statusId) => invoke('opportunities:change-status', id, statusId),
  },
  calendar: {
    list: (range) => invoke('calendar:list', range),
    create: (input) => invoke('calendar:create', input),
    update: (id, input) => invoke('calendar:update', id, input),
    delete: (id) => invoke('calendar:delete', id),
    complete: (id, completed) => invoke('calendar:complete', id, completed),
  },
  system: {
    openExternal: (url) => invoke('system:open-external', url),
  },
}

const velopackApi: VelopackApi = {
  getVersion: () => invoke('velopack:get-version'),
  checkForUpdates: () => invoke('velopack:check-for-update'),
  downloadUpdates: (info) => invoke('velopack:download-update', info),
  applyUpdates: (info) => invoke('velopack:apply-update', info),
}

const windowControlsApi: WindowControlsApi = {
  minimize: () => invoke('window:minimize'),
  toggleMaximize: () => invoke('window:toggle-maximize'),
  close: () => invoke('window:close'),
}

contextBridge.exposeInMainWorld('jobTrailApi', jobTrailApi)
contextBridge.exposeInMainWorld('velopackApi', velopackApi)
contextBridge.exposeInMainWorld('windowControlsApi', windowControlsApi)
