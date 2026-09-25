import { randomUUID } from 'node:crypto'
import { AppServiceError } from './errors'
import type { BrowserReader } from './web-browser'
import type { ParsedWebPage } from './web-parser'
import type { WebPageResult } from './web-retrieval-service'

export type WebRenderMode = 'auto' | 'static' | 'dynamic'

export interface WebPageSnapshot {
  sourceUrl: string
  requestUrl: string
  render: WebRenderMode
  scroll: boolean
  finalUrl: string
  fetchedAt: number
  parsed: ParsedWebPage
  incompleteReason: string | null
  warnings: string[]
}

export interface WebReadSession {
  requestUrl: string
  render: WebRenderMode
  scroll: boolean
  snapshot: WebPageSnapshot
  browser: BrowserReader | null
  seen: Set<string>
  steps: number
  requests: number
  bytes: number
}

interface SessionEntry {
  session: WebReadSession
  bytes: number
  createdAt: number
  expiresAt: number
  timer: ReturnType<typeof setTimeout>
  tokens: Set<string>
}

interface CursorEntry {
  sessionId: string
  run: (signal: AbortSignal) => Promise<WebPageResult>
  promise?: Promise<WebPageResult>
}

const STATIC_IDLE_MS = 10 * 60_000
const SCROLL_IDLE_MS = 5 * 60_000
const SCROLL_LIFETIME_MS = 15 * 60_000
const CURSOR_PATTERN = /^wr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function withSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new AppServiceError('WEB_CANCELLED', '网页读取已取消'))
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort)
      reject(new AppServiceError('WEB_CANCELLED', '网页读取已取消'))
    }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
  })
}

export class WebPageCache {
  private readonly sessions = new Map<string, SessionEntry>()
  private readonly cursors = new Map<string, CursorEntry>()
  private totalBytes = 0

  constructor(
    private readonly now: () => number = Date.now,
    private readonly limits = { maxEntries: 8, maxBytes: 32 * 1024 * 1024 },
  ) {}

  store(session: WebReadSession): string {
    this.prune()
    const bytes = this.sizeOf(session)
    if (bytes > this.limits.maxBytes)
      throw new AppServiceError('WEB_TOO_LARGE', '网页解析结果超过续读缓存上限')
    while (
      this.sessions.size >= this.limits.maxEntries ||
      this.totalBytes + bytes > this.limits.maxBytes
    ) {
      const oldest = this.sessions.keys().next().value
      if (!oldest) break
      this.remove(oldest)
    }
    const id = randomUUID()
    const createdAt = this.now()
    const entry: SessionEntry = {
      session,
      bytes,
      createdAt,
      expiresAt: this.expiry(session, createdAt, createdAt),
      timer: setTimeout(() => this.remove(id), session.scroll ? SCROLL_IDLE_MS : STATIC_IDLE_MS),
      tokens: new Set(),
    }
    entry.timer.unref?.()
    this.sessions.set(id, entry)
    this.totalBytes += bytes
    return id
  }

  update(id: string, snapshot: WebPageSnapshot): void {
    const entry = this.sessions.get(id)
    if (!entry) throw new AppServiceError('WEB_CURSOR_EXPIRED', '网页续读会话已失效')
    const previous = entry.session.snapshot
    const previousBytes = entry.bytes
    entry.session.snapshot = snapshot
    const bytes = this.sizeOf(entry.session)
    if (bytes > this.limits.maxBytes) {
      entry.session.snapshot = previous
      throw new AppServiceError('WEB_TOO_LARGE', '网页解析结果超过续读缓存上限')
    }
    this.totalBytes += bytes - entry.bytes
    entry.bytes = bytes
    while (this.totalBytes > this.limits.maxBytes) {
      const oldest = [...this.sessions.keys()].find((key) => key !== id)
      if (!oldest) break
      this.remove(oldest)
    }
    if (this.totalBytes > this.limits.maxBytes) {
      entry.session.snapshot = previous
      entry.bytes = previousBytes
      this.totalBytes += previousBytes - bytes
      throw new AppServiceError('WEB_TOO_LARGE', '网页续读缓存超过上限')
    }
  }

