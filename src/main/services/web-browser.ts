import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'playwright'
import { AppServiceError } from './errors'
import { captureWebScroll, scrollWebPage, type WebScrollCapture } from './web-scroll'
import type { WebBudget } from './web-network'
import {
  WebNetwork,
  decodeWebText,
  isHtmlResponse,
  validateWebUrl,
  webAbortError,
} from './web-network'
import { approveWebQueryPost, type WebQueryPost } from './web-query-policy'

let activeBrowsers = 0
const waiters: Array<() => void> = []
const readers = new Set<BrowserReader>()

async function acquire(signal: AbortSignal): Promise<() => void> {
  if (signal.aborted) throw webAbortError(signal)
  if (activeBrowsers >= 2) {
    const idle = [...readers].find((reader) => !reader.busy)
    if (idle) await idle.close()
  }
  if (activeBrowsers < 2) activeBrowsers++
  else
    await new Promise<void>((resolve, reject) => {
      const resume = () => {
        signal.removeEventListener('abort', abort)
        resolve()
      }
      const abort = () => {
        const index = waiters.indexOf(resume)
        if (index >= 0) waiters.splice(index, 1)
        reject(webAbortError(signal))
      }
      waiters.push(resume)
      signal.addEventListener('abort', abort, { once: true })
    })
  let released = false
  return () => {
    if (released) return
    released = true
    const next = waiters.shift()
    if (next) next()
    else activeBrowsers--
  }
}

function executablePath(): string | undefined {
  const packaged = path.join(
    path.dirname(process.execPath),
    'resources',
    'browser',
    'chrome-headless-shell.exe',
  )
  return fs.existsSync(packaged) ? packaged : undefined
}

