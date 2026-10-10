import { afterEach, expect, it, vi } from 'vitest'
import type { Session } from 'electron'
import { QrLoginManager } from '../src/main/discovery/qr-login'
import type { QrVerificationHost } from '../src/main/discovery/qr-verification'
import { captureError } from '../src/main/diagnostics'
import { platformAdapter } from '../src/main/discovery/adapter-registry'

vi.mock('../src/main/diagnostics', async (original) => ({
  ...(await original<typeof import('../src/main/diagnostics')>()),
  captureError: vi.fn(),
}))

const png = 'data:image/png;base64,aGVsbG8='
const managers: QrLoginManager[] = []
const sxsQr = { code: 100, msg: 'iVBORw0KGgo=' }
function fixture(values: unknown[], verification?: QrVerificationHost) {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => {
    const next = values.shift()
    if (next instanceof Error) throw next
    if (next instanceof Response) return next
    return new Response(typeof next === 'string' ? next : JSON.stringify(next), {
      headers: { 'content-type': 'application/json' },
    })
  })
  const set = vi.fn().mockResolvedValue(undefined),
    flushStore = vi.fn().mockResolvedValue(undefined),
    authenticated = vi.fn()
  const session = { fetch, cookies: { set, flushStore } } as unknown as Session
  const manager = new QrLoginManager(async () => session, authenticated, undefined, verification)
  managers.push(manager)
  return { manager, fetch, set, flushStore, authenticated, session }
}
afterEach(async () => {
  for (const m of managers.splice(0)) await m.stop()
  vi.useRealTimers()
})
it('requires Shixiseng scan confirmation, account identity and completed official binding', async () => {
  vi.useFakeTimers()
  const f = fixture([
    sxsQr,
    { code: 500, msg: { isScan: true } },
    { code: 100, msg: { isLogin: true } },
    { code: 100, msg: { uuid: 'user_test' } },
    { code: 100, msg: { is_complete: false } },
    { code: 100, msg: { uuid: 'user_test' } },
    { code: 100, msg: { is_complete: true } },
  ])
  const platformFetch = f.fetch.getMockImplementation()!
  f.fetch.mockImplementation((url, init) => {
    // The live gateway fails requests containing this non-website header.
    if (new Headers(init.headers).has('X-Requested-With'))
      return Promise.reject(new Error('net::ERR_FAILED'))
    return platformFetch(url, init)
  })
  expect(await f.manager.start('shixiseng')).toMatchObject({
    state: 'waiting',
    method: 'wechat',
    methods: [{ id: 'wechat' }],
  })
  const scene = new URL(f.fetch.mock.calls[0][0]).searchParams.get('scene')
  expect(scene).toMatch(/^[0-9a-f]{7}4[0-9a-f]{2}[89ab][0-9a-f]{5}$/)
  await vi.advanceTimersByTimeAsync(2000)
  expect(new URL(f.fetch.mock.calls[1][0]).searchParams.get('scene')).toBe(scene)
  expect(f.manager.get('shixiseng')?.state).toBe('scanned')
  await vi.advanceTimersByTimeAsync(2000)
  expect(f.authenticated).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(2000)
  expect(f.authenticated).toHaveBeenCalledExactlyOnceWith('shixiseng')
  expect(f.manager.get('shixiseng')?.image).toBeNull()
  expect(JSON.stringify(f.manager.get('shixiseng'))).not.toContain('user_test')
  expect(f.fetch.mock.calls.filter(([url]) => url.includes('/polling'))).toHaveLength(2)
  for (const [url, init] of f.fetch.mock.calls) {
    const headers = new Headers(init.headers)
    expect(headers.has('X-Requested-With')).toBe(false)
    expect(headers.get('Origin')).toBe('https://www.shixiseng.com')
    expect(headers.get('Referer')).toBe('https://www.shixiseng.com/')
    if (url.includes('/polling')) {
      expect(init.method).toBe('POST')
      expect(headers.get('Content-Type')).toBe('application/x-www-form-urlencoded')
    }
  }
  expect(f.set).not.toHaveBeenCalled()
})
it('does not inject website headers when the adapter declares none', async () => {
  const headers = vi.spyOn(platformAdapter('liepin').qr, 'headers')
  try {
    await headers.withImplementation(
      () => ({}),
      async () => {
        const f = fixture([{ flag: 1, data: { key: 'private-key', qrcode: png } }])
        expect((await f.manager.start('liepin')).state).toBe('waiting')
        const actual = new Headers(f.fetch.mock.calls[0][1].headers)
        expect(Object.fromEntries(actual)).toEqual({
          'content-type': 'application/x-www-form-urlencoded',
        })
      },
    )
  } finally {
    headers.mockRestore()
  }
  const f = fixture([{ flag: 1, data: { key: 'private-key', qrcode: png } }])
  expect((await f.manager.start('liepin')).state).toBe('waiting')
  expect(new Headers(f.fetch.mock.calls[0][1].headers).get('X-Requested-With')).toBe(
    'XMLHttpRequest',
  )
})
it.each([
  {
    platform: 'boss' as const,
    responses: [
      { code: 0, zpData: { shortRandKey: 'private-key' } },
      { code: 0, zpData: { mpCodeUrl: png } },
      { scaned: false },
    ],
  },
  {
    platform: 'liepin' as const,
    responses: [
      { flag: 1, data: { key: 'private-key', qrcode: png } },
      { flag: 1, data: { status: '10001' } },
    ],
  },
  {
    platform: 'zhilian' as const,
    responses: [{ code: 100000, data: { validateId: 'private-id', path: png } }, { code: 102004 }],
  },
  {
    platform: 'wuyou' as const,
    responses: [
      "var trackConfig = {'guid': 'private-guid'};",
      `callback({status:'1',result:'${png}'})`,
      { result: '0' },
    ],
  },
  {
    platform: 'iguopin' as const,
    responses: [
      { code: 200, data: { qcode: 'private-key' } },
      { code: 200, data: { is_scan: false } },
    ],
  },
])(
  'preserves $platform adapter headers during QR creation and polling',
  async ({ platform, responses }) => {
    vi.useFakeTimers()
    const f = fixture(responses)
    expect((await f.manager.start(platform)).state).toBe('waiting')
    const initialCalls = f.fetch.mock.calls.length
    await vi.advanceTimersByTimeAsync(2000)
    expect(f.fetch.mock.calls.length).toBeGreaterThan(initialCalls)
    expect(f.manager.get(platform)?.state).toBe('waiting')
    for (const [, init] of f.fetch.mock.calls)
      expect(new Headers(init.headers).get('X-Requested-With')).toBe('XMLHttpRequest')
  },
)
it('expires Shixiseng codes, rejects unsupported methods and ignores cancelled responses', async () => {
  vi.useFakeTimers()
  const f = fixture([
    sxsQr,
    ...Array.from({ length: 6 }, () => ({ code: 500, msg: { isScan: false } })),
  ])
  await expect(f.manager.start('shixiseng', 'app')).rejects.toThrow('Unsupported login method')
  await f.manager.start('shixiseng', 'wechat')
  await vi.advanceTimersByTimeAsync(12000)
  expect(f.manager.get('shixiseng')?.state).toBe('expired')
  expect(f.authenticated).not.toHaveBeenCalled()
  const next = fixture([sxsQr])
  await next.manager.start('shixiseng')
  let release!: (value: Response) => void
  next.fetch.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        release = resolve
      }),
  )
  await vi.advanceTimersByTimeAsync(2000)
  const cancelled = next.manager.cancel('shixiseng')
  release(new Response(JSON.stringify({ code: 100, msg: { isLogin: true } })))
  await cancelled
  expect(next.manager.get('shixiseng')?.state).toBe('cancelled')
  expect(next.authenticated).not.toHaveBeenCalled()
})
it('keeps challenge identifiers private and does not authenticate until platform confirmation', async () => {
  vi.useFakeTimers()
  const f = fixture([
    { flag: 1, data: { key: 'private-key', qrcode: png } },
    { flag: 1, data: { status: '10006' } },
    { flag: 1, data: { status: '0' } },
  ])
  const initial = await f.manager.start('liepin')
  expect(initial.state).toBe('waiting')
  expect(JSON.stringify(initial)).not.toContain('private-key')
  await vi.advanceTimersByTimeAsync(2000)
  expect(f.manager.get('liepin')?.state).toBe('scanned')
  expect(f.authenticated).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(2000)
  expect(f.manager.get('liepin')?.image).toBeNull()
  expect(f.authenticated).toHaveBeenCalledExactlyOnceWith('liepin')
})
it('writes Zhaopin login tokens only to the platform cookie store', async () => {
  vi.useFakeTimers()
  const f = fixture([
    { code: 100000, data: { validateId: 'private-id', path: png } },
    { code: 100000, data: { at: 'private-at', rt: 'private-rt', atExpire: 3600, rtExpire: 86400 } },
  ])
  await f.manager.start('zhilian')
  await vi.advanceTimersByTimeAsync(2000)
  expect(f.set).toHaveBeenCalledTimes(2)
  expect(f.set.mock.calls[0][0]).toMatchObject({
    domain: '.zhaopin.com',
    name: 'at',
    value: 'private-at',
    secure: true,
  })
  expect(JSON.stringify(f.manager.get('zhilian'))).not.toContain('private-')
  expect(f.authenticated).toHaveBeenCalledExactlyOnceWith('zhilian')
})
it('does not report Zhaopin success when the token exchange is incomplete', async () => {
  vi.useFakeTimers()
  const f = fixture([
    { code: 100000, data: { validateId: 'id', path: png } },
    { code: 100000, data: { at: 'at' } },
  ])
  await f.manager.start('zhilian')
  await vi.advanceTimersByTimeAsync(2000)
  expect(f.manager.get('zhilian')?.state).toBe('error')
  expect(f.authenticated).not.toHaveBeenCalled()
})
it('uses the BOSS confirmation endpoint after its WeChat scan response', async () => {
  vi.useFakeTimers()
  const f = fixture([
    { code: 0, zpData: { shortRandKey: 'key' } },
    { code: 0, zpData: { mpCodeUrl: png } },
    { scaned: true },
    { code: 0 },
  ])
  await f.manager.start('boss')
  await vi.advanceTimersByTimeAsync(2000)
  expect(f.fetch.mock.calls.length).toBe(4)
  expect(f.manager.get('boss')?.state).toBe('authenticated')
})
it('parses the quoted 51job bootstrap GUID and JSONP without executing scripts', async () => {
  vi.useFakeTimers()
  const f = fixture([
    "var trackConfig = {'guid': 'private-guid'};",
    `callback({status:'1',result:'${png}'})`,
    { result: '0', error_code: 'scanned' },
    { result: '1' },
  ])
  await f.manager.start('wuyou')
  expect(new URL(f.fetch.mock.calls[1][0]).searchParams.get('jsoncallback')).toBe('callback')
  expect(f.fetch.mock.calls.map(([url]) => url).join(' ')).not.toMatch(/职迹|JobTrail|zhiji/i)
  await vi.advanceTimersByTimeAsync(2000)
  expect(f.manager.get('wuyou')?.state).toBe('scanned')
  await vi.advanceTimersByTimeAsync(2000)
  expect(f.authenticated).toHaveBeenCalledExactlyOnceWith('wuyou')
})
it('refresh invalidates the old attempt without allowing stale cancellation to stop the new QR', async () => {
  vi.useFakeTimers()
  const f = fixture([
    { flag: 1, data: { key: 'old', qrcode: png } },
    { flag: 1, data: { key: 'new', qrcode: png } },
    { flag: 1, data: { status: '10001' } },
  ])
  const old = await f.manager.start('liepin'),
    current = await f.manager.start('liepin')
  await f.manager.cancel('liepin', old.attemptId)
  await vi.advanceTimersByTimeAsync(2000)
  expect(f.manager.get('liepin')?.attemptId).toBe(current.attemptId)
  expect(f.manager.get('liepin')?.state).toBe('waiting')
  await f.manager.cancel('liepin', current.attemptId)
  await vi.advanceTimersByTimeAsync(10000)
  expect(f.fetch).toHaveBeenCalledTimes(3)
  expect(f.manager.get('liepin')?.image).toBeNull()
})
it('expires and releases QR data without polling again', async () => {
  vi.useFakeTimers()
  const f = fixture([
    { flag: 1, data: { key: 'id', qrcode: png } },
    { flag: 1, data: { status: '10004' } },
  ])
  await f.manager.start('liepin')
  await vi.advanceTimersByTimeAsync(20000)
  expect(f.fetch).toHaveBeenCalledTimes(2)
  expect(f.manager.get('liepin')?.state).toBe('expired')
})
it('rejects non-platform image URLs before making an external request', async () => {
  const f = fixture([{ flag: 1, data: { key: 'id', qrcode: 'http://127.0.0.1/credentials' } }])
  const result = await f.manager.start('liepin')
  expect(result.reason).toBe('protocol')
  expect(f.fetch).toHaveBeenCalledTimes(1)
})
it('reports network errors in the QR state without exposing response or token details', async () => {
  const error = new Error('request failed?token=private')
  const f = fixture([error])
  const result = await f.manager.start('boss')
  expect(result.state).toBe('error')
  expect(result.reason).toBe('network')
  expect(JSON.stringify(result)).not.toContain('private')
  expect(captureError).toHaveBeenCalledWith(error, {
    operation: 'discovery.boss.qr',
    level: 'warn',
  })
})

