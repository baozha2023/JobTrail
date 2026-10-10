import { session, type CookiesSetDetails, type Session } from 'electron'
import path from 'node:path'
import { websiteUserAgent } from './platform-browser'
import { validateWebUrl } from '../services/web-network'
import { captureError } from '../diagnostics'
import { SourceError, type AccountTransport, type AccountSessionState } from './adapter'
import type { JobPlatform, PlatformStatus } from '../../shared/job-discovery'
import type { PageSnapshot } from './extraction'
import { allowedPage } from './platforms'
import { platformAdapter } from './adapter-registry'
import { bounded } from './async-control'
import { LoginError, type QrTransport, type QrRequestOptions } from './qr-protocol'

/** Owns platform sessions and their system-network lifecycle. */
export class AccountSessions {
  private sessions = new Map<JobPlatform, Promise<Session>>()
  constructor(private root: string) {}
  get(platform: JobPlatform): Promise<Session> {
    let ready = this.sessions.get(platform)
    if (!ready) {
      const value = session.fromPath(path.join(this.root, 'browser-sessions', platform), {
        cache: true,
      })
      value.setUserAgent(websiteUserAgent(value.getUserAgent()))
      value.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
      value.setPermissionCheckHandler(() => false)
      value.on('will-download', (event) => event.preventDefault())
      value.webRequest.onBeforeRequest((details, callback) => {
        if (details.url.startsWith('data:') || details.url.startsWith('blob:')) {
          callback({ cancel: details.resourceType === 'mainFrame' })
          return
        }
        if (details.resourceType === 'mainFrame' && !allowedPage(platform, details.url)) {
          callback({ cancel: true })
          return
        }
        try {
          validateWebUrl(details.url)
          callback({ cancel: false })
        } catch (error) {
          captureError(error, { operation: `discovery.${platform}.network-check`, level: 'warn' })
          callback({ cancel: true })
        }
      })
      ready = (async () => {
        // Replace any previous custom proxy before allowing requests on this session.
        await value.setProxy({ mode: 'system' })
        await value.closeAllConnections()
        return value
      })()
      this.sessions.set(platform, ready)
      void ready.catch(() => {
        if (this.sessions.get(platform) === ready) this.sessions.delete(platform)
      })
    }
    return ready
  }
  async clear(platform: JobPlatform) {
    const value = await this.get(platform)
    await value.clearData()
    await value.clearCache()
  }
  async flush() {
    for (const ready of this.sessions.values()) {
      const value = await ready
      value.flushStorageData()
      await value.cookies.flushStore()
    }
  }
  async closeConnections() {
    await Promise.all(
      [...this.sessions.values()].map(async (ready) => (await ready).closeAllConnections()),
    )
  }
}

export type AccountPageReader = (url: string, script: string) => Promise<PageSnapshot>

/** All login and account requests use the same isolated Session and resource limits. */
class SessionRequests {
  constructor(
    private platform: JobPlatform,
    private session: Session,
    private signal: AbortSignal,
  ) {}
  check(url: string) {
    this.signal.throwIfAborted()
    if (!allowedPage(this.platform, url) || new URL(url).protocol !== 'https:')
      throw new SourceError('parse_error', 'invalid_account_endpoint')
  }
  async cookie(url: string, name: string) {
    this.check(url)
    const values = await bounded(this.session.cookies.get({ url, name }), this.signal)
    this.signal.throwIfAborted()
    return (
      values.find((value) => !value.expirationDate || value.expirationDate > Date.now() / 1000)
        ?.value ?? null
    )
  }
  async setCookie(cookie: CookiesSetDetails) {
    this.check(cookie.url)
    const host = new URL(cookie.url).hostname
    const domain = cookie.domain?.replace(/^\./, '')
    if (domain) {
      if (host !== domain && !host.endsWith('.' + domain))
        throw new SourceError('parse_error', 'invalid_cookie_domain')
      this.check('https://' + domain)
    }
    await bounded(this.session.cookies.set(cookie), this.signal)
    this.signal.throwIfAborted()
  }
  async body(url: string, options: QrRequestOptions = {}, inspect?: (response: Response) => void) {
    this.check(url)
    const signal = AbortSignal.any([this.signal, AbortSignal.timeout(options.timeoutMs ?? 15000)])
    const headers = new Headers(options.headers)
    if (options.data)
      headers.set(
        'Content-Type',
        options.jsonBody ? 'application/json' : 'application/x-www-form-urlencoded',
      )
    const pending = this.session
      .fetch(url, {
        method: options.data ? 'POST' : 'GET',
        credentials: 'include',
        redirect: 'error',
        signal,
        headers,
        body: options.data
          ? options.jsonBody
            ? JSON.stringify(options.data)
            : new URLSearchParams(options.data).toString()
          : undefined,
      })
      .then((response) => {
        if (signal.aborted) {
          void response.body?.cancel().catch(() => {})
          signal.throwIfAborted()
        }
        return response
      })
    const response = await bounded(pending, signal)
    const reader = response.body?.getReader()
    try {
      inspect?.(response)
      if (response.status === 401) throw new SourceError('login_required')
      if ([403, 429].includes(response.status)) throw new SourceError('challenge')
      if (!response.ok) throw new SourceError('network_error', 'account_request_failed')
      if (!reader || Number(response.headers.get('content-length')) > 2_000_000)
        throw new SourceError('parse_error', 'account_response_too_large')
      const chunks: Uint8Array[] = []
      let length = 0
      for (;;) {
        const { value, done } = await bounded(reader.read(), signal)
        if (done) break
        length += value.byteLength
        if (length > 2_000_000) throw new SourceError('parse_error', 'account_response_too_large')
        chunks.push(value)
      }
      signal.throwIfAborted()
      return {
        bytes: Buffer.concat(chunks),
        mime: response.headers.get('content-type')?.split(';')[0],
      }
    } finally {
      void reader?.cancel().catch(() => {})
    }
  }
}