export class BrowserReader {
  readonly page: Page
  busy = true
  private closed = false
  private closePromise: Promise<void> | null = null
  private budget: WebBudget | null = null
  private navigationFinalUrl: string
  private resourceError: AppServiceError | null = null
  private queryError: AppServiceError | null = null
  private blockedDataRequest = false
  private heuristicQueryUsed = false
  private pending = 0

  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    page: Page,
    private readonly network: WebNetwork,
    private readonly release: () => void,
    url: string,
  ) {
    this.page = page
    this.navigationFinalUrl = url
  }

  static async open(url: string, network: WebNetwork, budget: WebBudget): Promise<BrowserReader> {
    const release = await acquire(budget.signal)
    if (budget.signal.aborted) {
      release()
      throw webAbortError(budget.signal)
    }
    let browser: Browser | undefined
    try {
      browser = await chromium.launch({
        headless: true,
        executablePath: executablePath(),
        args: [
          '--disable-quic',
          '--disable-background-networking',
          '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        ],
      })
      const context = await browser.newContext({
        serviceWorkers: 'block',
        acceptDownloads: false,
        javaScriptEnabled: true,
        bypassCSP: false,
      })
      await context.addInitScript(() => {
        document.addEventListener('submit', (event) => event.preventDefault(), true)
        HTMLFormElement.prototype.submit = () => undefined
      })
      const page = await context.newPage()
      const reader = new BrowserReader(browser, context, page, network, release, url)
      readers.add(reader)
      await context.routeWebSocket('**/*', (socket) => socket.close())
      await context.route('**/*', (route) => reader.route(route))
      page.on('popup', (popup) => void popup.close())
      await reader.withBudget(budget, async () => {
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 })
        } catch (error) {
          throw reader.resourceError ?? error
        }
        await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined)
        if (budget.signal.aborted) throw webAbortError(budget.signal)
        await delay(500, undefined, { signal: budget.signal })
        if (reader.resourceError?.code === 'WEB_TOO_LARGE') throw reader.resourceError
        validateWebUrl(page.url())
      })
      return reader
    } catch (error) {
      const reader = [...readers].find((item) => item.browser === browser)
      if (reader) await reader.close()
      else {
        await browser?.close().catch(() => undefined)
        release()
      }
      if (budget.signal.aborted) throw webAbortError(budget.signal)
      if (error instanceof AppServiceError) throw error
      throw new AppServiceError('WEB_UNAVAILABLE', '动态网页渲染失败', {
        stage: 'render',
        retryable: false,
      })
    }
  }

  get isClosed(): boolean {
    return this.closed
  }

  get finalUrl(): string {
    const url = this.page.url()
    return url === 'about:blank' ? this.navigationFinalUrl : validateWebUrl(url).href
  }

  get status(): {
    resourceError: AppServiceError | null
    queryError: AppServiceError | null
    blockedDataRequest: boolean
    heuristicQueryUsed: boolean
    pending: number
  } {
    return {
      resourceError: this.resourceError,
      queryError: this.queryError,
      blockedDataRequest: this.blockedDataRequest,
      heuristicQueryUsed: this.heuristicQueryUsed,
      pending: this.pending,
    }
  }

  async withBudget<T>(budget: WebBudget, operation: () => Promise<T>): Promise<T> {
    if (this.closed) throw new AppServiceError('WEB_CURSOR_EXPIRED', '网页浏览器会话已关闭')
    if (budget.signal.aborted) {
      await this.close()
      throw webAbortError(budget.signal)
    }
    this.busy = true
    this.budget = budget
    this.resourceError = null
    this.queryError = null
    this.heuristicQueryUsed = false
    const abort = () => void this.close()
    budget.signal.addEventListener('abort', abort, { once: true })
    try {
      return await operation()
    } finally {
      this.budget = null
      this.busy = false
      budget.signal.removeEventListener('abort', abort)
      if (!this.closed) {
        readers.delete(this)
        readers.add(this)
      }
    }
  }

  async html(): Promise<string> {
    const html = await this.page.content()
    if (Buffer.byteLength(html) > 4 * 1024 * 1024)
      throw new AppServiceError('WEB_TOO_LARGE', '渲染后的网页超过大小上限')
    return html
  }

  async capture(): Promise<WebScrollCapture> {
    return captureWebScroll(this.page)
  }

  async scrollOnce(): Promise<{ moved: boolean; atBottom: boolean }> {
    return scrollWebPage(this.page)
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closed = true
    readers.delete(this)
    this.closePromise = (async () => {
      try {
        await this.context.close().catch(() => undefined)
        await this.browser.close().catch(() => undefined)
      } finally {
        this.release()
      }
    })()
    return this.closePromise
  }

  private async route(route: Route): Promise<void> {
    let query: WebQueryPost | null = null
    this.pending++
    try {
      const budget = this.budget
      if (!budget || this.closed) {
        await route.abort()
        return
      }
      const request = route.request()
      if (['image', 'media', 'font'].includes(request.resourceType())) {
        await route.abort()
        return
      }
      const target = validateWebUrl(request.url())
      const method = request.method()
      const isMainNavigation =
        request.isNavigationRequest() && request.frame() === this.page.mainFrame()
      query = ['fetch', 'xhr'].includes(request.resourceType())
        ? approveWebQueryPost(
            this.navigationFinalUrl,
            target.href,
            method,
            request.postData(),
            request.headers()['content-type'],
          )
        : null
      if (method !== 'GET' && method !== 'HEAD' && !query) {
        if (
          target.origin === new URL(this.navigationFinalUrl).origin &&
          ['fetch', 'xhr'].includes(request.resourceType())
        )
          this.blockedDataRequest = true
        await route.abort()
        return
      }
      if (query?.assurance === 'heuristic') this.heuristicQueryUsed = true
      const response = query
        ? await this.network.requestQuery(query, budget)
        : await this.network.request(target.href, budget, method as 'GET' | 'HEAD')
      if (isMainNavigation && response.status >= 400)
        throw new AppServiceError(
          [401, 403].includes(response.status) ? 'WEB_BLOCKED' : 'WEB_UNAVAILABLE',
          `动态网页返回 HTTP ${response.status}`,
          {
            stage: 'render',
            httpStatus: response.status,
            retryable: [408, 429, 500, 502, 503, 504].includes(response.status),
          },
        )
      if (isMainNavigation) this.navigationFinalUrl = response.url
      if (query?.requiredForContent && response.status >= 400)
        this.queryError ??= new AppServiceError(
          [401, 403].includes(response.status) ? 'WEB_BLOCKED' : 'WEB_UNAVAILABLE',
          `网页只读查询接口返回 HTTP ${response.status}`,
          {
            stage: 'fetch',
            httpStatus: response.status,
            retryable: [408, 429, 500, 502, 503, 504].includes(response.status),
          },
        )
      if ([408, 429, 500, 502, 503, 504].includes(response.status))
        this.resourceError ??= new AppServiceError(
          'WEB_UNAVAILABLE',
          `动态资源返回 HTTP ${response.status}`,
          {
            stage: 'resource',
            httpStatus: response.status,
            retryable: true,
          },
        )
      else if ([401, 403].includes(response.status))
        this.resourceError ??= new AppServiceError(
          'WEB_BLOCKED',
          `动态资源返回 HTTP ${response.status}`,
          {
            stage: 'resource',
            httpStatus: response.status,
            retryable: false,
          },
        )
      const html = isHtmlResponse(response)
      await route.fulfill({
        status: response.status,
        body: html ? Buffer.from(decodeWebText(response)) : response.body,
        contentType: `${html ? 'text/html' : response.contentType || 'text/plain'}; charset=${html ? 'utf-8' : (response.charset ?? 'utf-8')}`,
      })
    } catch (error) {
      this.resourceError ??=
        error instanceof AppServiceError
          ? error
          : new AppServiceError('WEB_UNAVAILABLE', '部分动态资源加载失败', {
              stage: 'resource',
              retryable: false,
            })
      if (query?.requiredForContent) this.queryError ??= this.resourceError
      await route.abort().catch(() => undefined)
    } finally {
      this.pending--
    }
  }
}
