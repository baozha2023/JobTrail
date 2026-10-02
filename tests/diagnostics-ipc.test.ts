import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, WebContents } from 'electron'
const ipc = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: ipc }))
import { initializeDiagnostics, closeDiagnostics, flushDiagnostics } from '../src/main/diagnostics'
import { createErrorInput, newDiagnosticContext } from '../src/shared/diagnostics'
import {
  registerChannel,
  registerDiagnosticIpc,
  trustWindow,
} from '../src/main/ipc/register-channel'
import { diagnosticRecords } from './helpers/diagnostics'
const roots: string[] = []
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrail-ipc-log-'))
  roots.push(root)
  initializeDiagnostics('main', '1.3.0', true, root)
  const frame = {}
  const contents = { mainFrame: frame, getOSProcessId: () => 4242 } as WebContents
  trustWindow({ webContents: contents } as BrowserWindow)
  return { root, event: { sender: contents, senderFrame: frame } }
}
afterEach(() => {
  closeDiagnostics()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  ipc.handle.mockClear()
})
describe('diagnostic IPC', () => {
  it('preserves a trace and diagnostic reference while returning a safe localized error', async () => {
    const { root, event } = setup()
    registerChannel('system:is-development', () => {
      throw new Error('HTTP status: 403 token=hidden')
    })
    const invoke = ipc.handle.mock.calls.at(-1)![1]
    const context = newDiagnosticContext()
    const result = await invoke(event, { context, args: [] })
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'INTERNAL_ERROR', diagnostic: { traceId: context.traceId } },
    })
    expect(JSON.stringify(result)).not.toContain('hidden')
    expect(
      diagnosticRecords(root).find((record) => record.eventId === result.error.diagnostic.eventId),
    ).toMatchObject({ error: { httpStatus: 403 }, operation: 'ipc.system.is-development' })
  })
  it('acknowledges reports, rejects forged sources and deduplicates retries', () => {
    const { root, event } = setup()
    registerDiagnosticIpc()
    const report = ipc.handle.mock.calls.at(-1)![1]
    const input = createErrorInput('renderer', 'vue.component', new Error('broken component'))
    expect(report({ sender: {} }, input).status).toBe('unavailable')
    expect(report(event, { ...input, source: 'main' }).status).toBe('unavailable')
    expect(report(event, input).status).toBe('written')
    expect(report(event, input).status).toBe('duplicate')
    flushDiagnostics()
    expect(diagnosticRecords(root).filter((record) => record.eventId === input.eventId)).toEqual([
      expect.objectContaining({ process: 'renderer', pid: 4242 }),
    ])
  })
})