  cursor(id: string, run: (signal: AbortSignal) => Promise<WebPageResult>): string {
    const entry = this.sessions.get(id)
    if (!entry) throw new AppServiceError('WEB_CURSOR_EXPIRED', '网页续读会话已失效')
    const token = `wr_${randomUUID()}`
    this.cursors.set(token, { sessionId: id, run })
    entry.tokens.add(token)
    return token
  }

  async resolve(
    token: string,
    requestUrl: string,
    render: WebRenderMode,
    scroll: boolean,
    signal: AbortSignal,
  ): Promise<WebPageResult> {
    if (!CURSOR_PATTERN.test(token))
      throw new AppServiceError('WEB_INVALID_CURSOR', '网页续读游标无效，请从 cursor: 0 重新读取')
    if (signal.aborted) throw new AppServiceError('WEB_CANCELLED', '网页读取已取消')
    this.prune()
    const pointer = this.cursors.get(token)
    const entry = pointer ? this.sessions.get(pointer.sessionId) : undefined
    if (!pointer || !entry)
      throw new AppServiceError('WEB_CURSOR_EXPIRED', '网页续读游标已过期，请从 cursor: 0 重新读取')
    const session = entry.session
    if (session.requestUrl !== requestUrl || session.render !== render || session.scroll !== scroll)
      throw new AppServiceError('WEB_INVALID_CURSOR', '游标与网页读取参数不匹配')
    this.touch(pointer.sessionId)
    pointer.promise ??= pointer.run(signal)
    return withSignal(pointer.promise, signal)
  }

  get(id: string): WebReadSession {
    const entry = this.sessions.get(id)
    if (!entry) throw new AppServiceError('WEB_CURSOR_EXPIRED', '网页续读会话已失效')
    return entry.session
  }

  async closeBrowser(id: string): Promise<void> {
    const entry = this.sessions.get(id)
    if (!entry?.session.browser) return
    const browser = entry.session.browser
    entry.session.browser = null
    this.totalBytes -= entry.bytes
    entry.session.seen.clear()
    entry.bytes = this.sizeOf(entry.session)
    this.totalBytes += entry.bytes
    await browser.close()
  }

  async dispose(): Promise<void> {
    const browsers = [...this.sessions.values()].map((entry) => entry.session.browser)
    for (const id of [...this.sessions.keys()]) this.remove(id)
    await Promise.all(browsers.map((browser) => browser?.close()))
  }

  private sizeOf(session: WebReadSession): number {
    let bytes = JSON.stringify(session.snapshot).length * 2
    for (const key of session.seen) bytes += key.length * 2
    return bytes
  }

  private expiry(session: WebReadSession, createdAt: number, now: number): number {
    return session.scroll
      ? Math.min(createdAt + SCROLL_LIFETIME_MS, now + SCROLL_IDLE_MS)
      : now + STATIC_IDLE_MS
  }

  private touch(id: string): void {
    const entry = this.sessions.get(id)
    if (!entry) return
    const now = this.now()
    entry.expiresAt = this.expiry(entry.session, entry.createdAt, now)
    clearTimeout(entry.timer)
    entry.timer = setTimeout(() => this.remove(id), Math.max(0, entry.expiresAt - now))
    entry.timer.unref?.()
    this.sessions.delete(id)
    this.sessions.set(id, entry)
  }

  private prune(): void {
    const now = this.now()
    for (const [id, entry] of this.sessions) if (entry.expiresAt <= now) this.remove(id)
  }

  private remove(id: string): void {
    const entry = this.sessions.get(id)
    if (!entry) return
    clearTimeout(entry.timer)
    for (const token of entry.tokens) this.cursors.delete(token)
    this.sessions.delete(id)
    this.totalBytes -= entry.bytes
    void entry.session.browser?.close()
  }
}
