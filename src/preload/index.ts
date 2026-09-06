import { contextBridge, ipcRenderer } from 'electron'
import type { IpcArgs, IpcChannel, IpcResponse, IpcResult } from '../shared/ipc'
import type { CalendarReminderNotification, ZhijiApi, VelopackApi, WindowControlsApi, AppErrorCode, AppErrorShape } from '../shared/types'

class IpcClientError extends Error {
  readonly code: AppErrorCode
  readonly details: Record<string, unknown> | undefined
  constructor(error: AppErrorShape) {
    super(error.message)
    this.name = 'IpcClientError'
    this.code = error.code
    this.details = error.details
  }
}

const invoke = async <K extends IpcChannel>(channel: K, ...args: IpcArgs<K>): Promise<IpcResult<K>> => {
  const response = await ipcRenderer.invoke(channel, ...args) as IpcResponse<IpcResult<K>>
  if (!response.ok) throw new IpcClientError(response.error)
  return response.data
}

const zhijiApi: ZhijiApi = {
  config: {
    get: () => invoke('config:get'),
    update: (input) => invoke('config:update', input),
  },
  statuses: {
    list: () => invoke('statuses:list'),
    get: (id) => invoke('statuses:get', id),
    create: (input) => invoke('statuses:create', input),
    update: (id, input) => invoke('statuses:update', id, input),
    delete: (id) => invoke('statuses:delete', id),
    reorder: (order) => invoke('statuses:reorder', order),
  },
  industries: {
    list: () => invoke('industries:list'),
    get: (id) => invoke('industries:get', id),
    create: (input) => invoke('industries:create', input),
    update: (id, input) => invoke('industries:update', id, input),
    delete: (id) => invoke('industries:delete', id),
    reorder: (order) => invoke('industries:reorder', order),
  },
  companies: {
    search: (keyword) => invoke('companies:search', keyword),
    list: () => invoke('companies:list'),
    get: (id) => invoke('companies:get', id),
    markRead: (id) => invoke('companies:mark-read', id),
    create: (input) => invoke('companies:create', input),
    update: (id, input) => invoke('companies:update', id, input),
    delete: (id) => invoke('companies:delete', id),
  },
  resumes: {
    list: () => invoke('resumes:list'),
    get: (id) => invoke('resumes:get', id),
    import: () => invoke('resumes:import'),
    open: (id) => invoke('resumes:open', id),
    update: (id, input) => invoke('resumes:update', id, input),
    reorder: (order) => invoke('resumes:reorder', order),
    delete: (id) => invoke('resumes:delete', id),
  },
  opportunities: {
    list: (query) => invoke('opportunities:list', query),
    get: (id) => invoke('opportunities:get', id),
    create: (input) => invoke('opportunities:create', input),
    update: (id, input) => invoke('opportunities:update', id, input),
    delete: (id) => invoke('opportunities:delete', id),
    changeStatus: (id, statusId) => invoke('opportunities:change-status', id, statusId),
  },
  calendar: {
    list: (range) => invoke('calendar:list', range),
    get: (id) => invoke('calendar:get', id),
    create: (input) => invoke('calendar:create', input),
    update: (id, input) => invoke('calendar:update', id, input),
    delete: (id) => invoke('calendar:delete', id),
    complete: (id, completed) => invoke('calendar:complete', id, completed),
    onReminderClick: (listener: (notification: CalendarReminderNotification) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, notification: CalendarReminderNotification) => listener(notification)
      ipcRenderer.on('calendar:reminder-click', handler)
      return () => ipcRenderer.removeListener('calendar:reminder-click', handler)
    },
  },
  system: {
    openExternal: (url) => invoke('system:open-external', url),
    isDevelopment: () => invoke('system:is-development'),
  },
}

const velopackApi: VelopackApi = {
  getVersion: () => invoke('velopack:get-version'),
  checkForUpdates: () => invoke('velopack:check-for-update'),
  downloadUpdates: () => invoke('velopack:download-update'),
  applyUpdates: () => invoke('velopack:apply-update'),
  uninstall: () => invoke('velopack:uninstall'),
}

const windowControlsApi: WindowControlsApi = {
  minimize: () => invoke('window:minimize'),
  toggleMaximize: () => invoke('window:toggle-maximize'),
  close: () => invoke('window:close'),
}

contextBridge.exposeInMainWorld('zhijiApi', zhijiApi)
contextBridge.exposeInMainWorld('velopackApi', velopackApi)
contextBridge.exposeInMainWorld('windowControlsApi', windowControlsApi)
