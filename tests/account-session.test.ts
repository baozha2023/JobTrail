import { afterEach, expect, it, vi } from 'vitest'
import type { Session } from 'electron'
import {
  AccountSessions,
  accountTransport,
  accountLoginTransport,
  checkAccountSession,
} from '../src/main/discovery/account-session'
import { platformAdapter } from '../src/main/discovery/adapter-registry'
import { SourceError } from '../src/main/discovery/adapter'
import type { PageSnapshot } from '../src/main/discovery/extraction'
import { platforms } from '../src/shared/job-discovery'

const native = vi.hoisted(() => ({ fromPath: vi.fn() }))
vi.mock('electron', () => ({ session: native }))
afterEach(() => {
  vi.restoreAllMocks()
  native.fromPath.mockReset()
})
function fixture() {
  const fetch = vi.fn(async () => new Response('{}'))
  const cookies = {
    get: vi.fn(async () => [{ value: 'test-token' }]),
    set: vi.fn(async () => {}),
    flushStore: vi.fn(async () => {}),
  }
  const session = { fetch, cookies } as unknown as Session
  const controller = new AbortController()
  const page = vi.fn(
    async (url: string, _script: string): Promise<PageSnapshot> => ({
      url,
      authenticated: true,
      login: false,
      challenge: false,
      offline: false,
      detail: {},
    }),
  )
  const transport = accountTransport('boss', session, controller.signal, page)
  const callbacks = { scanned: vi.fn(), challenge: vi.fn() }
  const login = accountLoginTransport('boss', session, controller.signal, callbacks)
  return { fetch, cookies, session, controller, page, transport, login, callbacks }
}

it.each(platforms)(
  'checks %s using the shared account boundary and its own adapter',
  async (platform) => {
    const f = fixture()
    f.fetch.mockImplementation(
      async () =>
        new Response(
          JSON.stringify(
            platform === 'iguopin'
              ? { code: 200, data: { id: 'personal-account', user_type: 'personal' } }
              : { code: 100, msg: { uuid: 'personal-account' } },
          ),
        ),
    )
    expect(await checkAccountSession(platform, f.session, f.controller.signal, f.page)).toBe(
      'authenticated',
    )
    if (platform === 'iguopin' || platform === 'shixiseng') {
      expect(f.fetch).toHaveBeenCalledOnce()
      expect(f.page).not.toHaveBeenCalled()
    } else {
      const adapter = platformAdapter(platform)
      expect(f.page).toHaveBeenCalledExactlyOnceWith(
        adapter.accountCheckUrl,
        adapter.pageScript(false),
      )
      expect(f.fetch).not.toHaveBeenCalled()
    }
  },
)

it.each(['boss', 'liepin', 'zhilian', 'wuyou'] as const)(
  'requires positive page evidence for %s and prioritizes challenges',
  async (platform) => {
    const f = fixture()
    const snapshot = await f.page(platformAdapter(platform).accountCheckUrl, '')
    for (const [change, expected] of [
      [{ authenticated: false }, 'unknown'],
      [{ authenticated: false, login: true }, 'login_required'],
      [{ authenticated: true, challenge: true }, 'challenge'],
    ] as const) {
      f.page.mockResolvedValue({ ...snapshot, ...change })
      expect(await checkAccountSession(platform, f.session, f.controller.signal, f.page)).toBe(
        expected,
      )
    }
  },
)

it.each([
  ['http://www.zhipin.com/'],
  ['https://www.liepin.com/'],
  ['https://www.zhipin.com.evil.test/'],
])('rejects out-of-scope account and QR requests before I/O: %s', async (url) => {
  const f = fixture()
  await expect(f.transport.json(url, (v) => v)).rejects.toMatchObject({ state: 'parse_error' })
  await expect(f.transport.cookie(url, 'token')).rejects.toMatchObject({ state: 'parse_error' })
  await expect(f.transport.page(url, '')).rejects.toMatchObject({ state: 'parse_error' })
  await expect(f.login.text(url)).rejects.toMatchObject({ reason: 'protocol' })
  expect(f.fetch).not.toHaveBeenCalled()
  expect(f.cookies.get).not.toHaveBeenCalled()
  expect(f.page).not.toHaveBeenCalled()
})

it('validates the final account page address and QR cookie domain', async () => {
  const f = fixture()
  f.page.mockResolvedValue({ ...(await f.page('https://www.liepin.com/', '')) })
  await expect(f.transport.page('https://www.zhipin.com/', '')).rejects.toMatchObject({
    state: 'parse_error',
  })
  await expect(
    f.login.setCookie({
      url: 'https://www.zhipin.com/',
      name: 'test',
      value: 'value',
      domain: '.liepin.com',
    }),
  ).rejects.toMatchObject({ reason: 'protocol' })
  expect(f.cookies.set).not.toHaveBeenCalled()
})

it.each([
  [401, 'login_required'],
  [403, 'challenge'],
  [429, 'challenge'],
] as const)('classifies HTTP %s without parsing it as account data', async (status, expected) => {
  const f = fixture()
  f.fetch.mockImplementation(async () => new Response('{}', { status }))
  expect(await checkAccountSession('iguopin', f.session, f.controller.signal, f.page)).toBe(
    expected,
  )
  await expect(f.login.text('https://www.zhipin.com/')).rejects.toMatchObject({
    reason: 'verification',
  })
})

it('keeps network and malformed responses distinct from expired sessions', async () => {
  const f = fixture()
  f.fetch.mockImplementationOnce(async () => new Response('{}', { status: 503 }))
  await expect(
    checkAccountSession('iguopin', f.session, f.controller.signal, f.page),
  ).rejects.toMatchObject({ state: 'network_error' })
  f.fetch.mockImplementationOnce(async () => new Response('not-json'))
  await expect(
    checkAccountSession('iguopin', f.session, f.controller.signal, f.page),
  ).rejects.toMatchObject({ state: 'parse_error' })
})