const challengeUrl = 'https://safe.liepin.com/intercept/ip/captcha/dispatch?token=private-challenge'
function challenge(url = challengeUrl) {
  return new Response('{"flag":0}', { headers: { 'TD-SecIntercept-Redirect': url } })
}
function verificationHost() {
  return {
    open: vi.fn(async (input: Parameters<QrVerificationHost['open']>[0]) => {
      input.onState({ window: 'ready', error: null })
    }),
    close: vi.fn(),
  }
}
it('keeps the challenge private, pauses polling, and opens verification only on an explicit action', async () => {
  vi.useFakeTimers()
  const host = verificationHost(),
    f = fixture([challenge()], host)
  const state = await f.manager.start('liepin')
  expect(state).toMatchObject({
    state: 'challenge',
    verification: { available: true, window: 'closed' },
  })
  expect(JSON.stringify(state)).not.toMatch(/private-challenge|safe\.liepin/)
  expect(host.open).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(10000)
  expect(f.fetch).toHaveBeenCalledTimes(1)
  await f.manager.verify('liepin', state.attemptId)
  expect(host.open).toHaveBeenCalledWith(
    expect.objectContaining({ url: challengeUrl, session: f.session }),
  )
  expect(f.manager.get('liepin')?.verification.window).toBe('ready')
  expect(f.authenticated).not.toHaveBeenCalled()
  host.open.mock.calls[0][0].onState({ window: 'closed', error: null })
  expect(f.manager.get('liepin')?.state).toBe('challenge')
  expect(f.authenticated).not.toHaveBeenCalled()
})
it('automatically replaces the QR after manual verification closure, retaining the polled attempt', async () => {
  vi.useFakeTimers()
  const host = verificationHost(),
    f = fixture(
      [
        challenge(),
        { flag: 1, data: { key: 'next-key', qrcode: png } },
        { flag: 1, data: { status: '0' } },
      ],
      host,
    )
  const state = await f.manager.start('liepin')
  await f.manager.verify('liepin', state.attemptId)
  await vi.advanceTimersByTimeAsync(600001)
  const input = host.open.mock.calls[0][0]
  input.onState({ window: 'closed', error: null })
  input.onUserClosed()
  input.onUserClosed()
  expect(f.manager.get('liepin', state.attemptId)?.state).toBe('loading')
  await vi.advanceTimersByTimeAsync(0)
  expect(f.manager.get('liepin', state.attemptId)).toMatchObject({
    state: 'waiting',
    method: state.method,
    image: png,
  })
  expect(f.fetch).toHaveBeenCalledTimes(2)
  expect(f.authenticated).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(2000)
  expect(f.authenticated).toHaveBeenCalledExactlyOnceWith('liepin')
})

