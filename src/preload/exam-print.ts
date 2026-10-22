import { contextBridge, ipcRenderer } from 'electron'
import type { ExamPrintApi, ExamPrintDocument, ExamPrintState } from '../shared/exams'
import type { IpcResponse } from '../shared/ipc'

const jobId = process.argv
  .find((value) => value.startsWith('--jobtrail-exam-print='))
  ?.split('=')[1]
async function report(phase: ExamPrintState['phase']): Promise<void> {
  const result: IpcResponse<void> = await ipcRenderer.invoke('exams:print-state', {
    // Keep this sandbox entry self-contained: shared runtime imports create
    // relative CommonJS chunks which sandboxed Electron preloads cannot load.
    context: { traceId: crypto.randomUUID(), spanId: crypto.randomUUID() },
    args: [{ jobId, phase }],
  })
  if (!result.ok) throw new Error('Print bridge rejected')
}
const api: ExamPrintApi = {
  onDocument(listener) {
    const handler = (_event: Electron.IpcRendererEvent, document: ExamPrintDocument) => {
      if (document.jobId === jobId) listener(document)
    }
    ipcRenderer.on('exams:print-document', handler)
    return () => ipcRenderer.removeListener('exams:print-document', handler)
  },
  ready: () => report('ready'),
  complete: (success) => report(success ? 'complete' : 'failed'),
}
contextBridge.exposeInMainWorld('examPrintApi', api)
