import { app, BrowserWindow, dialog, ipcMain, session, type IpcMainInvokeEvent } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { ExamService } from './services/exam-service'
import type { Locale } from '../shared/types'
import { examPrintStateSchema, type ExamPrintDocument } from '../shared/exams'
import { validDiagnosticContext } from '../shared/diagnostics'
import { AppServiceError } from './services/errors'
import { examPdfFilename, examPdfTarget, writeExamPdf } from './exam-pdf-file'
import { recordEvent } from './diagnostics'

export class ExamPdfExporter {
  private busy = false
  private cancel?: () => void
  private quitting = false
  private finishing?: Promise<void>
  private onQuit = () => {
    this.quitting = true
    this.cancel?.()
  }
  constructor(
    private readonly exams: ExamService,
    private readonly root: string,
    private readonly locale: () => Locale,
    private readonly owner: () => BrowserWindow | undefined,
  ) {
    app.on('before-quit', this.onQuit)
  }
  async close(): Promise<void> {
    this.onQuit()
    // A native save dialog has no work to drain. Once a destination has been
    // chosen, shutdown waits for rendering/file cleanup before exiting.
    await this.finishing
  }

  async export(input: unknown): Promise<'exported' | 'cancelled'> {
    if (this.busy) throw new AppServiceError('EXAM_EXPORT_BUSY', 'PDF export already running')
    if (this.quitting) return 'cancelled'
    // Business validation errors retain their original error codes.
    const snapshot = this.exams.exportSnapshot(input)
    const locale = this.locale()
    const owner = this.owner()
    this.busy = true
    let finish: (() => void) | undefined
    let cancelled = false
    const cancel = () => {
      cancelled = true
      this.cancel?.()
    }
    owner?.once('closed', cancel)
    try {
      const options: Electron.SaveDialogOptions = {
        title: locale === 'en-US' ? 'Export PDF' : '导出 PDF',
        defaultPath: path.join(app.getPath('documents'), examPdfFilename(snapshot.paper.title)),
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
        properties: ['showOverwriteConfirmation'],
      }
      const picked = await (owner
        ? dialog.showSaveDialog(owner, options)
        : dialog.showSaveDialog(options))
      if (picked.canceled || !picked.filePath || cancelled || this.quitting) return 'cancelled'
      this.finishing = new Promise<void>((resolve) => {
        finish = resolve
      })
      const file = await examPdfTarget(picked.filePath, this.root)
      if (cancelled || this.quitting) return 'cancelled'
      const started = Date.now()
      const bytes = await this.render({ ...snapshot, locale, jobId: randomUUID() })
      if (cancelled || this.quitting) return 'cancelled'
      await writeExamPdf(file, bytes, this.root)
      recordEvent({
        operation: 'exam.export-pdf',
        outcome: 'succeeded',
        attributes: { count: snapshot.paper.questions.length, durationMs: Date.now() - started },
      })
      return 'exported'
    } catch (error) {
      if (cancelled || this.quitting) return 'cancelled'
      throw new AppServiceError('EXAM_EXPORT_FAILED', 'PDF export failed', undefined, {
        cause: error,
      })
    } finally {
      owner?.removeListener('closed', cancel)
      this.cancel = undefined
      this.busy = false
      finish?.()
      this.finishing = undefined
    }
  }