it('does not restart a replaced login attempt from a late manual-close callback', async () => {
  vi.useFakeTimers()
  const host = verificationHost(),
    f = fixture([challenge(), { flag: 1, data: { key: 'next-key', qrcode: png } }], host)
  const state = await f.manager.start('liepin')
  await f.manager.verify('liepin', state.attemptId)
  const current = await f.manager.start('liepin')
  host.open.mock.calls[0][0].onUserClosed()
  await vi.advanceTimersByTimeAsync(0)
  expect(f.manager.get('liepin')?.attemptId).toBe(current.attemptId)
  expect(f.fetch).toHaveBeenCalledTimes(2)
})

it('retries within the same session, closes verification, and still requires a QR confirmation', async () => {
  vi.useFakeTimers()
  const host = verificationHost(),
    f = fixture([challenge(), { flag: 1, data: { key: 'next-key', qrcode: png } }], host)
  const state = await f.manager.start('liepin')
  await f.manager.verify('liepin', state.attemptId)
  const next = await f.manager.retry('liepin', state.attemptId)
  expect(next?.state).toBe('waiting')
  expect(next?.attemptId).not.toBe(state.attemptId)
  expect(host.close).toHaveBeenCalledWith('liepin', state.attemptId)
  expect(f.fetch).toHaveBeenCalledTimes(2)
  expect(f.authenticated).not.toHaveBeenCalled()
  host.open.mock.calls[0][0].onState({ window: 'error', error: 'blank' })
  expect(f.manager.get('liepin')?.verification.error).toBeNull()
  expect(await f.manager.retry('liepin', state.attemptId)).toBeNull()
  expect(f.fetch).toHaveBeenCalledTimes(2)
})
it.each([
  'https://evil.example/intercept/',
  'http://safe.liepin.com/intercept/',
  'https://safe.liepin.com/other',
  'about:blank',
])('does not offer an unsupported verification destination: %s', async (url) => {
  const host = verificationHost(),
    f = fixture([challenge(url)], host)
  const state = await f.manager.start('liepin')
  expect(state).toMatchObject({
    state: 'challenge',
    verification: { available: false, error: 'unavailable' },
  })
  await f.manager.verify('liepin', state.attemptId)
  expect(host.open).not.toHaveBeenCalled()
})
it('keeps an open official window beyond QR expiry and expires only after the user closes it', async () => {
  vi.useFakeTimers()
  const host = verificationHost(),
    f = fixture([challenge()], host)
  const state = await f.manager.start('liepin')
  await f.manager.verify('liepin', state.attemptId)
  await vi.advanceTimersByTimeAsync(600001)
  expect(f.manager.get('liepin')?.state).toBe('challenge')
  expect(host.close).not.toHaveBeenCalled()
  host.open.mock.calls[0][0].onState({ window: 'closed', error: null })
  expect(f.manager.get('liepin')?.state).toBe('expired')
  expect(host.close).toHaveBeenCalledWith('liepin', state.attemptId)
  expect(host.open.mock.calls[0][0].signal.aborted).toBe(true)
  host.open.mock.calls[0][0].onState({ window: 'ready', error: null })
  expect(f.manager.get('liepin')?.verification.available).toBe(false)
})
it('cancels verification on shutdown and rejects late callbacks', async () => {
  const host = verificationHost(),
    f = fixture([challenge()], host)
  const state = await f.manager.start('liepin')
  await f.manager.verify('liepin', state.attemptId)
  await f.manager.stop()
  host.open.mock.calls[0][0].onState({ window: 'ready', error: null })
  host.open.mock.calls[0][0].onUserClosed()
  expect(f.fetch).toHaveBeenCalledTimes(1)
  expect(f.manager.get('liepin')).toMatchObject({
    state: 'cancelled',
    verification: { available: false, window: 'closed' },
  })
  expect(host.close).toHaveBeenCalledWith('liepin', state.attemptId)
})
it('does not mislabel an unexplained Liepin protocol failure as a verification challenge', async () => {
  const f = fixture([{ flag: 0 }])
  expect(await f.manager.start('liepin')).toMatchObject({ state: 'error', reason: 'protocol' })
})

