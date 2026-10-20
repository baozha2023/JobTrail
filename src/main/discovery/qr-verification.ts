import type { Session } from 'electron'
import type { JobPlatform, QrVerificationState } from '../../shared/job-discovery'
import { allowedPage } from './platforms'
import type { VerificationPage } from './adapter'
import { platformAdapter } from './adapter-registry'
import { VerificationWindow, type VerificationWindowHandle } from './platform-browser'
import { captureError } from '../diagnostics'
import { AppServiceError } from '../services/errors'
import { LoginError, type QrPageTransport } from './qr-protocol'
import { bounded } from './async-control'

export type VerificationWindowState = Pick<QrVerificationState, 'window' | 'error'>
export interface QrVerificationHost {
  page(input: {
    platform: JobPlatform
    attemptId: string
    session: Session
    signal: AbortSignal
  }): QrPageTransport
  open(input: {
    platform: JobPlatform
    attemptId: string
    url: string
    session: Session
    signal: AbortSignal
    onState: (state: VerificationWindowState) => void
    onUserClosed: () => void
  }): Promise<void>
  close(platform: JobPlatform, attemptId: string): void
}

export class QrVerificationWindow implements QrVerificationHost {
  private prepared = new Map<
    string,
    {
      handle: VerificationWindowHandle
      closed: (user: boolean) => void
      transport: QrPageTransport
    }
  >()
  private current?: {
    platform: JobPlatform
    attemptId: string
    handle?: VerificationWindowHandle
    dispose: (state?: VerificationWindowState) => void
  }
  constructor(private windows: VerificationWindow) {}

  page(input: Parameters<QrVerificationHost['page']>[0]): QrPageTransport {
    input.signal.throwIfAborted()
    const key = `${input.platform}:${input.attemptId}`
    const existing = this.prepared.get(key)
    if (existing) return existing.transport
    const policy = platformAdapter(input.platform).verification
    if (!policy) throw new LoginError('protocol')
    const urls: string[] = []
    let blocked = false
    const handle = this.windows.prepare({
      ...input,
      onClosed: (user) => {
        const entry = this.prepared.get(key)
        this.prepared.delete(key)
        entry?.closed(user)
      },
    })
    const wc = handle.page.webContents
    const allows = (url: string) => allowedPage(input.platform, url) && policy.allowsNavigation(url)
    const observe = (event: Electron.Event, url: string) => {
      if (!allows(url) || urls.length >= 64) {
        event.preventDefault()
        blocked = true
        return
      }
      urls.push(url)
    }
    wc.on('will-navigate', observe)
    wc.on('will-redirect', observe)
    const check = () => {
      input.signal.throwIfAborted()
      if (blocked || wc.isDestroyed()) throw new LoginError('protocol')
    }
    const transport: QrPageTransport = {
      async load(url) {
        check()
        if (!allows(url)) throw new LoginError('protocol')
        urls.push(url)
        try {
          await bounded(
            wc.loadURL(url),
            AbortSignal.any([input.signal, AbortSignal.timeout(15000)]),
          )
        } catch (error) {
          check()
          if (!/ERR_ABORTED/.test(String(error)) || !allows(wc.getURL()))
            throw new LoginError('network', { cause: error })
        }
        check()
      },
      async read<T>(script: string): Promise<T> {
        check()
        if (!allows(wc.getURL())) throw new LoginError('protocol')
        return bounded(
          wc.executeJavaScript(script) as Promise<T>,
          AbortSignal.any([input.signal, AbortSignal.timeout(15000)]),
        )
      },
      history() {
        check()
        return [...urls]
      },
    }
    this.prepared.set(key, { handle, closed: () => {}, transport })
    return transport
  }

  close(platform: JobPlatform, attemptId: string) {
    const current = this.current
    if (current?.platform === platform && current.attemptId === attemptId) current.dispose()
    this.prepared.get(`${platform}:${attemptId}`)?.handle.close()
  }

