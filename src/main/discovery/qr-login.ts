import { randomUUID } from 'node:crypto'
import { captureError } from '../diagnostics'
import type { Session } from 'electron'
import type { JobPlatform, QrLoginState, QrLoginMethod } from '../../shared/job-discovery'
import { AppServiceError } from '../services/errors'
import type { QrVerificationHost } from './qr-verification'
import { platformAdapter } from './adapter-registry'
import { LoginError, type QrProtocol } from './qr-protocol'
import { accountLoginTransport, type AccountLoginTransport } from './account-session'

interface Attempt {
  value: QrLoginState
  controller: AbortController
  task?: Promise<void>
  timer?: ReturnType<typeof setTimeout>
  protocol?: QrProtocol
  transport?: AccountLoginTransport
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
      a.value.verification.window !== 'ready' &&
      a.value.verification.window !== 'loading' &&
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
    a.transport = undefined
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
      onUserClosed: () => {
        if (!this.active(a) || a.value.state !== 'challenge') return
        // Keep the attempt ID so the existing UI poll observes the replacement QR.
        a.value = {
          ...a.value,
          state: 'loading',
          image: null,
          reason: null,
          expiresAt: Date.now() + 180000,
          verification: { available: false, window: 'closed', error: null },
        }
        a.verificationUrl = null
        a.task = this.initialize(a).catch((error) => this.fail(a, error))
      },
    })
    return this.get(p, id)
  }
  async retry(p: JobPlatform, id: string) {
    const value = this.get(p, id)
    if (!value || value.state !== 'challenge') return value
    return this.start(p, value.method)
  }
  async start(p: JobPlatform, method?: QrLoginMethod): Promise<QrLoginState> {
    const qr = platformAdapter(p).qr
    const methods = qr.methods ?? [
      { id: 'website' as const, label: qr.scanHint, scanHint: qr.scanHint },
    ]
    const selected = methods.find((item) => item.id === (method ?? methods[0].id))
    if (!selected) throw new AppServiceError('VALIDATION_ERROR', 'Unsupported login method')
    const cancelled = this.cancel(p)
    const a: Attempt = {
      value: {
        platform: p,
        method: selected.id,
        methods: methods.map(({ id, label }) => ({ id, label })),
        scanHint: selected.scanHint,
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
    a.transport = undefined
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
  private async initialize(a: Attempt) {
    const transport = accountLoginTransport(
      a.value.platform,
      await a.session,
      a.controller.signal,
      {
        scanned: () => {
          if (this.active(a)) a.value.state = 'scanned'
        },
        challenge: (url) => {
          if (this.active(a)) a.verificationUrl = url
        },
      },
    )
    a.transport = transport
    a.protocol = platformAdapter(a.value.platform).qr.create(transport, a.value.method)
    const result = await a.protocol.initialize()
    if (!this.active(a)) return
    const pixels = await transport.image(result.image)
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
      await a.transport!.flush()
      if (!this.active(a)) return
      a.value = { ...a.value, state: 'authenticated', image: null }
      a.protocol = undefined
      a.transport = undefined
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
    a.transport = undefined
  }
}
