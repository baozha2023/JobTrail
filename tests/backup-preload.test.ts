// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import type { ZhijiApi } from '../src/shared/types'

const mocks = vi.hoisted(() => ({
  apis: new Map<string, unknown>(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (name: string, api: unknown) => mocks.apis.set(name, api) },
  ipcRenderer: mocks,
}))
import '../src/preload/index'

describe('backup preload bridge', () => {
  it('passes verified metadata and submits a decision with only its request ID and boolean', async () => {
    const api = mocks.apis.get('zhijiApi') as ZhijiApi
    const listener = vi.fn()
    const remove = api.backup.onImportConfirmation(listener)
    const registration = mocks.on.mock.calls.find(
      ([channel]) => channel === 'backup:import-confirmation',
    )!
    const confirmation = {
      requestId: 'request-id',
      appVersion: '1.2.0',
      createdAt: '2026-09-30T16:28:15.062Z',
    }
    registration[1]({}, confirmation)
    expect(listener).toHaveBeenCalledWith(confirmation)
    mocks.invoke.mockResolvedValue({ ok: true, data: undefined })
    await api.backup.confirmImport(confirmation.requestId, false)
    expect(mocks.invoke).toHaveBeenCalledWith('backup:confirm-import', {
      context: { traceId: expect.any(String), spanId: expect.any(String) },
      args: ['request-id', false],
    })
    remove()
    expect(mocks.removeListener).toHaveBeenCalledWith('backup:import-confirmation', registration[1])
  })
})
