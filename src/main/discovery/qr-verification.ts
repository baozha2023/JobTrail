import type { Session } from 'electron'
import type { JobPlatform, QrVerificationState } from '../../shared/job-discovery'
import { allowedPage } from './platforms'
import type { VerificationPage } from './adapter'
import { platformAdapter } from './adapter-registry'
import { VerificationWindow, type VerificationWindowHandle } from './platform-browser'
import { captureError } from '../diagnostics'
import { AppServiceError } from '../services/errors'

export type VerificationWindowState = Pick<QrVerificationState, 'window' | 'error'>
export interface QrVerificationHost {
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
  private current?: {
    platform: JobPlatform
    attemptId: string
    handle?: VerificationWindowHandle
    dispose: (state?: VerificationWindowState) => void
  }
  constructor(private windows: VerificationWindow) {}

  close(platform: JobPlatform, attemptId: string) {
    const current = this.current
    if (current?.platform === platform && current.attemptId === attemptId) current.dispose()
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
      current.handle = this.windows.open({
        platform: input.platform,
        session: input.session,
        signal: input.signal,
        onClosed: (userClosed) => {
          current.dispose()
          if (userClosed && !input.signal.aborted) input.onUserClosed()
        },
      })
      const win = current.handle.window
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
              win.show()
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
      void wc.loadURL(input.url, { httpReferrer: policy.referrer }).catch((error) => {
        if (active() && !wc.isDestroyed() && !wc.isLoadingMainFrame() && !allowed(wc.getURL()))
          fail('network', error)
      })
    } catch (error) {
      if (active()) fail('network', error)
    }
  }
}