it('sends the required Liepin web client ID on QR creation, post-verification retry, and polling', async () => {
  vi.useFakeTimers()
  const host = verificationHost(),
    f = fixture(
      [
        challenge(),
        { flag: 1, data: { key: 'private-key', qrcode: png } },
        { flag: 1, data: { status: '10001' } },
      ],
      host,
    )
  // The live passport gateway returns this business error for a missing client ID,
  // even though the HTTP request succeeds and no security challenge is returned.
  const platformFetch = f.fetch.getMockImplementation()!
  f.fetch.mockImplementation((url, init) => {
    if (new Headers(init.headers).get('X-Fscp-Std-Info') !== '{"client_id":"40108"}')
      return Promise.resolve(new Response('{"flag":0,"code":"-1400","msg":"出错了（400）！"}'))
    return platformFetch(url, init)
  })
  const blocked = await f.manager.start('liepin')
  expect(blocked.state).toBe('challenge')
  await f.manager.verify('liepin', blocked.attemptId)
  const retried = await f.manager.retry('liepin', blocked.attemptId)
  expect(retried?.state).toBe('waiting')
  await vi.advanceTimersByTimeAsync(2000)
  expect(f.manager.get('liepin')?.state).toBe('waiting')
  expect(f.fetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
    '/api/com.liepin.passport.qr.get-mini-qrcode',
    '/api/com.liepin.passport.qr.get-mini-qrcode',
    '/api/com.liepin.passport.qr.ack',
  ])
  expect(f.authenticated).not.toHaveBeenCalled()
  expect(JSON.stringify(retried)).not.toContain('private-key')
})