  private async render(document: ExamPrintDocument): Promise<Buffer> {
    const isolated = session.fromPartition(`exam-pdf-${document.jobId}`)
    const rendererFile = path.join(app.getAppPath(), 'out/renderer/exam-print.html')
    const devUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
    const pageUrl = devUrl
      ? new URL('exam-print.html', devUrl.endsWith('/') ? devUrl : devUrl + '/').href
      : pathToFileURL(rendererFile).href
    const allowedResource = (value: string) => {
      try {
        const url = new URL(value)
        if (devUrl)
          return (
            url.origin === new URL(devUrl).origin ||
            ((url.protocol === 'ws:' || url.protocol === 'wss:') &&
              url.host === new URL(devUrl).host)
          )
        if (url.protocol !== 'file:') return false
        const base = pathToFileURL(path.dirname(rendererFile) + path.sep).href
        return url.href.startsWith(base)
      } catch {
        return false
      }
    }
    isolated.webRequest.onBeforeRequest((details, callback) =>
      callback({ cancel: !allowedResource(details.url) }),
    )
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    isolated.setPermissionCheckHandler(() => false)
    let window: BrowserWindow
    try {
      window = new BrowserWindow({
        show: false,
        skipTaskbar: true,
        webPreferences: {
          session: isolated,
          preload: path.join(app.getAppPath(), 'out/preload/exam-print.js'),
          additionalArguments: [`--jobtrail-exam-print=${document.jobId}`],
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          backgroundThrottling: false,
        },
      })
    } catch (error) {
      isolated.webRequest.onBeforeRequest(null)
      await isolated.closeAllConnections()
      throw error
    }
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event) => event.preventDefault())
    window.webContents.on('will-attach-webview', (event) => event.preventDefault())
    let timer: ReturnType<typeof setTimeout> | undefined
    let rejectPending: ((error: Error) => void) | undefined
    let delivered = false
    let completed = false
    const fail = () => rejectPending?.(new Error('PDF renderer unavailable'))
    this.cancel = fail
    const onState = async (event: IpcMainInvokeEvent, envelope: unknown) => {
      if (
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame ||
        !event.senderFrame
      )
        return { ok: false, error: { code: 'VALIDATION_ERROR' } }
      const value = envelope as { context?: unknown; args?: unknown[] } | null
      const parsed =
        Array.isArray(value?.args) && value.args.length === 1
          ? examPrintStateSchema.safeParse(value.args[0])
          : undefined
      if (
        !validDiagnosticContext(value?.context) ||
        !parsed?.success ||
        parsed.data.jobId !== document.jobId
      )
        return { ok: false, error: { code: 'VALIDATION_ERROR' } }
      if (parsed.data.phase === 'ready' && !delivered) {
        delivered = true
        window.webContents.send('exams:print-document', document)
      } else if (parsed.data.phase === 'complete' && delivered && !completed) {
        completed = true
        readyResolve?.()
      } else if (parsed.data.phase === 'failed') fail()
      else return { ok: false, error: { code: 'VALIDATION_ERROR' } }
      return { ok: true, data: undefined }
    }
    let readyResolve: (() => void) | undefined
    const ready = new Promise<void>((resolve) => {
      readyResolve = resolve
    })
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectPending = reject
    })
    // Install the rejection observer before loading; startup failures must not become unhandled rejections.
    void aborted.catch(() => {})
    ipcMain.handle('exams:print-state', onState)
    window.on('closed', fail)
    window.webContents.on('render-process-gone', fail)
    window.webContents.on('preload-error', fail)
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        fail()
        reject(new Error('PDF export timed out'))
      }, 120_000)
    })
    try {
      return await Promise.race([
        deadline,
        aborted,
        (async () => {
          await window.loadURL(pageUrl)
          await ready
          return window.webContents.printToPDF({
            pageSize: 'A4',
            landscape: false,
            printBackground: true,
            preferCSSPageSize: true,
            displayHeaderFooter: true,
            headerTemplate: '<span></span>',
            footerTemplate:
              '<div style="width:100%;text-align:center;font-size:9px;color:#666"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
            margins: { top: 0.65, bottom: 0.7, left: 0.65, right: 0.65 },
          })
        })(),
      ])
    } finally {
      if (timer) clearTimeout(timer)
      this.cancel = undefined
      ipcMain.removeHandler('exams:print-state')
      window.removeListener('closed', fail)
      if (!window.isDestroyed()) window.destroy()
      isolated.webRequest.onBeforeRequest(null)
      await isolated.closeAllConnections()
    }
  }
}