it('shares response-size limits across account JSON and QR image downloads', async () => {
  const f = fixture()
  f.fetch.mockImplementation(
    async () =>
      new Response(new Uint8Array(2_000_001), { headers: { 'content-type': 'image/png' } }),
  )
  await expect(f.transport.json('https://www.zhipin.com/', (v) => v)).rejects.toMatchObject({
    state: 'parse_error',
  })
  await expect(f.login.image('https://www.zhipin.com/qr.png')).rejects.toMatchObject({
    reason: 'protocol',
  })
})

it('times out stalled response bodies and releases the reader', async () => {
  const f = fixture(),
    cancel = vi.fn()
  f.fetch.mockImplementationOnce(async () => new Response(new ReadableStream({ cancel })))
  await expect(
    f.transport.json('https://www.zhipin.com/', (v) => v, { timeoutMs: 20 }),
  ).rejects.toMatchObject({ name: 'TimeoutError' })
  expect(cancel).toHaveBeenCalledOnce()
})

it('cancels a pending login request, releases late bodies and prevents later cookie writes', async () => {
  const f = fixture(),
    cancel = vi.fn()
  let finish!: (response: Response) => void
  f.fetch.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const pending = f.login.text('https://www.zhipin.com/')
  const rejected = expect(pending).rejects.toMatchObject({ reason: 'network' })
  f.controller.abort(new SourceError('cancelled'))
  await rejected
  finish(new Response(new ReadableStream({ cancel })))
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce())
  await expect(
    f.login.setCookie({ url: 'https://www.zhipin.com/', name: 'test', value: 'value' }),
  ).rejects.toBeDefined()
  expect(f.cookies.set).not.toHaveBeenCalled()
})

function storedSession() {
  return {
    getUserAgent: () => 'Mozilla/5.0 JobTrail/1.0 Chrome/150 Electron/43',
    setUserAgent: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    on: vi.fn(),
    webRequest: { onBeforeRequest: vi.fn() },
    clearData: vi.fn(async () => {}),
    clearCache: vi.fn(async () => {}),
    flushStorageData: vi.fn(),
    cookies: { flushStore: vi.fn(async () => {}) },
    setProxy: vi.fn(async (_config: Electron.ProxyConfig) => {}),
    closeAllConnections: vi.fn(async () => {}),
  }
}

it('creates, reuses, clears and flushes isolated sessions only through their owner', async () => {
  native.fromPath.mockImplementation(storedSession)
  const sessions = new AccountSessions('test-profile')
  const first = await sessions.get('boss'),
    second = await sessions.get('liepin')
  expect(await sessions.get('boss')).toBe(first)
  expect(first).not.toBe(second)
  expect(native.fromPath).toHaveBeenCalledTimes(2)
  expect(first.setUserAgent).toHaveBeenCalledWith('Mozilla/5.0 Chrome/150 Electron/43')
  await sessions.clear('boss')
  expect(first.clearData).toHaveBeenCalledOnce()
  expect(first.clearCache).toHaveBeenCalledOnce()
  expect(second.clearData).not.toHaveBeenCalled()
  await sessions.flush()
  expect(first.cookies.flushStore).toHaveBeenCalledOnce()
  expect(second.cookies.flushStore).toHaveBeenCalledOnce()
  await sessions.closeConnections()
  expect(first.closeAllConnections).toHaveBeenCalledTimes(2)
  expect(second.closeAllConnections).toHaveBeenCalledTimes(2)
  expect(await sessions.get('boss')).toBe(first)
  expect(first.setProxy).toHaveBeenCalledExactlyOnceWith({ mode: 'system' })
  expect(second.setProxy).toHaveBeenCalledExactlyOnceWith({ mode: 'system' })
})

it.each(platforms)(
  'waits for system networking and old connections to close before exposing %s',
  async (platform) => {
    const value = storedSession()
    let configured!: () => void
    let disconnected!: () => void
    value.setProxy.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          configured = resolve
        }),
    )
    value.closeAllConnections.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          disconnected = resolve
        }),
    )
    native.fromPath.mockReturnValue(value)
    const sessions = new AccountSessions('test-profile')
    const ready = sessions.get(platform)
    expect(sessions.get(platform)).toBe(ready)
    expect(value.setProxy).toHaveBeenCalledExactlyOnceWith({ mode: 'system' })
    expect(value.closeAllConnections).not.toHaveBeenCalled()
    const exposed = vi.fn()
    void ready.then(exposed)
    configured()
    await vi.waitFor(() => expect(value.closeAllConnections).toHaveBeenCalledOnce())
    expect(exposed).not.toHaveBeenCalled()
    disconnected()
    expect(await ready).toBe(value)
    expect(native.fromPath).toHaveBeenCalledOnce()
  },
)

it.each(['setProxy', 'closeAllConnections'] as const)(
  'retries failed session initialization without replacing system networking: %s',
  async (operation) => {
    const value = storedSession()
    value[operation].mockRejectedValueOnce(new Error('system network unavailable'))
    native.fromPath.mockReturnValue(value)
    const sessions = new AccountSessions('test-profile')
    await expect(sessions.get('boss')).rejects.toThrow('system network unavailable')
    expect(await sessions.get('boss')).toBe(value)
    expect(value.setProxy.mock.calls).toEqual([[{ mode: 'system' }], [{ mode: 'system' }]])
    expect(value.clearData).not.toHaveBeenCalled()
    expect(value.clearCache).not.toHaveBeenCalled()
  },
)