it('exposes adapter-owned scan instructions without exposing its private protocol state', async () => {
  const f = fixture([{ code: 100000, data: { validateId: 'private-id', path: png } }])
  const state = await f.manager.start('zhilian')
  expect(state.scanHint['zh-CN']).toContain('智联招聘 App')
  expect(state.scanHint['en-US']).toContain('Zhaopin app')
  expect(JSON.stringify(state)).not.toContain('private-id')
  expect(state.expiresAt - Date.now()).toBeGreaterThan(290000)
})

it('does not write tokens or signal success from a cancelled pending login response', async () => {
  vi.useFakeTimers()
  const f = fixture([{ code: 100000, data: { validateId: 'id', path: png } }])
  const state = await f.manager.start('zhilian')
  let respond!: (value: Response) => void
  f.fetch.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        respond = resolve
      }),
  )
  await vi.advanceTimersByTimeAsync(2000)
  const cancelling = f.manager.cancel('zhilian', state.attemptId)
  respond(
    new Response(JSON.stringify({ code: 100000, data: { at: 'private-at', rt: 'private-rt' } })),
  )
  await cancelling
  expect(f.set).not.toHaveBeenCalled()
  expect(f.authenticated).not.toHaveBeenCalled()
  expect(f.manager.get('zhilian')?.state).toBe('cancelled')
})

it('isolates simultaneous platform protocols, credentials and cancellation', async () => {
  vi.useFakeTimers()
  const f = fixture([
    { code: 0, zpData: { shortRandKey: 'boss-private' } },
    { code: 0, zpData: { mpCodeUrl: png } },
    { flag: 1, data: { key: 'liepin-private', qrcode: png } },
    { flag: 1, data: { status: '0' } },
  ])
  const boss = await f.manager.start('boss')
  await f.manager.start('liepin')
  await f.manager.cancel('boss', boss.attemptId)
  await vi.advanceTimersByTimeAsync(2000)
  expect(f.manager.get('boss')?.state).toBe('cancelled')
  expect(f.manager.get('liepin')?.state).toBe('authenticated')
  expect(f.authenticated).toHaveBeenCalledExactlyOnceWith('liepin')
  const [url, init] = f.fetch.mock.calls.at(-1)!
  expect(url).toContain('liepin.com')
  expect(init.body).toContain('liepin-private')
  expect(init.body).not.toContain('boss-private')
  expect(new Headers(f.fetch.mock.calls[0][1].headers).has('X-Fscp-Std-Info')).toBe(false)
})