  async open(input: Parameters<QrVerificationHost['open']>[0]): Promise<void> {
    if (input.signal.aborted) return
    const previous = this.current
    if (previous?.platform === input.platform && previous.attemptId === input.attemptId) {
      previous.handle?.window.show()
      previous.handle?.window.focus()
      return
    }
    previous?.dispose()
    const adapter = platformAdapter(input.platform),
      policy = adapter.verification
    if (!policy || !allowedPage(input.platform, input.url) || !policy.acceptsUrl(input.url)) {
      captureError(new AppServiceError('DISCOVERY_FAILED', 'QR verification blocked'), {
        operation: `discovery.${input.platform}.qr-verification`,
        level: 'warn',
      })
      input.onState({ window: 'error', error: 'blocked' })
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    let poll: ReturnType<typeof setTimeout> | undefined
    let navigationId = 0
    let lastPage: VerificationPage = 'loading'
    let presented = false
    const abort = () => current.dispose()
    const current: NonNullable<QrVerificationWindow['current']> = {
      platform: input.platform,
      attemptId: input.attemptId,
      dispose: (state = { window: 'closed', error: null }) => {
        if (this.current !== current) return
        this.current = undefined
        clearTimeout(timer)
        clearTimeout(poll)
        input.signal.removeEventListener('abort', abort)
        current.handle?.close()
        input.onState(state)
      },
    }
    this.current = current
    input.signal.addEventListener('abort', abort, { once: true })
    const active = () => this.current === current && !input.signal.aborted
    const fail = (error: NonNullable<QrVerificationState['error']>, cause?: unknown) => {
      if (!active()) return
      captureError(
        new AppServiceError('DISCOVERY_FAILED', `QR verification ${error}`, undefined, { cause }),
        { operation: `discovery.${input.platform}.qr-verification`, level: 'warn' },
      )
      clearTimeout(timer)
      clearTimeout(poll)
      if (presented) input.onState({ window: 'ready', error })
      else current.dispose({ window: 'error', error })
    }
    input.onState({ window: 'loading', error: null })
    timer = setTimeout(() => fail('timeout'), 25000)
    try {
      if (!active()) return
      const retained = this.prepared.get(`${input.platform}:${input.attemptId}`)
      const onClosed = (userClosed: boolean) => {
        current.dispose()
        if (userClosed && !input.signal.aborted) input.onUserClosed()
      }
      if (retained) retained.closed = onClosed
      current.handle =
        retained?.handle ??
        this.windows.open({
          platform: input.platform,
          session: input.session,
          signal: input.signal,
          onClosed,
        })
      const wc = current.handle.page.webContents
      const allowed = (url: string) =>
        allowedPage(input.platform, url) && policy.allowsNavigation(url)
      const navigation = (event: Electron.Event, url: string) => {
        if (!allowed(url)) {
          event.preventDefault()
          fail(url === 'about:blank' ? 'blank' : 'blocked')
        }
      }
      wc.on('will-navigate', navigation)
      wc.on('will-redirect', navigation)
      wc.on('render-process-gone', () => fail('network'))
      wc.on('destroyed', () => {
        clearTimeout(timer)
        clearTimeout(poll)
        // The shared manager may be disposing this page intentionally. Its
        // onClosed callback must settle that cancellation before reporting loss.
        setImmediate(() => {
          if (active()) fail('blank')
        })
      })
      wc.on('did-fail-load', (_event, code, _description, _url, mainFrame) => {
        if (mainFrame && code !== -3) fail('network')
      })
      wc.on('did-navigate', (_event, _url, status) => {
        if (status >= 400) fail('site_error')
      })
      wc.on('did-start-navigation', (_event, url, inPlace, mainFrame) => {
        if (!active() || !mainFrame || inPlace) return
        if (!allowed(url)) return fail(url === 'about:blank' ? 'blank' : 'blocked')
        navigationId++
        clearTimeout(poll)
        lastPage = 'loading'
        clearTimeout(timer)
        input.onState({ window: 'loading', error: null })
        timer = setTimeout(() => fail(lastPage === 'blank' ? 'blank' : 'timeout'), 25000)
      })
      const inspect = () => {
        if (!active()) return
        if (wc.isDestroyed()) return fail('blank')
        if (!allowed(wc.getURL())) return fail('blocked')
        const navigation = navigationId
        clearTimeout(poll)
        void wc
          .executeJavaScript(policy.pageScript())
          .then((page: VerificationPage) => {
            if (!active() || navigation !== navigationId) return
            lastPage = page
            if (page === 'not_found') return fail('site_error')
            if (page === 'challenge') {
              clearTimeout(timer)
              presented = true
              current.handle?.present()
              input.onState({ window: 'ready', error: null })
            } else {
              // Wait for the SPA to mount its real challenge or error page.
              poll = setTimeout(inspect, 350)
            }
          })
          .catch((error) => {
            if (active() && navigation === navigationId) fail('network', error)
          })
      }
      wc.on('dom-ready', inspect)
      if (retained) inspect()
      else
        void wc.loadURL(input.url, { httpReferrer: policy.referrer }).catch((error) => {
          if (active() && !wc.isDestroyed() && !wc.isLoadingMainFrame() && !allowed(wc.getURL()))
            fail('network', error)
        })
    } catch (error) {
      if (active()) fail('network', error)
    }
  }
}
