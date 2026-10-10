// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
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

it('forwards only webpage loading data and removes the exact event listener on cleanup', async () => {
  const api = mocks.apis.get('zhijiApi') as ZhijiApi
  const listener = vi.fn()
  const remove = api.discovery.onBrowserLoading(listener)
  const [channel, handler] = mocks.on.mock.calls.at(-1)!
  expect(channel).toBe('discovery:browser-loading')
  const state = { requestId: crypto.randomUUID(), loading: true }
  handler({ sender: 'native IPC object' }, state)
  expect(listener).toHaveBeenCalledExactlyOnceWith(state)
  mocks.invoke.mockResolvedValue({ ok: true, data: undefined })
  const input = { action: 'open' as const, jobId: 'test-job', requestId: state.requestId }
  await api.discovery.browser(input)
  expect(mocks.invoke).toHaveBeenCalledWith(
    'discovery:browser',
    expect.objectContaining({ args: [input] }),
  )
  remove()
  expect(mocks.removeListener).toHaveBeenCalledWith(channel, handler)
})
