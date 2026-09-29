// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { VelopackApi } from '../src/shared/types'

const mocks = vi.hoisted(() => ({
  apis: new Map<string, unknown>(),
  invoke: vi.fn(),
  send: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (name: string, api: unknown) => mocks.apis.set(name, api) },
  ipcRenderer: mocks,
}))
import '../src/preload/index'

beforeEach(() => {
  mocks.invoke.mockReset()
  mocks.send.mockClear()
})

describe('preload diagnostic transport', () => {
  it('sends a bounded report for a broken native IPC call', async () => {
    mocks.invoke.mockRejectedValue(new Error('Bearer secret, Http error: http status: 403'))
    const api = mocks.apis.get('velopackApi') as VelopackApi
    await expect(api.checkForUpdates()).rejects.toThrow()
    expect(mocks.send).toHaveBeenCalledWith('diagnostics:report', {
      source: 'preload',
      operation: 'ipc-transport',
      code: 'INTERNAL_ERROR',
      httpStatus: 403,
    })
    expect(JSON.stringify(mocks.send.mock.calls)).not.toContain('secret')
  })

  it('does not duplicate a Main IPC error response', async () => {
    mocks.invoke.mockResolvedValue({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: '界面错误' },
    })
    const api = mocks.apis.get('velopackApi') as VelopackApi
    await expect(api.checkForUpdates()).rejects.toThrow('界面错误')
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('reports only errors originating in the preload bundle', () => {
    const preloadError = new Error('secret')
    preloadError.stack = 'Error: secret\n at f (C:/JobTrail/out/preload/index.js:12:3)'
    window.dispatchEvent(new ErrorEvent('error', { error: preloadError }))
    expect(mocks.send).toHaveBeenCalledWith('diagnostics:report', {
      source: 'preload',
      operation: 'process.uncaught',
      code: 'INTERNAL_ERROR',
      stack: ['out/preload/index.js:12:3'],
    })
    mocks.send.mockClear()
    const rendererError = new Error('secret')
    rendererError.stack = 'Error: secret\n at f (C:/JobTrail/out/renderer/assets/index.js:12:3)'
    window.dispatchEvent(new ErrorEvent('error', { error: rendererError }))
    expect(mocks.send).not.toHaveBeenCalled()
  })
})
