import { contextBridge, ipcRenderer } from 'electron'
import type { IpcArgs, IpcChannel, IpcResponse, IpcResult } from '../shared/ipc'
import { faultInput, type FaultInput } from '../shared/diagnostics'
import type {
  CalendarReminderNotification,
  ZhijiApi,
  VelopackApi,
  WindowControlsApi,
  AppUpdateProgress,
} from '../shared/types'

function sendDiagnostic(input: FaultInput | null): void {
  if (!input) return
  try {
    ipcRenderer.send('diagnostics:report', input)
  } catch {
    // A broken diagnostic transport must not replace the original failure.
  }
}

if (typeof window !== 'undefined') {
  const reportLocalFault = (operation: string, error: unknown) => {
    try {
      const input = faultInput('preload', operation, error)
      if (input?.stack?.some((frame) => /^(?:src|out)\/preload\//.test(frame)))
        sendDiagnostic(input)
    } catch {
      // The error handler must not fail while reporting its own error.
    }
  }
  window.addEventListener('error', (event) => reportLocalFault('process.uncaught', event.error))
  window.addEventListener('unhandledrejection', (event) =>
    reportLocalFault('process.unhandled-rejection', event.reason),
  )
}

const invoke = async <K extends IpcChannel>(
  channel: K,
  ...args: IpcArgs<K>
): Promise<IpcResult<K>> => {
  let response: IpcResponse<IpcResult<K>>
  try {
    response = (await ipcRenderer.invoke(channel, ...args)) as IpcResponse<IpcResult<K>>
  } catch (error) {
    sendDiagnostic(faultInput('preload', 'ipc-transport', error))
    throw error
  }
  // contextBridge drops custom Error properties. Reject with cloneable data to preserve the code.
  if (!response.ok) throw { name: 'IpcClientError', ...response.error }
  return response.data
}

const zhijiApi: ZhijiApi = {
  exams: {
    get: (input) => invoke('exams:get', input),
    save: (input) => invoke('exams:save', input),
    submit: (input) => invoke('exams:submit', input),
    reset: (input) => invoke('exams:reset', input),
    grade: (input) => invoke('exams:grade', input),
    onChanged(listener) {
      const handler = (
        _event: Electron.IpcRendererEvent,
        input: import('../shared/exams').ExamIdentity,
      ) => listener(input)
      ipcRenderer.on('exams:changed', handler)
      return () => ipcRenderer.removeListener('exams:changed', handler)
    },
  },
  backup: {
    export: () => invoke('backup:export'),
    import: () => invoke('backup:import'),
  },
  agent: {
    list: () => invoke('agent:list'),
    create: () => invoke('agent:create'),
    history: (id) => invoke('agent:history', id),
    rename: (id, title) => invoke('agent:rename', id, title),
    delete: (id) => invoke('agent:delete', id),
    upload: (id) => invoke('agent:upload', id),
    uploadBytes: (id, name, mimeType, bytes) =>
      invoke('agent:upload-bytes', id, name, mimeType, bytes),
    preview: (id, attachmentId) => invoke('agent:preview', id, attachmentId),
    openAttachment: (id, attachmentId) => invoke('agent:open-attachment', id, attachmentId),
    removeUpload: (id, attachmentId) => invoke('agent:remove-upload', id, attachmentId),
    send: (id, parts, attachmentIds, jobId) =>
      invoke('agent:send', id, parts, attachmentIds, jobId),
    compact: (id, jobId) => invoke('agent:compact', id, jobId),
    resume: (id, answer, jobId) => invoke('agent:resume', id, answer, jobId),
    cancel: (id) => invoke('agent:cancel', id),
    saveSettings: (ai) => invoke('agent:save-settings', ai),
    onEvent: (listener) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        payload: Parameters<typeof listener>[0],
      ) => listener(payload)
      ipcRenderer.on('agent:event', handler)
      return () => ipcRenderer.removeListener('agent:event', handler)
    },
  },
  data: {
    onExternalChange: (listener: () => void) => {
      const handler = () => listener()
      ipcRenderer.on('data:external-change', handler)
      return () => ipcRenderer.removeListener('data:external-change', handler)
    },
  },
  config: {
    get: () => invoke('config:get'),
    update: (input) => invoke('config:update', input),
  },
  mcp: {
    getConnectionInfo: () => invoke('mcp:get-connection-info'),
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
    reorder: (input) => invoke('industries:reorder', input),
  },
  companies: {
    search: (query) => invoke('companies:search', query),
    list: () => invoke('companies:list'),
    get: (id) => invoke('companies:get', id),
    markRead: (id) => invoke('companies:mark-read', id),
    create: (input) => invoke('companies:create', input),
    update: (id, input) => invoke('companies:update', id, input),
    delete: (id) => invoke('companies:delete', id),
  },
  companyCatalog: {
    getStatus: () => invoke('company-catalog:get-status'),
    update: () => invoke('company-catalog:update'),
    onProgress: (listener) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        progress: Parameters<typeof listener>[0],
      ) => listener(progress)
      ipcRenderer.on('company-catalog:progress', handler)
      return () => ipcRenderer.removeListener('company-catalog:progress', handler)
    },
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
    search: (query) => invoke('opportunities:search', query),
    list: () => invoke('opportunities:list'),
    get: (id) => invoke('opportunities:get', id),
    statusFlow: (id) => invoke('opportunities:status-flow', id),
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
    onReminderClick: (listener: (notification: CalendarReminderNotification) => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        notification: CalendarReminderNotification,
      ) => listener(notification)
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
  rendererHealthy: () => invoke('velopack:renderer-healthy'),
  checkForUpdates: () => invoke('velopack:check-for-update'),
  downloadUpdates: (attemptId) => invoke('velopack:download-update', attemptId),
  applyUpdates: (attemptId) => invoke('velopack:apply-update', attemptId),
  onProgress: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: AppUpdateProgress) =>
      listener(progress)
    ipcRenderer.on('velopack:progress', handler)
    return () => ipcRenderer.removeListener('velopack:progress', handler)
  },
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
contextBridge.exposeInMainWorld('diagnosticsApi', {
  report: (input: FaultInput) => sendDiagnostic(input),
})
