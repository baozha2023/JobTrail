import { setTimeout as delay } from 'node:timers/promises'
import { AppServiceError } from './errors'
import { renderWebPage } from './web-browser'
import { WebPageCache, type WebPageSnapshot, type WebRenderMode } from './web-page-cache'
import {
  WebNetwork,
  decodeWebText,
  isHtmlResponse,
  validateWebUrl,
  webAbortError,
  type WebBudget,
} from './web-network'
import { parseWebPage, type ParsedWebPage } from './web-parser'

export interface WebPageInput {
  url: string
  render?: WebRenderMode
  cursor?: 0 | string
}

type WebPageResult = {
  sourceUrl: string
  finalUrl: string
  fetchedAt: number
  title: string | null
  description: string | null
  text: string
  nextCursor: string | null
  headings: Array<{ level: number; text: string }>
  links: Array<{ text: string; url: string }>
  truncated: boolean
  incompleteReason: string | null
  warnings: string[]
}

const CHUNK_LENGTH = 20_000
const RESULT_LENGTH = 45_000

function chunkEnd(text: string, start: number): number {
  let end = Math.min(start + CHUNK_LENGTH, text.length)
  if (
    end < text.length &&
    end > start &&
    text.charCodeAt(end - 1) >= 0xd800 &&
    text.charCodeAt(end - 1) <= 0xdbff &&
    text.charCodeAt(end) >= 0xdc00 &&
    text.charCodeAt(end) <= 0xdfff
  )
    end--
  return end
}

function budgetFor(signal: AbortSignal): { budget: WebBudget; dispose: () => void } {
  const controller = new AbortController()
  const abort = () => controller.abort(new AppServiceError('WEB_CANCELLED', '网页读取已取消'))
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  const timer = setTimeout(
    () => controller.abort(new AppServiceError('WEB_TIMEOUT', '网页读取超时')),
    45_000,
  )
  return {
    budget: { signal: controller.signal, requests: 0, bytes: 0 },
    dispose: () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    },
  }
}

function parsePage(html: string, url: string): ParsedWebPage {
  try {
    return parseWebPage(html, url)
  } catch {
    throw new AppServiceError('WEB_PARSE_FAILED', '网页解析失败，未能可靠提取内容', {
      stage: 'parse',
      retryable: false,
    })
  }
}

async function retryTransient<T>(
  operation: () => Promise<T>,
  budget: WebBudget,
  stage: 'fetch' | 'render',
): Promise<T> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await operation()
    } catch (error) {
      if (budget.signal.aborted) throw webAbortError(budget.signal)
      if (!(error instanceof AppServiceError)) throw error
      const retryable =
        error.details?.retryable !== false &&
        (error.details?.retryable === true ||
          ['WEB_UNAVAILABLE', 'WEB_TIMEOUT'].includes(error.code))
      if (!retryable || attempt === 2) {
        throw new AppServiceError(error.code, error.message, {
          ...error.details,
          stage: error.details?.stage ?? stage,
          attempts: attempt,
          retryable: false,
          ...(retryable ? { retryExhausted: true, transient: true } : {}),
        })
      }
      try {
        await delay(error.details?.httpStatus === 429 ? 1_500 : 300 * attempt, undefined, {
          signal: budget.signal,
        })
      } catch {
        throw webAbortError(budget.signal)
      }
    }
  }
  throw new AppServiceError('INTERNAL_ERROR', '网页重试流程异常')
}

export class WebRetrievalService {
  constructor(
    private readonly network = new WebNetwork(),
    private readonly cache = new WebPageCache(),
  ) {}

  async read(input: WebPageInput, signal: AbortSignal): Promise<WebPageResult> {
    const requestUrl = validateWebUrl(input.url).href
    const render = input.render ?? 'auto'
    if (signal.aborted) throw webAbortError(signal)
    if (input.cursor !== undefined && input.cursor !== 0) {
      if (typeof input.cursor !== 'string')
        throw new AppServiceError('WEB_INVALID_CURSOR', '网页续读游标无效，请从 cursor: 0 重新读取')
      const { id, offset, snapshot } = this.cache.resolve(input.cursor, requestUrl, render)
      return this.result(snapshot, offset, id)
    }
    const scope = budgetFor(signal)
    try {
      const { parsed, finalUrl, warnings, issue, blockedDataRequest } = await this.page(
        input.url,
        scope.budget,
        render,
      )
      if (scope.budget.signal.aborted) throw webAbortError(scope.budget.signal)
      const incompleteReason =
        issue ??
        (blockedDataRequest && parsed.text.length < 500
          ? '网页主要内容依赖暂不支持的查询请求'
          : parsed.text.trim()
            ? null
            : '未能可靠提取网页正文')
      const snapshot: WebPageSnapshot = {
        sourceUrl: input.url,
        requestUrl,
        render,
        finalUrl,
        fetchedAt: Date.now(),
        parsed,
        incompleteReason,
        warnings: incompleteReason ? [...warnings, incompleteReason] : warnings,
      }
      const id = chunkEnd(parsed.text, 0) < parsed.text.length ? this.cache.store(snapshot) : null
      return this.result(snapshot, 0, id)
    } finally {
      scope.dispose()
    }
  }

