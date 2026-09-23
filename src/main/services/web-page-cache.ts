import { randomUUID } from 'node:crypto'
import { AppServiceError } from './errors'
import type { ParsedWebPage } from './web-parser'

export type WebRenderMode = 'auto' | 'static' | 'dynamic'

export interface WebPageSnapshot {
  sourceUrl: string
  requestUrl: string
  render: WebRenderMode
  finalUrl: string
  fetchedAt: number
  parsed: ParsedWebPage
  incompleteReason: string | null
  warnings: string[]
}

interface CacheEntry {
  snapshot: WebPageSnapshot
  bytes: number
  expiresAt: number
  cursors: Map<number, string>
}

const IDLE_TTL_MS = 10 * 60_000
const MAX_ENTRIES = 8
const MAX_BYTES = 32 * 1024 * 1024
const CURSOR_PATTERN = /^wp_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class WebPageCache {
  private readonly entries = new Map<string, CacheEntry>()
  private readonly cursors = new Map<string, { id: string; offset: number }>()
  private totalBytes = 0

  constructor(
    private readonly now: () => number = Date.now,
    private readonly limits = { maxEntries: MAX_ENTRIES, maxBytes: MAX_BYTES },
  ) {}

  store(snapshot: WebPageSnapshot): string {
    this.prune()
    const bytes = JSON.stringify(snapshot).length * 2
    if (bytes > this.limits.maxBytes)
      throw new AppServiceError('WEB_TOO_LARGE', '网页解析结果超过续读缓存上限')
    while (
      this.entries.size >= this.limits.maxEntries ||
      this.totalBytes + bytes > this.limits.maxBytes
    ) {
      const oldest = this.entries.keys().next().value
      if (!oldest) break
      this.remove(oldest)
    }
    const id = randomUUID()
    this.entries.set(id, {
      snapshot,
      bytes,
      expiresAt: this.now() + IDLE_TTL_MS,
      cursors: new Map(),
    })
    this.totalBytes += bytes
    return id
  }

  cursor(id: string, offset: number): string {
    const entry = this.entries.get(id)
    if (
      !entry ||
      !Number.isSafeInteger(offset) ||
      offset <= 0 ||
      offset >= entry.snapshot.parsed.text.length
    )
      throw new AppServiceError('WEB_CURSOR_EXPIRED', '网页续读游标已失效，请从 cursor: 0 重新读取')
    const existing = entry.cursors.get(offset)
    if (existing) return existing
    const token = `wp_${randomUUID()}`
    entry.cursors.set(offset, token)
    this.cursors.set(token, { id, offset })
    return token
  }

  resolve(
    token: string,
    requestUrl: string,
    render: WebRenderMode,
  ): { id: string; offset: number; snapshot: WebPageSnapshot } {
    if (!CURSOR_PATTERN.test(token))
      throw new AppServiceError('WEB_INVALID_CURSOR', '网页续读游标无效，请从 cursor: 0 重新读取')
    this.prune()
    const pointer = this.cursors.get(token)
    const entry = pointer ? this.entries.get(pointer.id) : undefined
    if (!pointer || !entry)
      throw new AppServiceError('WEB_CURSOR_EXPIRED', '网页续读游标已过期，请从 cursor: 0 重新读取')
    if (entry.snapshot.requestUrl !== requestUrl || entry.snapshot.render !== render)
      throw new AppServiceError(
        'WEB_INVALID_CURSOR',
        '游标与网页地址或渲染模式不匹配，请从 cursor: 0 重新读取',
      )
    this.entries.delete(pointer.id)
    entry.expiresAt = this.now() + IDLE_TTL_MS
    this.entries.set(pointer.id, entry)
    return { id: pointer.id, offset: pointer.offset, snapshot: entry.snapshot }
  }

  private prune(): void {
    const now = this.now()
    for (const [id, entry] of this.entries) if (entry.expiresAt <= now) this.remove(id)
  }

  private remove(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    for (const token of entry.cursors.values()) this.cursors.delete(token)
    this.entries.delete(id)
    this.totalBytes -= entry.bytes
  }
}
