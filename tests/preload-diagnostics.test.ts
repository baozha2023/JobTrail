// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createErrorInput } from '../src/shared/diagnostics'
import type { VelopackApi, ZhijiApi } from '../src/shared/types'

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
    mocks.invoke.mockImplementation(async (channel, input) => {
      if (channel === 'diagnostics:report') return { eventId: input.eventId, status: 'written' }
      throw new Error('Bearer secret, Http error: http status: 403')
    })
    const api = mocks.apis.get('velopackApi') as VelopackApi
    await expect(api.checkForUpdates()).rejects.toMatchObject({
      name: 'IpcClientError',
      code: 'INTERNAL_ERROR',
      diagnostic: expect.any(Object),
    })
    expect(mocks.invoke).toHaveBeenCalledWith(
      'diagnostics:report',
      expect.objectContaining({
        source: 'preload',
        operation: 'ipc.transport',
        error: expect.objectContaining({ httpStatus: 403 }),
      }),
    )
    expect(JSON.stringify(mocks.invoke.mock.calls)).not.toContain('secret')
  })

  it('does not duplicate a Main IPC error response', async () => {
    mocks.invoke.mockResolvedValue({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: '界面错误' },
    })
    const api = mocks.apis.get('velopackApi') as VelopackApi
    await expect(api.checkForUpdates()).rejects.toEqual({
      name: 'IpcClientError',
      code: 'INTERNAL_ERROR',
      message: '界面错误',
    })
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('reports only errors originating in the preload bundle', async () => {
    mocks.invoke.mockImplementation(async (_channel, input) => ({
      eventId: input.eventId,
      status: 'written',
    }))
    const preloadError = new Error('preload failed')
    preloadError.stack = 'Error: failed\n at f (C:/JobTrail/out/preload/index.js:12:3)'
    window.dispatchEvent(new ErrorEvent('error', { error: preloadError }))
    expect(mocks.invoke).toHaveBeenCalledWith(
      'diagnostics:report',
      expect.objectContaining({
        source: 'preload',
        operation: 'process.uncaught',
        error: expect.objectContaining({ stack: ['at f (out/preload/index.js:12:3)'] }),
      }),
    )
    await Promise.resolve()
    mocks.invoke.mockClear()
    const rendererError = new Error('renderer failed')
    rendererError.stack = 'Error: failed\n at f (C:/JobTrail/out/renderer/assets/index.js:12:3)'
    window.dispatchEvent(new ErrorEvent('error', { error: rendererError }))
    expect(mocks.invoke).not.toHaveBeenCalled()
  })
})

it('retries a diagnostic once with the same event ID and exposes transport degradation', async () => {
  const report = mocks.apis.get('diagnosticsApi') as Window['diagnosticsApi']
  const input = createErrorInput('renderer', 'ui.failure', new Error('password=secret'))
  mocks.invoke.mockRejectedValue(new Error('transport down'))
  const fallback = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    expect(await report!.report(input)).toEqual({ eventId: input.eventId, status: 'fallback' })
    expect(mocks.invoke).toHaveBeenCalledTimes(2)
    expect(mocks.invoke.mock.calls[0][1].eventId).toBe(mocks.invoke.mock.calls[1][1].eventId)
    expect(fallback).toHaveBeenCalledOnce()
    expect(JSON.stringify(fallback.mock.calls)).not.toContain('secret')
    mocks.invoke.mockResolvedValue({ ok: true, data: { degraded: false, transportFailures: 0 } })
    const api = mocks.apis.get('zhijiApi') as ZhijiApi
    expect(await api.diagnostics.getStatus()).toMatchObject({
      degraded: true,
      transportFailures: 1,
    })
  } finally {
    fallback.mockRestore()
  }
})
