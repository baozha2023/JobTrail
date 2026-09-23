import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'
import { AppServiceError } from './errors'
import type { WebBudget } from './web-network'
import {
  WebNetwork,
  decodeWebText,
  isHtmlResponse,
  validateWebUrl,
  webAbortError,
} from './web-network'
import { approveReadOnlyQuery, type ReadOnlyWebQuery } from './web-query-policy'

let activeBrowsers = 0
const waiters: Array<() => void> = []

async function acquire(signal: AbortSignal): Promise<() => void> {
  if (signal.aborted) throw webAbortError(signal)
  const release = () => {
    const next = waiters.shift()
    if (next) next()
    else activeBrowsers--
  }
  if (activeBrowsers >= 2) {
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
    if (signal.aborted) {
      release()
      throw webAbortError(signal)
    }
  } else activeBrowsers++
  return release
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

export async function renderWebPage(
  url: string,
  network: WebNetwork,
  budget: WebBudget,
): Promise<{
  html: string
  finalUrl: string
  resourceError: AppServiceError | null
  blockedDataRequest: boolean
  queryError: AppServiceError | null
}> {
  const release = await acquire(budget.signal)
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
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
    const closing = () => void browser?.close()
    budget.signal.addEventListener('abort', closing, { once: true })
    try {
      let routeError: unknown
      let queryError: AppServiceError | null = null
      let navigationFinalUrl = url
      let blockedDataRequest = false
      await context.routeWebSocket('**/*', (socket) => socket.close())
      await context.route('**/*', async (route) => {
        let query: ReadOnlyWebQuery | null = null
        try {
          const request = route.request()
          if (['image', 'media', 'font'].includes(request.resourceType())) {
            await route.abort()
            return
          }
          const target = validateWebUrl(request.url())
          const method = request.method()
          query = approveReadOnlyQuery(navigationFinalUrl, target.href, method, request.postData())
          if (method !== 'GET' && method !== 'HEAD' && !query) {
            if (
              target.origin === new URL(navigationFinalUrl).origin &&
              ['fetch', 'xhr'].includes(request.resourceType())
            )
              blockedDataRequest = true
            await route.abort()
            return
          }
          const response = query
            ? await network.requestQuery(query, budget)
            : await network.request(target.href, budget, method as 'GET' | 'HEAD')
          if (request.isNavigationRequest() && response.status >= 400)
            throw new AppServiceError(
              response.status === 401 || response.status === 403
                ? 'WEB_BLOCKED'
                : 'WEB_UNAVAILABLE',
              `动态网页返回 HTTP ${response.status}`,
              {
                stage: 'render',
                httpStatus: response.status,
                retryable: [408, 429, 500, 502, 503, 504].includes(response.status),
              },
            )
          if (request.isNavigationRequest()) navigationFinalUrl = response.url
          if (query?.requiredForContent && response.status >= 400)
            queryError ??= new AppServiceError(
              [401, 403].includes(response.status) ? 'WEB_BLOCKED' : 'WEB_UNAVAILABLE',
              `网页只读查询接口返回 HTTP ${response.status}`,
              {
                stage: 'fetch',
                httpStatus: response.status,
                retryable: [408, 429, 500, 502, 503, 504].includes(response.status),
              },
            )
          if ([408, 429, 500, 502, 503, 504].includes(response.status))
            routeError ??= new AppServiceError(
              'WEB_UNAVAILABLE',
              `动态资源返回 HTTP ${response.status}`,
              { stage: 'resource', httpStatus: response.status, retryable: true },
            )
          else if ([401, 403].includes(response.status))
            routeError ??= new AppServiceError(
              'WEB_BLOCKED',
              `动态资源返回 HTTP ${response.status}`,
              { stage: 'resource', httpStatus: response.status, retryable: false },
            )
          const html = isHtmlResponse(response)
          await route.fulfill({
            status: response.status,
            body: html ? Buffer.from(decodeWebText(response)) : response.body,
            contentType: `${html ? 'text/html' : response.contentType || 'text/plain'}; charset=${html ? 'utf-8' : (response.charset ?? 'utf-8')}`,
          })
        } catch (error) {
          routeError ??= error
          if (query?.requiredForContent)
            queryError ??=
              error instanceof AppServiceError
                ? error
                : new AppServiceError('WEB_UNAVAILABLE', '只读查询接口请求失败', {
                    stage: 'fetch',
                    retryable: false,
                  })
          await route.abort().catch(() => undefined)
        }
      })
      const page = await context.newPage()
      page.on('popup', (popup) => void popup.close())
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 })
      } catch (error) {
        throw routeError ?? error
      }
      try {
        await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined)
        if (budget.signal.aborted) throw webAbortError(budget.signal)
        await delay(500, undefined, { signal: budget.signal })
      } catch {
        throw webAbortError(budget.signal)
      }
      if (
        routeError instanceof AppServiceError &&
        ['WEB_TOO_LARGE', 'WEB_TIMEOUT'].includes(routeError.code)
      )
        throw routeError
      const html = await page.content()
      if (Buffer.byteLength(html) > 4 * 1024 * 1024)
        throw new AppServiceError('WEB_TOO_LARGE', '渲染后的网页超过大小上限')
      const finalUrl = page.url() === url ? navigationFinalUrl : page.url()
      validateWebUrl(finalUrl)
      return {
        html,
        finalUrl,
        resourceError:
          routeError instanceof AppServiceError
            ? routeError
            : routeError
              ? new AppServiceError('WEB_UNAVAILABLE', '部分动态资源加载失败', {
                  stage: 'resource',
                  retryable: false,
                })
              : null,
        blockedDataRequest,
        queryError,
      }
    } finally {
      budget.signal.removeEventListener('abort', closing)
      await context.close().catch(() => undefined)
    }
  } catch (error) {
    if (budget.signal.aborted) throw webAbortError(budget.signal)
    if (error instanceof AppServiceError) throw error
    throw new AppServiceError('WEB_UNAVAILABLE', '动态网页渲染失败', {
      stage: 'render',
      retryable: false,
    })
  } finally {
    await browser?.close().catch(() => undefined)
    release()
  }
}
