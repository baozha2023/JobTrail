import { liepinVerificationUrl } from '../src/main/discovery/adapters/liepin'
import { EventEmitter } from 'node:events'
import type { BrowserWindowConstructorOptions, Session } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'
import { VerificationWindow, websiteUserAgent } from '../src/main/discovery/verification-window'
vi.mock('../src/main/diagnostics', async (original) => ({
  ...(await original<typeof import('../src/main/diagnostics')>()),
  captureError: vi.fn(),
}))
import {
  QrVerificationWindow,
  type QrVerificationHost,
} from '../src/main/discovery/qr-verification'

const windows: FakeWindow[] = []
class FakeWindow extends EventEmitter {
  destroyed = false
  url = ''
  show = vi.fn()
  focus = vi.fn()
  setMenu = vi.fn()
  webContents = Object.assign(new EventEmitter(), {
    getURL: () => this.url,
    getUserAgent: () => 'Mozilla/5.0 职迹/1.6.0 Chrome/150.0.0.0 Electron/43.7.7 Safari/537.36',
    setUserAgent: vi.fn(),
    setWebRTCIPHandlingPolicy: vi.fn(),
    loadURL: vi.fn(async (url: string) => {
      this.url = url
    }),
    executeJavaScript: vi.fn(async (): Promise<string> => 'challenge'),
    isLoadingMainFrame: () => false,
    setWindowOpenHandler: vi.fn(),
  })
  constructor(readonly options: BrowserWindowConstructorOptions) {
    super()
    windows.push(this)
  }
  isDestroyed() {
    return this.destroyed
  }
  destroy() {
    this.destroyed = true
    this.emit('closed')
  }
}
vi.mock('electron', () => ({
  BrowserWindow: class {
    constructor(options: BrowserWindowConstructorOptions) {
      return new FakeWindow(options)
    }
  },
}))
const controllers: AbortController[] = []
const url = 'https://safe.liepin.com/intercept/ip/captcha/dispatch?token=private'
function fixture() {
  const controller = new AbortController()
  controllers.push(controller)
  const nativeWindows = new VerificationWindow(() => undefined)
  const host = new QrVerificationWindow(nativeWindows)
  const input: Parameters<QrVerificationHost['open']>[0] = {
    platform: 'liepin',
    attemptId: 'attempt',
    url,
    session: {} as Session,
    signal: controller.signal,
    onState: vi.fn(),
  }
  return { host, input, controller, nativeWindows }
}
afterEach(() => {
  controllers.splice(0).forEach((c) => c.abort())
  windows.splice(0)
  vi.useRealTimers()
})