/** The adapter chooses its account endpoint, page, and positive authentication evidence. */
export async function checkAccountSession(
  platform: JobPlatform,
  session: Session,
  signal: AbortSignal,
  readPage: AccountPageReader,
): Promise<AccountSessionState> {
  const transport = accountTransport(platform, session, signal, readPage)
  try {
    const state = await platformAdapter(platform).checkSession(transport)
    signal.throwIfAborted()
    return state
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof SourceError) {
      if (error.state === 'login_required' || error.state === 'session_expired')
        return 'login_required'
      if (error.state === 'challenge') return 'challenge'
    }
    throw error
  }
}

export function accountTransport(
  platform: JobPlatform,
  session: Session,
  signal: AbortSignal,
  readPage: AccountPageReader,
): AccountTransport {
  const requests = new SessionRequests(platform, session, signal)
  return {
    cookie: (url, name) => requests.cookie(url, name),
    async page(url, script) {
      requests.check(url)
      const page = await bounded(readPage(url, script), signal)
      signal.throwIfAborted()
      requests.check(page.url)
      return page
    },
    async json(url, parse, options) {
      const body = await requests.body(url, options)
      try {
        return parse(JSON.parse(body.bytes.toString('utf8')))
      } catch (error) {
        if (error instanceof SourceError) throw error
        throw new SourceError('parse_error', 'account_contract_changed')
      }
    },
  }
}

export interface AccountLoginTransport extends QrTransport {
  image(value: unknown): Promise<string>
  flush(): Promise<void>
}

/** QR lifecycle stays in QrLoginManager; requests, cookies and images share this boundary. */
export function accountLoginTransport(
  platform: JobPlatform,
  session: Session,
  signal: AbortSignal,
  callbacks: { scanned(): void; challenge(url: string | null): void },
): AccountLoginTransport {
  const requests = new SessionRequests(platform, session, signal)
  const qr = platformAdapter(platform).qr
  const login = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work()
    } catch (error) {
      if (error instanceof LoginError) throw error
      if (error instanceof SourceError)
        throw new LoginError(
          error.state === 'parse_error'
            ? 'protocol'
            : ['login_required', 'challenge'].includes(error.state)
              ? 'verification'
              : 'network',
          { cause: error },
        )
      throw error
    }
  }
  const body = (url: string, options: QrRequestOptions = {}) => {
    const headers = new Headers(qr.headers?.(url))
    for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value)
    return login(() =>
      requests.body(url, { ...options, headers: Object.fromEntries(headers) }, (response) => {
        const challenge = qr.challenge?.(response)
        if (challenge) {
          callbacks.challenge(challenge.url)
          throw new LoginError('verification')
        }
      }),
    )
  }
  const text = async (url: string, options?: QrRequestOptions) =>
    (await body(url, options)).bytes.toString('utf8')
  return {
    text,
    async json(url, parse, options, decode = JSON.parse) {
      const value = await text(url, options)
      try {
        return parse(decode(value))
      } catch (error) {
        throw new LoginError(/captcha|验证|访问异常/i.test(value) ? 'verification' : 'protocol', {
          cause: error,
        })
      }
    },
    setCookie: (cookie) => login(() => requests.setCookie(cookie)),
    async flush() {
      signal.throwIfAborted()
      await bounded(session.cookies.flushStore(), signal)
      signal.throwIfAborted()
    },
    scanned() {
      signal.throwIfAborted()
      callbacks.scanned()
    },
    async image(value) {
      signal.throwIfAborted()
      if (typeof value !== 'string' || !value) throw new LoginError('protocol')
      if (
        /^data:image\/(png|jpeg|gif|webp);base64,[a-z\d+/=]+$/i.test(value) &&
        value.length < 2_000_000
      )
        return value
      const result = await body(value)
      if (
        !result.mime ||
        !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(result.mime)
      )
        throw new LoginError('protocol')
      return `data:${result.mime};base64,${result.bytes.toString('base64')}`
    },
  }
}

// Failure to find account controls (loading, changed markup, or a public page)
// cannot invalidate a previously confirmed login or refresh its evidence time.
export function statusFromPage(
  previous: PlatformStatus,
  page: Pick<PageSnapshot, 'challenge' | 'authenticated' | 'login'>,
  now = Date.now(),
): PlatformStatus {
  if (!page.challenge && !page.authenticated && !page.login)
    return {
      ...previous,
      limitations: [
        ...new Set([
          ...previous.limitations,
          'authentication_check_inconclusive',
          ...(previous.state === 'authenticated' ? ['session_recheck_required'] : []),
        ]),
      ],
    }
  const state = page.challenge
    ? 'challenge'
    : page.authenticated
      ? 'authenticated'
      : ['authenticated', 'session_expired'].includes(previous.state)
        ? 'session_expired'
        : 'login_required'
  return {
    ...previous,
    state,
    checkedAt: now,
    evidence: page.challenge
      ? 'visible_challenge'
      : page.authenticated
        ? 'visible_account_controls'
        : 'official_login_form',
    limitations: state === 'authenticated' ? [] : [state],
  }
}