  private result(snapshot: WebPageSnapshot, start: number, id: string | null): WebPageResult {
    const end = chunkEnd(snapshot.parsed.text, start)
    const nextCursor = end < snapshot.parsed.text.length && id ? this.cache.cursor(id, end) : null
    const result: WebPageResult = {
      sourceUrl: snapshot.sourceUrl,
      finalUrl: snapshot.finalUrl,
      fetchedAt: snapshot.fetchedAt,
      title: snapshot.parsed.title,
      description: snapshot.parsed.description,
      text: snapshot.parsed.text.slice(start, end),
      nextCursor,
      headings: snapshot.parsed.headings.slice(0, 30),
      links: snapshot.parsed.links.slice(0, 50),
      truncated: nextCursor !== null || snapshot.parsed.links.length > 50,
      incompleteReason: snapshot.incompleteReason,
      warnings: [...snapshot.warnings],
    }
    while (JSON.stringify(result).length > RESULT_LENGTH && result.links.length) {
      result.links.pop()
      result.truncated = true
    }
    while (JSON.stringify(result).length > RESULT_LENGTH && result.headings.length) {
      result.headings.pop()
      result.truncated = true
    }
    if (JSON.stringify(result).length > RESULT_LENGTH)
      throw new AppServiceError('WEB_TOO_LARGE', '网页结果元数据超过输出上限')
    return result
  }

  private async page(
    input: string,
    budget: WebBudget,
    render: WebRenderMode,
  ): Promise<{
    parsed: ParsedWebPage
    finalUrl: string
    warnings: string[]
    blockedDataRequest: boolean
    issue: string | null
  }> {
    const response = await retryTransient(
      async () => {
        const result = await this.network.request(input, budget, 'GET')
        if (result.status >= 400)
          throw new AppServiceError(
            [401, 403].includes(result.status) ? 'WEB_BLOCKED' : 'WEB_UNAVAILABLE',
            `网页返回 HTTP ${result.status}`,
            {
              httpStatus: result.status,
              retryable: [408, 429, 500, 502, 503, 504].includes(result.status),
            },
          )
        return result
      },
      budget,
      'fetch',
    )
    if (!isHtmlResponse(response))
      throw new AppServiceError('WEB_UNSUPPORTED', '目标不是 HTML 网页')
    let finalUrl = response.url
    let parsed = parsePage(decodeWebText(response), finalUrl)
    const warnings: string[] = []
    let blockedDataRequest = false
    let issue: string | null = null
    if (render === 'dynamic' || (render === 'auto' && parsed.appearsDynamic)) {
      try {
        const dynamic = await retryTransient(
          async () => {
            const rendered = await renderWebPage(finalUrl, this.network, budget)
            const dynamicParsed = parsePage(rendered.html, rendered.finalUrl)
            if (rendered.queryError) throw rendered.queryError
            if (rendered.resourceError && !dynamicParsed.text.trim()) throw rendered.resourceError
            return { ...rendered, parsed: dynamicParsed }
          },
          budget,
          'render',
        )
        finalUrl = dynamic.finalUrl
        parsed = dynamic.parsed
        blockedDataRequest = dynamic.blockedDataRequest
        if (dynamic.resourceError)
          warnings.push(`部分动态资源加载失败，结果可能不完整：${dynamic.resourceError.message}。`)
        if (blockedDataRequest)
          warnings.push('页面尝试调用未核实的同站 POST 接口；这些请求已被拦截。')
      } catch (error) {
        if (budget.signal.aborted) throw webAbortError(budget.signal)
        if (render === 'dynamic') throw error
        const retryNote =
          error instanceof AppServiceError && error.details?.retryExhausted
            ? '（已自动重试，仍失败）'
            : ''
        warnings.push(
          `动态页面${error instanceof AppServiceError && error.code === 'WEB_PARSE_FAILED' ? '解析' : '渲染'}失败${retryNote}，结果仅依据服务器返回的 HTML：${error instanceof AppServiceError ? error.message : '浏览器无法加载页面'}。`,
        )
        if (error instanceof AppServiceError) issue = error.message
      }
    }
    return { parsed, finalUrl, warnings, blockedDataRequest, issue }
  }
}