it.each([
  'https://safe.liepin.com.evil.test/intercept/',
  'https://user@safe.liepin.com/intercept/',
  'https://safe.liepin.com:8443/intercept/',
  'file:///x',
  'https://127.0.0.1/intercept/',
])('rejects unsafe challenge targets: %s', (value) =>
  expect(liepinVerificationUrl(value)).toBeNull(),
)
it('uses the provided session and sandbox, denies popups, reuses an open window, and reports user closure', async () => {
  const { host, input } = fixture()
  await host.open(input)
  const win = windows[0]
  expect(win.options.webPreferences).toMatchObject({
    session: input.session,
    sandbox: true,
    nodeIntegration: false,
    contextIsolation: true,
    webSecurity: true,
  })
  expect(win.options.webPreferences?.preload).toBeUndefined()
  expect(win.webContents.setWebRTCIPHandlingPolicy).toHaveBeenCalledWith('disable_non_proxied_udp')
  expect(win.webContents.setUserAgent).toHaveBeenCalledWith(
    'Mozilla/5.0 Chrome/150.0.0.0 Electron/43.7.7 Safari/537.36',
  )
  expect(win.options.title).toBe('猎聘')
  expect(win.webContents.loadURL).toHaveBeenCalledWith(url, {
    httpReferrer: 'https://www.liepin.com/',
  })
  expect(win.webContents.listenerCount('page-title-updated')).toBe(0)
  expect(win.webContents.setWindowOpenHandler.mock.calls[0][0]()).toEqual({ action: 'deny' })
  win.webContents.emit('dom-ready')
  await Promise.resolve()
  expect(input.onState).toHaveBeenLastCalledWith({ window: 'ready', error: null })
  await host.open(input)
  expect(windows).toHaveLength(1)
  expect(win.focus).toHaveBeenCalled()
  win.destroy()
  expect(input.onState).toHaveBeenLastCalledWith({ window: 'closed', error: null })
})
it.each(['职迹', 'JobTrail', 'zhiji'])(
  'omits the %s product name without replacing it with an alias',
  (name) => {
    expect(websiteUserAgent(`Mozilla/5.0 ${name}/1.6.0 Chrome/150 Electron/43 Safari/537.36`)).toBe(
      'Mozilla/5.0 Chrome/150 Electron/43 Safari/537.36',
    )
  },
)
it('preserves the official verification address exactly without adding app parameters or altering tokens', () => {
  const official =
    'https://safe.liepin.com/intercept/ip/captcha/dispatch?sourceUrl=https%3A%2F%2Fwww.liepin.com%2F&__xxx=opaque%2fvalue&redirect_xtype=1'
  expect(liepinVerificationUrl(official)).toBe(official)
})
it('does not create a window after the attempt was cancelled', async () => {
  const { host, input, controller } = fixture()
  controller.abort()
  await host.open(input)
  expect(windows).toHaveLength(0)
})
it.each([
  ['about:blank', 'blank'],
  ['https://evil.example/', 'blocked'],
])('closes unsupported navigation to %s', async (target, error) => {
  const { host, input } = fixture()
  await host.open(input)
  const event = { preventDefault: vi.fn() }
  windows[0].webContents.emit('will-navigate', event, target)
  expect(event.preventDefault).toHaveBeenCalled()
  expect(windows[0].destroyed).toBe(true)
  expect(input.onState).toHaveBeenLastCalledWith({ window: 'error', error })
})
it('releases a blank or timed-out page with an explicit error', async () => {
  vi.useFakeTimers()
  const { host, input } = fixture()
  await host.open(input)
  windows[0].webContents.executeJavaScript.mockResolvedValue('blank')
  windows[0].webContents.emit('did-start-navigation', {}, url, false, true)
  windows[0].webContents.emit('dom-ready')
  await Promise.resolve()
  await vi.advanceTimersByTimeAsync(25001)
  expect(input.onState).toHaveBeenLastCalledWith({ window: 'error', error: 'blank' })
  await host.open(input)
  await vi.advanceTimersByTimeAsync(25001)
  expect(windows[1].destroyed).toBe(true)
  expect(input.onState).toHaveBeenLastCalledWith({ window: 'error', error: 'timeout' })
})
it('waits for the SPA and refuses its soft 404 without showing the unusable window', async () => {
  vi.useFakeTimers()
  const { host, input } = fixture()
  await host.open(input)
  const win = windows[0]
  win.webContents.executeJavaScript.mockResolvedValueOnce('blank').mockResolvedValue('not_found')
  win.webContents.emit('dom-ready')
  await vi.advanceTimersByTimeAsync(351)
  expect(win.show).not.toHaveBeenCalled()
  expect(win.destroyed).toBe(true)
  expect(input.onState).toHaveBeenLastCalledWith({ window: 'error', error: 'site_error' })
})
it('rejects HTTP error pages even when they have content', async () => {
  const { host, input } = fixture()
  await host.open(input)
  windows[0].webContents.emit('did-navigate', {}, url, 404)
  expect(input.onState).toHaveBeenLastCalledWith({ window: 'error', error: 'site_error' })
})
it('ignores inspection from a previous navigation', async () => {
  const { host, input } = fixture()
  await host.open(input)
  let complete!: (value: string) => void
  const win = windows[0]
  win.webContents.executeJavaScript.mockImplementationOnce(
    () =>
      new Promise<string>((resolve) => {
        complete = resolve
      }),
  )
  win.webContents.emit('dom-ready')
  win.webContents.emit('did-start-navigation', {}, url, false, true)
  complete('challenge')
  await Promise.resolve()
  expect(win.show).not.toHaveBeenCalled()
  expect(input.onState).toHaveBeenLastCalledWith({ window: 'loading', error: null })
})
it('ignores a stale close request and abort closes the active window', async () => {
  const { host, input, controller } = fixture()
  await host.open(input)
  host.close('liepin', 'older-attempt')
  expect(windows[0].destroyed).toBe(false)
  controller.abort()
  expect(windows[0].destroyed).toBe(true)
})
it('shares one native window between QR and search verification without treating replacement as user completion', async () => {
  const { host, input, controller, nativeWindows } = fixture()
  await host.open(input)
  const searchController = new AbortController()
  controllers.push(searchController)
  const onClosed = vi.fn()
  const search = nativeWindows.open({
    platform: 'boss',
    session: input.session,
    signal: searchController.signal,
    onClosed,
  })
  expect(windows[0].destroyed).toBe(true)
  expect(input.onState).toHaveBeenLastCalledWith({ window: 'closed', error: null })
  controller.abort()
  expect(search.window.isDestroyed()).toBe(false)
  await host.open({ ...input, signal: new AbortController().signal })
  expect(search.window.isDestroyed()).toBe(true)
  expect(onClosed).toHaveBeenCalledExactlyOnceWith(false)
  host.close(input.platform, input.attemptId)
})
