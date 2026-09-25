import { setTimeout as delay } from 'node:timers/promises'
import { AppServiceError } from './errors'
import { BrowserReader } from './web-browser'
import {
  WebPageCache,
  type WebPageSnapshot,
  type WebReadSession,
  type WebRenderMode,
} from './web-page-cache'
import type { WebScrollCapture } from './web-scroll'
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
  scroll?: boolean
  cursor?: 0 | string
}

export interface WebPageResult {
  sourceUrl: string
  finalUrl: string
  fetchedAt: number
  title: string | null
  description: string | null
  text: string
  nextCursor: string | null
  headings: Array<{ level: number; text: string }>
  links: Array<{ text: string; url: string }>
  incompleteReason: string | null
  warnings: string[]
}

const CHUNK_LENGTH = 20_000
const RESULT_LENGTH = 45_000
const MAX_SCROLL_STEPS = 200

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

function budgetFor(
  signal: AbortSignal,
  requests = 0,
  bytes = 0,
): { budget: WebBudget; dispose: () => void } {
  const controller = new AbortController()
  const abort = () => controller.abort(new AppServiceError('WEB_CANCELLED', '网页读取已取消'))
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  const timer = setTimeout(
    () => controller.abort(new AppServiceError('WEB_TIMEOUT', '网页读取超时')),
    45_000,
  )
  return {
    budget: { signal: controller.signal, requests, bytes },
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

function capturedPage(capture: WebScrollCapture, seen: Set<string>): ParsedWebPage {
  const blocks = capture.blocks.filter((block) => {
    const key = `block\n${block.links[0]?.url ?? ''}\n${block.text}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const links = new Map<string, { text: string; url: string }>()
  for (const block of blocks)
    for (const link of block.links) {
      const key = `link\n${link.url}`
      if (seen.has(key)) continue
      seen.add(key)
      links.set(key, link)
    }
  const headings = capture.headings.filter((heading) => {
    const key = `heading\n${heading.level}\n${heading.text}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return {
    title: capture.title,
    description: capture.description,
    text: blocks.map((block) => block.text).join(' '),
    headings,
    links: [...links.values()],
    appearsDynamic: false,
  }
}

export class WebRetrievalService {
  constructor(
    private readonly network = new WebNetwork(),
    private readonly cache = new WebPageCache(),
  ) {}

  async dispose(): Promise<void> {
    await this.cache.dispose()
  }

  async read(input: WebPageInput, signal: AbortSignal): Promise<WebPageResult> {
    const requestUrl = validateWebUrl(input.url).href
    const render = input.render ?? 'auto'
    const scroll = input.scroll ?? false
    if (scroll && render === 'static')
      throw new AppServiceError('VALIDATION_ERROR', '滚动读取需要动态渲染')
    if (signal.aborted) throw webAbortError(signal)
    if (input.cursor !== undefined && input.cursor !== 0)
      return this.cache.resolve(input.cursor, requestUrl, render, scroll, signal)
    const scope = budgetFor(signal)
    let browser: BrowserReader | null = null
    try {
      let parsed: ParsedWebPage
      let finalUrl: string
      let incompleteReason: string | null = null
      const warnings: string[] = []
      const seen = new Set<string>()
      let canScroll = false
      if (scroll) {
        browser = await retryTransient(
          () => BrowserReader.open(requestUrl, this.network, scope.budget),
          scope.budget,
          'render',
        )
        const capture = await browser.capture()
        parsed = capturedPage(capture, seen)
        finalUrl = browser.finalUrl
        canScroll = capture.scrollable
        if (capture.overflow) incompleteReason = '网页当前批次内容超过可可靠提取的大小上限'
        if (browser.status.queryError) incompleteReason = browser.status.queryError.message
        if (browser.status.blockedDataRequest)
          incompleteReason = '页面尝试调用未核实的同站 POST 接口，后续内容可能缺失'
        if (browser.status.heuristicQueryUsed)
          warnings.push('已执行同站查询型 POST；无法证明网站端没有记录或其他副作用')
        if (browser.status.resourceError)
          warnings.push(`部分动态资源加载失败：${browser.status.resourceError.message}`)
        if (
          browser.status.resourceError &&
          ['WEB_TOO_LARGE', 'WEB_TIMEOUT'].includes(browser.status.resourceError.code)
        )
          incompleteReason = browser.status.resourceError.message
      } else {
        const page = await this.page(requestUrl, scope.budget, render)
        parsed = page.parsed
        finalUrl = page.finalUrl
        incompleteReason = page.issue
        warnings.push(...page.warnings)
      }
      if (!incompleteReason && !parsed.text.trim() && !parsed.links.length)
        incompleteReason = '未能可靠提取网页正文'
      if (incompleteReason) warnings.push(incompleteReason)
      const snapshot: WebPageSnapshot = {
        sourceUrl: input.url,
        requestUrl,
        render,
        scroll,
        finalUrl,
        fetchedAt: Date.now(),
        parsed,
        incompleteReason,
        warnings,
      }
      const session: WebReadSession = {
        requestUrl,
        render,
        scroll,
        snapshot,
        browser: canScroll && !incompleteReason ? browser : null,
        seen,
        steps: 0,
        requests: scope.budget.requests,
        bytes: scope.budget.bytes,
      }
      if (!session.browser) {
        session.seen.clear()
        await browser?.close()
        browser = null
      }
      const first = this.result(snapshot, 0, 0, 0, null)
      const needsCursor =
        !!session.browser ||
        first.text.length < parsed.text.length ||
        first.links.length < parsed.links.length ||
        first.headings.length < parsed.headings.length
      if (!needsCursor) return first
      let id: string
      try {
        id = this.cache.store(session)
      } catch (error) {
        snapshot.incompleteReason =
          error instanceof AppServiceError ? error.message : '网页续读缓存超过上限'
        snapshot.warnings.push(snapshot.incompleteReason)
        return this.result(snapshot, 0, 0, 0, null)
      }
      browser = null
      return this.result(snapshot, 0, 0, 0, id)
    } finally {
      scope.dispose()
      await browser?.close()
    }
  }

  private result(
    snapshot: WebPageSnapshot,
    textStart: number,
    linkStart: number,
    headingStart: number,
    id: string | null,
  ): WebPageResult {
    let textEnd = chunkEnd(snapshot.parsed.text, textStart)
    let linkEnd = Math.min(linkStart + 50, snapshot.parsed.links.length)
    let headingEnd = Math.min(headingStart + 30, snapshot.parsed.headings.length)
    const result: WebPageResult = {
      sourceUrl: snapshot.sourceUrl,
      finalUrl: snapshot.finalUrl,
      fetchedAt: snapshot.fetchedAt,
      title: snapshot.parsed.title,
      description: snapshot.parsed.description,
      text: snapshot.parsed.text.slice(textStart, textEnd),
      nextCursor: id ? `wr_${'0'.repeat(36)}` : null,
      headings: snapshot.parsed.headings.slice(headingStart, headingEnd),
      links: snapshot.parsed.links.slice(linkStart, linkEnd),
      incompleteReason: snapshot.incompleteReason,
      warnings: [...snapshot.warnings],
    }
    while (JSON.stringify(result).length > RESULT_LENGTH && result.links.length) {
      result.links.pop()
      linkEnd--
    }
    while (JSON.stringify(result).length > RESULT_LENGTH && result.headings.length) {
      result.headings.pop()
      headingEnd--
    }
    while (JSON.stringify(result).length > RESULT_LENGTH && textEnd > textStart + 1) {
      textEnd = textStart + Math.floor((textEnd - textStart) / 2)
      if (
        textEnd < snapshot.parsed.text.length &&
        snapshot.parsed.text.charCodeAt(textEnd - 1) >= 0xd800 &&
        snapshot.parsed.text.charCodeAt(textEnd - 1) <= 0xdbff
      )
        textEnd--
      result.text = snapshot.parsed.text.slice(textStart, textEnd)
    }
    if (JSON.stringify(result).length > RESULT_LENGTH)
      throw new AppServiceError('WEB_TOO_LARGE', '网页结果元数据超过输出上限')
    if (id) {
      const moreInBatch =
        textEnd < snapshot.parsed.text.length ||
        linkEnd < snapshot.parsed.links.length ||
        headingEnd < snapshot.parsed.headings.length
      if (moreInBatch)
        result.nextCursor = this.cache.cursor(id, async () =>
          this.result(snapshot, textEnd, linkEnd, headingEnd, id),
        )
      else if (this.cache.get(id).browser)
        result.nextCursor = this.cache.cursor(id, (signal) => this.advance(id, signal))
      else result.nextCursor = null
    }
    return result
  }

  private async advance(id: string, signal: AbortSignal): Promise<WebPageResult> {
    const session = this.cache.get(id)
    const browser = session.browser
    if (!browser || browser.isClosed)
      throw new AppServiceError('WEB_CURSOR_EXPIRED', '网页滚动会话已失效，请重新读取')
    const scope = budgetFor(signal, session.requests, session.bytes)
    const warnings: string[] = []
    let incompleteReason: string | null = null
    let parsed: ParsedWebPage | null = null
    let atBottomWithoutNew = 0
    let finished = false
    try {
      await browser.withBudget(scope.budget, async () => {
        for (let index = 0; index < 12; index++) {
          const beforeCapture = await browser.capture()
          const before = capturedPage(beforeCapture, session.seen)
          if (beforeCapture.overflow) {
            parsed = before
            incompleteReason = '网页当前批次内容超过可可靠提取的大小上限'
            finished = true
            break
          }
          if (before.text || before.links.length || before.headings.length) {
            parsed = before
            break
          }
          if (session.steps >= MAX_SCROLL_STEPS) {
            incompleteReason = '网页滚动次数达到上限，后续内容尚未核实'
            finished = true
            break
          }
          const movement = await browser.scrollOnce()
          session.steps++
          let current: ParsedWebPage | null = null
          for (let poll = 0; poll < 12; poll++) {
            await delay(250, undefined, { signal: scope.budget.signal })
            const capture = await browser.capture()
            current = capturedPage(capture, session.seen)
            if (capture.overflow) {
              incompleteReason = '网页当前批次内容超过可可靠提取的大小上限'
              finished = true
            }
            if (current.text || current.links.length || current.headings.length) break
            if (finished) break
            if (browser.status.queryError || browser.status.blockedDataRequest) break
            if (movement.moved && !movement.atBottom && poll >= 1) break
          }
          if (current?.text || current?.links.length || current?.headings.length) {
            parsed = current
            break
          }
          if (finished) break
          if (browser.status.queryError || browser.status.blockedDataRequest) {
            incompleteReason =
              browser.status.queryError?.message ?? '页面后续内容依赖未核实的 POST 请求'
            finished = true
            break
          }
          if (movement.atBottom || !movement.moved) atBottomWithoutNew++
          else atBottomWithoutNew = 0
          if (atBottomWithoutNew >= 2) {
            finished = true
            if (browser.status.pending)
              incompleteReason = '网页仍有未完成的资源请求，后续内容尚未核实'
            else warnings.push('已到达可观察的列表末尾，无法证明网站不存在其他内容')
            break
          }
        }
      })
      if (browser.status.resourceError)
        warnings.push(`部分动态资源加载失败：${browser.status.resourceError.message}`)
      if (
        browser.status.resourceError &&
        ['WEB_TOO_LARGE', 'WEB_TIMEOUT'].includes(browser.status.resourceError.code)
      )
        incompleteReason ??= browser.status.resourceError.message
      if (browser.status.heuristicQueryUsed)
        warnings.push('已执行同站查询型 POST；无法证明网站端没有记录或其他副作用')
      if (browser.status.blockedDataRequest)
        incompleteReason ??= '页面尝试调用未核实的同站 POST 接口，后续内容可能缺失'
      if (browser.status.queryError) incompleteReason ??= browser.status.queryError.message
      if (incompleteReason) finished = true
    } catch (error) {
      if (scope.budget.signal.aborted) {
        await this.cache.closeBrowser(id)
        throw webAbortError(scope.budget.signal)
      }
      incompleteReason =
        error instanceof AppServiceError ? error.message : '网页滚动或解析失败，后续内容尚未核实'
      finished = true
    } finally {
      session.requests = scope.budget.requests
      session.bytes = scope.budget.bytes
      scope.dispose()
    }
    const snapshot: WebPageSnapshot = {
      ...session.snapshot,
      finalUrl: browser.isClosed ? session.snapshot.finalUrl : browser.finalUrl,
      fetchedAt: Date.now(),
      parsed: parsed ?? {
        title: session.snapshot.parsed.title,
        description: session.snapshot.parsed.description,
        text: '',
        links: [],
        headings: [],
        appearsDynamic: false,
      },
      incompleteReason,
      warnings: incompleteReason ? [...warnings, incompleteReason] : warnings,
    }
    let resultId: string | null = id
    try {
      this.cache.update(id, snapshot)
    } catch (error) {
      snapshot.incompleteReason =
        error instanceof AppServiceError ? error.message : '网页续读缓存超过上限'
      snapshot.warnings.push(snapshot.incompleteReason)
      finished = true
      await this.cache.closeBrowser(id)
      try {
        this.cache.update(id, snapshot)
      } catch {
        resultId = null
      }
    }
    if (finished) await this.cache.closeBrowser(id)
    return this.result(snapshot, 0, 0, 0, resultId)
  }

  private async page(
    input: string,
    budget: WebBudget,
    render: WebRenderMode,
  ): Promise<{
    parsed: ParsedWebPage
    finalUrl: string
    warnings: string[]
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
    let issue: string | null = null
    if (render === 'dynamic' || (render === 'auto' && parsed.appearsDynamic)) {
      try {
        const dynamic = await retryTransient(
          async () => {
            const browser = await BrowserReader.open(finalUrl, this.network, budget)
            try {
              const html = await browser.html()
              const next = parsePage(html, browser.finalUrl)
              if (browser.status.queryError) throw browser.status.queryError
              if (browser.status.resourceError && !next.text.trim())
                throw browser.status.resourceError
              return { parsed: next, finalUrl: browser.finalUrl, status: browser.status }
            } finally {
              await browser.close()
            }
          },
          budget,
          'render',
        )
        finalUrl = dynamic.finalUrl
        parsed = dynamic.parsed
        if (dynamic.status.resourceError)
          warnings.push(
            `部分动态资源加载失败，结果可能不完整：${dynamic.status.resourceError.message}。`,
          )
        if (dynamic.status.heuristicQueryUsed)
          warnings.push('已执行同站查询型 POST；无法证明网站端没有记录或其他副作用')
        if (dynamic.status.blockedDataRequest) {
          warnings.push('页面尝试调用未核实的同站 POST 接口；这些请求已被拦截。')
          issue = '网页内容可能依赖暂不支持的查询请求'
        }
      } catch (error) {
        if (budget.signal.aborted) throw webAbortError(budget.signal)
        if (render === 'dynamic') throw error
        warnings.push(
          `动态页面渲染失败，结果仅依据服务器返回的 HTML：${error instanceof AppServiceError ? error.message : '浏览器无法加载页面'}。`,
        )
        if (error instanceof AppServiceError) issue = error.message
      }
    }
    return { parsed, finalUrl, warnings, issue }
  }
}
