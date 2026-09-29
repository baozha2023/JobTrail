import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, WebContents } from 'electron'

const ipc = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn(), on: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: ipc }))

import { initializeFaultLogger } from '../src/main/diagnostics'
import {
  registerChannel,
  registerDiagnosticIpc,
  trustWindow,
} from '../src/main/ipc/register-channel'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true })
  ipc.handle.mockClear()
  ipc.on.mockClear()
})

describe('diagnostic IPC boundary', () => {
  it('records an IPC 403 before converting it to a safe response', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrail-ipc-log-'))
    directories.push(directory)
    initializeFaultLogger('main', '1.1.0', true, directory)
    const frame = {}
    const contents = { mainFrame: frame, getOSProcessId: () => 4242 } as WebContents
    trustWindow({ webContents: contents } as BrowserWindow)
    registerChannel('velopack:check-for-update', () => {
      throw new Error('private token, Http error: http status: 403')
    })
    const invoke = ipc.handle.mock.calls.at(-1)![1] as (event: object) => Promise<unknown>
    expect(await invoke({ sender: contents, senderFrame: frame })).toEqual({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: '内部操作失败' },
    })
    const log = fs.readFileSync(path.join(directory, 'logs', 'app.jsonl'), 'utf8')
    expect(JSON.parse(log)).toMatchObject({ operation: 'update.check', httpStatus: 403 })
    expect(log).not.toContain('private token')
  })

  it('accepts only bounded fault reports from the trusted main frame', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrail-ipc-log-'))
    directories.push(directory)
    initializeFaultLogger('main', '1.1.0', true, directory)
    const frame = {}
    const contents = { mainFrame: frame, getOSProcessId: () => 4242 } as WebContents
    trustWindow({ webContents: contents } as BrowserWindow)
    registerDiagnosticIpc()
    const listener = ipc.on.mock.calls.at(-1)![1] as (event: object, payload: unknown) => void
    listener(
      { sender: contents, senderFrame: frame },
      {
        source: 'renderer',
        operation: 'vue.component',
        code: 'INTERNAL_ERROR',
        message: 'secret',
      },
    )
    listener(
      { sender: {} },
      { source: 'renderer', operation: 'vue.component', code: 'INTERNAL_ERROR' },
    )
    expect(fs.existsSync(path.join(directory, 'logs', 'app.jsonl'))).toBe(false)
    listener(
      { sender: contents, senderFrame: frame },
      {
        source: 'renderer',
        operation: 'vue.component',
        code: 'INTERNAL_ERROR',
      },
    )
    expect(
      JSON.parse(fs.readFileSync(path.join(directory, 'logs', 'app.jsonl'), 'utf8')),
    ).toMatchObject({
      process: 'renderer',
      pid: 4242,
      operation: 'vue.component',
      code: 'INTERNAL_ERROR',
    })
  })
})
