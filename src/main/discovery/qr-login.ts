import { randomUUID } from 'node:crypto'
import { captureError } from '../diagnostics'
import type { Session } from 'electron'
import type { JobPlatform, QrLoginState } from '../../shared/job-discovery'
import { allowedPage } from './platforms'
import type { QrVerificationHost } from './qr-verification'
import { platformAdapter } from './adapter-registry'
import { LoginError, type QrProtocol, type QrTransport, type QrRequestOptions } from './qr-protocol'

interface Attempt {
  value: QrLoginState
  controller: AbortController
  task?: Promise<void>
  timer?: ReturnType<typeof setTimeout>
  protocol?: QrProtocol
  session: Promise<Session>
  verificationUrl: string | null
}
export class QrLoginManager {
  private attempts = new Map<JobPlatform, Attempt>()
  constructor(
    private getSession: (p: JobPlatform) => Promise<Session>,
    private authenticated: (p: JobPlatform) => void,
    private blocked?: (p: JobPlatform) => void,
    private verification?: QrVerificationHost,
  ) {}
  get(p: JobPlatform, id?: string): QrLoginState | null {
    const a = this.attempts.get(p)
    if (!a || (id && id !== a.value.attemptId)) return null
    if (
      ['waiting', 'scanned', 'challenge'].includes(a.value.state) &&
      Date.now() >= a.value.expiresAt
    ) {
      a.controller.abort()
      this.verification?.close(p, a.value.attemptId)
      clearTimeout(a.timer)
      this.expire(a)
    }
    return { ...a.value }
  }
  async cancel(p: JobPlatform, id?: string) {
    const a = this.attempts.get(p)
    if (!a || (id && id !== a.value.attemptId)) return
    a.controller.abort()
    this.verification?.close(p, a.value.attemptId)
    clearTimeout(a.timer)
    a.value = {
      ...a.value,
      state: 'cancelled',
      image: null,
      verification: { available: false, window: 'closed', error: null },
    }
    a.verificationUrl = null
    a.protocol = undefined
    await a.task
  }
  async stop() {
    await Promise.all([...this.attempts.keys()].map((p) => this.cancel(p)))
  }
  async verify(p: JobPlatform, id: string) {
    const value = this.get(p, id),
      a = this.attempts.get(p)
    if (
      !a ||
      !value ||
      value.state !== 'challenge' ||
      !value.verification.available ||
      !a.verificationUrl
    )
      return value
    await this.verification?.open({
      platform: p,
      attemptId: id,
      url: a.verificationUrl,
      session: await a.session,
      signal: a.controller.signal,
      onState: (state) => {
        if (this.active(a) && a.value.state === 'challenge')
          a.value = { ...a.value, verification: { ...a.value.verification, ...state } }
      },
    })
    return this.get(p, id)
  }
  async retry(p: JobPlatform, id: string) {
    const value = this.get(p, id)
    if (!value || value.state !== 'challenge') return value
    return this.start(p)
  }
  async start(p: JobPlatform): Promise<QrLoginState> {
    const cancelled = this.cancel(p)
    const a: Attempt = {
      value: {
        platform: p,
        scanHint: platformAdapter(p).qr.scanHint,
        attemptId: randomUUID(),
        state: 'loading',
        image: null,
        expiresAt: Date.now() + 180000,
        reason: null,
        verification: { available: false, window: 'closed', error: null },
      },
      controller: new AbortController(),
      session: this.getSession(p),
      verificationUrl: null,
    }
    this.attempts.set(p, a)
    a.task = Promise.all([cancelled, a.session])
      .then(() => (this.active(a) ? this.initialize(a) : undefined))
      .catch((e) => this.fail(a, e))
    await a.task
    return { ...a.value }
  }
  private active(a: Attempt) {
    return !a.controller.signal.aborted && this.attempts.get(a.value.platform) === a
  }
  private fail(a: Attempt, error: unknown) {
    if (!this.active(a)) return
    captureError(error, { operation: `discovery.${a.value.platform}.qr`, level: 'warn' })
    const reason = error instanceof LoginError ? error.reason : 'network'
    a.value = {
      ...a.value,
      state: reason === 'verification' ? 'challenge' : 'error',
      image: null,
      reason,
    }
    a.protocol = undefined
    clearTimeout(a.timer)
    if (reason === 'verification') {
      a.value.expiresAt = Date.now() + 600000
      a.value.verification = {
        available: !!a.verificationUrl && !!this.verification,
        window: 'closed',
        error: a.verificationUrl ? null : 'unavailable',
      }
    }
    if (reason === 'verification') this.blocked?.(a.value.platform)
  }
  private async request(
    a: Attempt,
    url: string,
    options: QrRequestOptions = {},
  ): Promise<Response> {
    a.controller.signal.throwIfAborted()
    if (!allowedPage(a.value.platform, url)) throw new LoginError('protocol')
    const { data, jsonBody = false, timeoutMs = 15000 } = options
    const adapter = platformAdapter(a.value.platform)
    const session = await a.session
    a.controller.signal.throwIfAborted()
    const response = await session.fetch(url, {
      method: data ? 'POST' : 'GET',
      credentials: 'include',
      redirect: 'error',
      signal: AbortSignal.any([a.controller.signal, AbortSignal.timeout(timeoutMs)]),
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        ...adapter.qr.headers?.(url),
        ...(data
          ? { 'Content-Type': jsonBody ? 'application/json' : 'application/x-www-form-urlencoded' }
          : {}),
      },
      body: data
        ? jsonBody
          ? JSON.stringify(data)
          : new URLSearchParams(data).toString()
        : undefined,
    })
    if (!this.active(a)) {
      await this.releaseBody(response.body)
      throw new LoginError('network')
    }
    const challenge = adapter.qr.challenge?.(response)
    if (challenge) {
      a.verificationUrl = challenge.url
      await this.releaseBody(response.body)
      throw new LoginError('verification')
    }
    if (!response.ok) {
      await this.releaseBody(response.body)
      throw new LoginError([401, 403, 429].includes(response.status) ? 'verification' : 'network')
    }
    return response
  }
  private async releaseBody(body: { cancel(): Promise<void> } | null) {
    try {
      await body?.cancel()
    } catch (error) {
      captureError(error, { operation: 'discovery.qr.body-cleanup', level: 'warn' })
    }
  }
  private async body(response: Response) {
    if (Number(response.headers.get('content-length')) > 2_000_000) {
      await this.releaseBody(response.body)
      throw new LoginError('protocol')
    }
    const reader = response.body?.getReader()
    if (!reader) throw new LoginError('protocol')
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 2_000_000) throw new LoginError('protocol')
        chunks.push(value)
      }
    } finally {
      await this.releaseBody(reader)
    }
    return Buffer.concat(chunks)
  }
  private transport(a: Attempt): QrTransport {
    const text = async (url: string, options?: QrRequestOptions) =>
      (await this.body(await this.request(a, url, options))).toString('utf8')
    return {
      text,
      json: async (url, parse, options, decode = JSON.parse) => {
        const body = await text(url, options)
        try {
          return parse(decode(body))
        } catch (error) {
          throw new LoginError(/captcha|验证|访问异常/i.test(body) ? 'verification' : 'protocol', {
            cause: error,
          })
        }
      },
      setCookie: async (cookie) => {
        a.controller.signal.throwIfAborted()
        if (!this.active(a)) return
        if (!allowedPage(a.value.platform, cookie.url)) throw new LoginError('protocol')
        const host = new URL(cookie.url).hostname
        const domain = cookie.domain?.replace(/^\./, '')
        if (
          domain &&
          ((host !== domain && !host.endsWith('.' + domain)) ||
            !allowedPage(a.value.platform, 'https://' + domain))
        )
          throw new LoginError('protocol')
        const session = await a.session
        a.controller.signal.throwIfAborted()
        await session.cookies.set(cookie)
      },
      scanned: () => {
        if (this.active(a)) a.value.state = 'scanned'
      },
    }
  }
  private async image(a: Attempt, value: unknown) {
    if (typeof value !== 'string' || !value) throw new LoginError('protocol')
    if (
      /^data:image\/(png|jpeg|gif|webp);base64,[a-z\d+/=]+$/i.test(value) &&
      value.length < 2_000_000
    )
      return value
    const url = new URL(value).href
    const response = await this.request(a, url)
    const mime = response.headers.get('content-type')?.split(';')[0]
    if (!mime || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime))
      throw new LoginError('protocol')
    return `data:${mime};base64,${(await this.body(response)).toString('base64')}`
  }
  private async initialize(a: Attempt) {
    a.protocol = platformAdapter(a.value.platform).qr.create(this.transport(a))
    const result = await a.protocol.initialize()
    if (!this.active(a)) return
    const pixels = await this.image(a, result.image)
    if (!this.active(a)) return
    a.value = {
      ...a.value,
      image: pixels,
      state: 'waiting',
      expiresAt: Date.now() + result.expiresInMs,
    }
    this.schedule(a)
  }
  private schedule(a: Attempt) {
    if (!this.active(a)) return
    a.timer = setTimeout(() => {
      a.task = this.poll(a).catch((e) => this.fail(a, e))
    }, 2000)
  }
  private async poll(a: Attempt) {
    if (!this.active(a)) return
    if (Date.now() >= a.value.expiresAt) {
      this.expire(a)
      return
    }
    const state = await a.protocol!.poll()
    if (!this.active(a)) return
    if (state === 'expired') {
      this.expire(a)
      return
    }
    if (state === 'scanned') a.value.state = 'scanned'
    if (state === 'authenticated') {
      await (await a.session).cookies.flushStore()
      if (!this.active(a)) return
      a.value = { ...a.value, state: 'authenticated', image: null }
      a.protocol = undefined
      this.authenticated(a.value.platform)
    } else this.schedule(a)
  }
  private expire(a: Attempt) {
    a.value = {
      ...a.value,
      state: 'expired',
      image: null,
      verification: { available: false, window: 'closed', error: null },
    }
    a.verificationUrl = null
    a.protocol = undefined
  }
}
