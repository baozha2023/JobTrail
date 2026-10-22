import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { EventEmitter } from 'node:events'
import type { BrowserWindowConstructorOptions, IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { newDiagnosticContext } from '../src/shared/diagnostics'
import type { ExamPrintDocument } from '../src/shared/exams'
import type { ExamService } from '../src/main/services/exam-service'

type Handler = (event: Partial<IpcMainInvokeEvent>, envelope: unknown) => Promise<{ ok: boolean }>
type WindowMock = EventEmitter & {
  options: BrowserWindowConstructorOptions
  webContents: EventEmitter & {
    mainFrame: object
    send: ReturnType<typeof vi.fn>
    printToPDF: ReturnType<typeof vi.fn>
  }
  isDestroyed(): boolean
}
const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  handle: vi.fn(),
  removeHandler: vi.fn(),
  appOn: vi.fn(),
  handlers: new Map<string, Handler>(),
  windows: [] as WindowMock[],
  behavior: 'normal',
  context: {} as ReturnType<typeof newDiagnosticContext>,
  beforeRequest: vi.fn(),
  closeConnections: vi.fn(),
}))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    app: {
      on: mocks.appOn,
      isPackaged: true,
      getAppPath: () => process.cwd(),
      getPath: () => os.tmpdir(),
    },
    dialog: { showSaveDialog: mocks.save },
    ipcMain: {
      handle: (name: string, handler: Handler) => {
        mocks.handle(name, handler)
        mocks.handlers.set(name, handler)
      },
      removeHandler: (name: string) => {
        mocks.removeHandler(name)
        mocks.handlers.delete(name)
      },
    },
    session: {
      fromPartition: () => ({
        webRequest: { onBeforeRequest: mocks.beforeRequest },
        setPermissionRequestHandler: vi.fn(),
        setPermissionCheckHandler: vi.fn(),
        closeAllConnections: mocks.closeConnections,
      }),
    },
    BrowserWindow: class extends EventEmitter {
      destroyed = false
      webContents = Object.assign(new EventEmitter(), {
        mainFrame: {},
        send: vi.fn(),
        setWindowOpenHandler: vi.fn(),
        printToPDF: vi.fn().mockResolvedValue(Buffer.from('%PDF-test')),
      })
      constructor(public options: BrowserWindowConstructorOptions) {
        super()
        if (mocks.behavior === 'constructor-failure') throw new Error('Window creation failed')
        mocks.windows.push(this)
      }
      async loadURL() {
        if (mocks.behavior === 'stall') return
        const handler = mocks.handlers.get('exams:print-state')!
        const jobId = this.options.webPreferences!.additionalArguments![0].split('=')[1]
        const event = {
          sender: this.webContents,
          senderFrame: this.webContents.mainFrame,
        } as unknown as IpcMainInvokeEvent
        const report = (phase: string, overrides = {}) =>
          handler(event, { context: mocks.context, args: [{ jobId, phase, ...overrides }] })
        expect(
          await handler({ ...event, sender: {} } as IpcMainInvokeEvent, {
            context: mocks.context,
            args: [{ jobId, phase: 'ready' }],
          }),
        ).toMatchObject({ ok: false })
        expect(
          await handler({ ...event, senderFrame: {} } as IpcMainInvokeEvent, {
            context: mocks.context,
            args: [{ jobId, phase: 'complete' }],
          }),
        ).toMatchObject({ ok: false })
        expect(await report('ready', { jobId: randomUUID() })).toMatchObject({ ok: false })
        expect(await report('ready', { unknown: true })).toMatchObject({ ok: false })
        expect(await report('complete')).toMatchObject({ ok: false })
        expect(await report('ready')).toMatchObject({ ok: true })
        if (mocks.behavior === 'crash') this.webContents.emit('render-process-gone')
        else expect(await report('complete')).toMatchObject({ ok: true })
      }
      isDestroyed() {
        return this.destroyed
      }
      destroy() {
        this.destroyed = true
        this.emit('closed')
      }
    },
  }
})
import { ExamPdfExporter } from '../src/main/exam-pdf-exporter'
const roots: string[] = []
beforeEach(() => {
  vi.clearAllMocks()
  mocks.handlers.clear()
  mocks.windows.length = 0
  mocks.behavior = 'normal'
  mocks.context = newDiagnosticContext()
  mocks.closeConnections.mockResolvedValue(undefined)
})
afterEach(async () => {
  vi.useRealTimers()
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})
async function fixture() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'exam-export-'))
  roots.push(base)
  const root = path.join(base, 'JobTrail')
  await fs.mkdir(root)
  const target = path.join(base, 'exam.pdf')
  mocks.save.mockResolvedValue({ canceled: false, filePath: target })
  const snapshot: Pick<ExamPrintDocument, 'paper' | 'answerPlacement'> = {
    answerPlacement: 'at_end',
    paper: {
      title: 'PDF / exam',
      topic: 'TS',
      difficulty: 'Medium',
      status: 'generating',
      counts: { single_choice: 0, true_false: 0, short_answer: 1 },
      questions: [
        {
          position: 1,
          content: { type: 'short_answer', prompt: 'Prompt' },
          defaultAnswer: 'Internal answer',
        },
      ],
    },
  }
  const service = { exportSnapshot: vi.fn(() => snapshot) }
  const exporter = new ExamPdfExporter(
    service as unknown as ExamService,
    root,
    () => 'en-US',
    () => undefined,
  )
  return { exporter, target, snapshot, service }
}
it('prints through an isolated authorized window and releases its handler and session', async () => {
  const f = await fixture()
  expect(await f.exporter.export({})).toBe('exported')
  expect(await fs.readFile(f.target, 'utf8')).toBe('%PDF-test')
  const window = mocks.windows[0]
  expect(window.options).toMatchObject({
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  })
  expect(window.webContents.send).toHaveBeenCalledWith(
    'exams:print-document',
    expect.objectContaining(f.snapshot),
  )
  expect(window.webContents.printToPDF).toHaveBeenCalledWith(
    expect.objectContaining({ pageSize: 'A4', displayHeaderFooter: true }),
  )
  expect(window.isDestroyed()).toBe(true)
  expect(mocks.handlers.size).toBe(0)
  expect(mocks.closeConnections).toHaveBeenCalledOnce()
  const guard = mocks.beforeRequest.mock.calls[0][0]
  const callback = vi.fn()
  guard({ url: 'https://example.com/track' }, callback)
  expect(callback).toHaveBeenCalledWith({ cancel: true })
})
it('cancels without creating a renderer and recovers from failures', async () => {
  const f = await fixture()
  mocks.save.mockResolvedValueOnce({ canceled: true })
  expect(await f.exporter.export({})).toBe('cancelled')
  expect(mocks.windows).toHaveLength(0)
  mocks.behavior = 'crash'
  await expect(f.exporter.export({})).rejects.toMatchObject({ code: 'EXAM_EXPORT_FAILED' })
  expect(mocks.windows[0].isDestroyed()).toBe(true)
  expect(mocks.handlers.size).toBe(0)
  mocks.behavior = 'normal'
  expect(await f.exporter.export({})).toBe('exported')
})
it('rejects concurrent exports and cleans up stalled renderers on timeout', async () => {
  const f = await fixture()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  mocks.behavior = 'stall'
  const result = f.exporter.export({}).catch((error) => error)
  await vi.waitFor(() => expect(mocks.windows).toHaveLength(1))
  await expect(f.exporter.export({})).rejects.toMatchObject({ code: 'EXAM_EXPORT_BUSY' })
  await vi.advanceTimersByTimeAsync(120000)
  expect(await result).toMatchObject({ code: 'EXAM_EXPORT_FAILED' })
  expect(mocks.windows[0].isDestroyed()).toBe(true)
  expect(mocks.handlers.size).toBe(0)
})
it('drains a cancelled renderer during application shutdown', async () => {
  const f = await fixture()
  mocks.behavior = 'stall'
  const result = f.exporter.export({})
  await vi.waitFor(() => expect(mocks.windows).toHaveLength(1))
  await f.exporter.close()
  expect(await result).toBe('cancelled')
  expect(mocks.windows[0].isDestroyed()).toBe(true)
  expect(mocks.handlers.size).toBe(0)
  expect(await f.exporter.export({})).toBe('cancelled')
})
it('releases session resources if creating the printing window fails', async () => {
  const f = await fixture()
  mocks.behavior = 'constructor-failure'
  await expect(f.exporter.export({})).rejects.toMatchObject({ code: 'EXAM_EXPORT_FAILED' })
  expect(mocks.closeConnections).toHaveBeenCalledOnce()
  expect(mocks.handlers.size).toBe(0)
})
