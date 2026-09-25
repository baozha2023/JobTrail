import dns from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import zlib from 'node:zlib'
import { AppServiceError } from './errors'
import { approveWebQueryPost, type WebQueryPost } from './web-query-policy'

const blockedIpv4 = new net.BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blockedIpv4.addSubnet(address, prefix, 'ipv4')
const blockedIpv6 = new net.BlockList()
for (const [address, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  blockedIpv6.addSubnet(address, prefix, 'ipv6')
const publicIpv6 = new net.BlockList()
publicIpv6.addSubnet('2000::', 3, 'ipv6')
const proxyDnsIpv4 = new net.BlockList()
proxyDnsIpv4.addSubnet('198.18.0.0', 15, 'ipv4')
const PUBLIC_DNS = { address: '1.1.1.1', family: 4 }
const PUBLIC_DNS_CACHE_MS = 60_000
const PUBLIC_DNS_CACHE_LIMIT = 128

export interface WebBudget {
  signal: AbortSignal
  requests: number
  bytes: number
}

export interface WebResponse {
  url: string
  status: number
  contentType: string
  charset?: string
  body: Buffer
}

export function decodeWebText(response: WebResponse): string {
  const prefix = response.body.subarray(0, 2_048).toString('latin1')
  const charset =
    response.charset ?? /<meta[^>]+charset\s*=\s*["']?([a-z0-9_-]+)/i.exec(prefix)?.[1]
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(response.body)
  } catch {
    return response.body.toString('utf8')
  }
}

export function isHtmlResponse(response: WebResponse): boolean {
  if (['text/html', 'application/xhtml+xml'].includes(response.contentType)) return true
  if (
    response.contentType &&
    !['text/plain', 'application/octet-stream'].includes(response.contentType)
  )
    return false
  return /<\s*(?:!doctype\s+html|html|head|body|main|div|script)\b/i.test(
    response.body.subarray(0, 256).toString('latin1'),
  )
}

export function validateWebUrl(value: string): URL {
  if (value.length > 2_048) throw new AppServiceError('WEB_INVALID_URL', '网页地址过长')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new AppServiceError('WEB_INVALID_URL', '网页地址无效')
  }
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && !['80', '443'].includes(url.port)) ||
    !url.hostname ||
    url.hostname.endsWith('.') ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new AppServiceError('WEB_INVALID_URL', '仅允许公开的 HTTP/HTTPS 网页（80/443 端口）')
  return url
}

export function assertPublicAddress(address: string): void {
  const family = net.isIP(address)
  if (
    !family ||
    (family === 4 && blockedIpv4.check(address, 'ipv4')) ||
    (family === 6 && (blockedIpv6.check(address, 'ipv6') || !publicIpv6.check(address, 'ipv6')))
  )
    throw new AppServiceError('WEB_BLOCKED', '网页地址指向不可访问的网络')
}

const USER_AGENT = 'JobTrailWebReader/1.0 (+public-page-reader)'
const MAX_REQUESTS = 100
const MAX_TOTAL_BYTES = 20 * 1024 * 1024
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

export function webAbortError(signal: AbortSignal): AppServiceError {
  return signal.reason instanceof AppServiceError
    ? signal.reason
    : new AppServiceError('WEB_CANCELLED', '网页读取已取消')
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(webAbortError(signal))
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort)
      reject(webAbortError(signal))
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

export class WebNetwork {
  private readonly publicDnsCache = new Map<
    string,
    { expiresAt: number; pending: Promise<Array<{ address: string; family: number }>> }
  >()

  constructor(
    private readonly resolve = (hostname: string) => dns.lookup(hostname, { all: true }),
  ) {}

  async request(
    input: string,
    budget: WebBudget,
    method: 'GET' | 'HEAD' = 'GET',
  ): Promise<WebResponse> {
    return this.send(input, budget, method)
  }

  async requestQuery(query: WebQueryPost, budget: WebBudget): Promise<WebResponse> {
    const body = JSON.stringify(query.body)
    const approved = approveWebQueryPost(query.pageUrl, query.url, 'POST', body, 'application/json')
    if (!approved || approved.assurance !== query.assurance)
      throw new AppServiceError('WEB_BLOCKED', '查询请求不在已核实的只读范围内', {
        stage: 'fetch',
        retryable: false,
      })
    const referer = new URL(query.pageUrl)
    referer.hash = ''
    return this.send(query.url, budget, 'POST', Buffer.from(body), referer.href)
  }

  private async send(
    input: string,
    budget: WebBudget,
    method: 'GET' | 'HEAD' | 'POST',
    body?: Buffer,
    pageUrl?: string,
  ): Promise<WebResponse> {
    let target = input
    for (let redirects = 0; redirects <= 4; redirects++) {
      if (budget.signal.aborted) throw webAbortError(budget.signal)
      if (++budget.requests > MAX_REQUESTS)
        throw new AppServiceError('WEB_TOO_LARGE', '网页请求数量超过上限')
      const url = validateWebUrl(target)
      const hostname = url.hostname.replace(/^\[|\]$/g, '')
      const addresses = await this.resolveAddresses(hostname, budget)
      if (!addresses.length) throw new AppServiceError('WEB_UNAVAILABLE', '无法解析网页域名')
      for (const item of addresses) assertPublicAddress(item.address)
      const address = addresses[0]
      let response: Awaited<ReturnType<WebNetwork['once']>>
      try {
        response = await this.once(url, address, budget, method, body, pageUrl)
      } catch (error) {
        if (budget.signal.aborted) throw webAbortError(budget.signal)
        if (error instanceof AppServiceError) throw error
        throw new AppServiceError('WEB_UNAVAILABLE', '网页连接失败')
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (method === 'POST')
          throw new AppServiceError('WEB_BLOCKED', '只读查询接口发生重定向，已停止请求', {
            stage: 'fetch',
            retryable: false,
          })
        const location = response.headers.location
        if (!location || redirects === 4)
          throw new AppServiceError('WEB_UNAVAILABLE', '网页重定向过多', { retryable: false })
        target = new URL(location, url).href
        continue
      }
      const contentType = String(response.headers['content-type'] ?? '')
      return {
        url: url.href,
        status: response.status,
        contentType: contentType.split(';')[0].toLowerCase(),
        charset: /charset\s*=\s*["']?([a-z0-9_-]+)/i.exec(contentType)?.[1],
        body: response.body,
      }
    }
    throw new AppServiceError('WEB_UNAVAILABLE', '网页重定向过多', { retryable: false })
  }

  private async resolveAddresses(
    hostname: string,
    budget: WebBudget,
  ): Promise<Array<{ address: string; family: number }>> {
    if (net.isIP(hostname)) return [{ address: hostname, family: net.isIP(hostname) }]
    let addresses: Array<{ address: string; family: number }>
    try {
      addresses = await abortable(this.resolve(hostname), budget.signal)
    } catch {
      if (budget.signal.aborted) throw webAbortError(budget.signal)
      throw new AppServiceError('WEB_UNAVAILABLE', '无法解析网页域名')
    }
    if (
      addresses.length > 0 &&
      addresses.every(({ address, family }) => family === 4 && proxyDnsIpv4.check(address, 'ipv4'))
    )
      return abortable(this.cachedPublicDns(hostname, budget), budget.signal)
    return addresses
  }

  private cachedPublicDns(
    hostname: string,
    budget: WebBudget,
  ): Promise<Array<{ address: string; family: number }>> {
    const now = Date.now()
    const cached = this.publicDnsCache.get(hostname)
    if (cached && cached.expiresAt > now) return cached.pending
    for (const [name, entry] of this.publicDnsCache)
      if (entry.expiresAt <= now) this.publicDnsCache.delete(name)
    if (this.publicDnsCache.size >= PUBLIC_DNS_CACHE_LIMIT)
      this.publicDnsCache.delete(this.publicDnsCache.keys().next().value!)
    const pending = this.resolveProxyDns(hostname, budget)
    this.publicDnsCache.set(hostname, { expiresAt: now + PUBLIC_DNS_CACHE_MS, pending })
    void pending.catch(() => {
      if (this.publicDnsCache.get(hostname)?.pending === pending)
        this.publicDnsCache.delete(hostname)
    })
    return pending
  }

  private async resolveProxyDns(
    hostname: string,
    budget: WebBudget,
  ): Promise<Array<{ address: string; family: number }>> {
    for (const [type, family, recordType] of [
      ['A', 4, 1],
      ['AAAA', 6, 28],
    ] as const) {
      if (++budget.requests > MAX_REQUESTS)
        throw new AppServiceError('WEB_TOO_LARGE', '网页请求数量超过上限')
      const url = new URL('https://cloudflare-dns.com/dns-query')
      url.searchParams.set('name', hostname)
      url.searchParams.set('type', type)
      let response: Awaited<ReturnType<WebNetwork['once']>>
      try {
        response = await this.once(
          url,
          PUBLIC_DNS,
          budget,
          'GET',
          undefined,
          undefined,
          'application/dns-json',
        )
      } catch (error) {
        if (budget.signal.aborted) throw webAbortError(budget.signal)
        if (error instanceof AppServiceError) throw error
        throw new AppServiceError('WEB_UNAVAILABLE', '系统 DNS 返回代理地址，公网解析失败')
      }
      if (response.status !== 200)
        throw new AppServiceError('WEB_UNAVAILABLE', '系统 DNS 返回代理地址，公网解析失败')
      let answer: { Status?: number; Answer?: unknown }
      try {
        answer = JSON.parse(response.body.toString('utf8'))
      } catch {
        throw new AppServiceError('WEB_UNAVAILABLE', '公网 DNS 响应无效')
      }
      if (!answer || (answer.Status !== 0 && answer.Status !== 3))
        throw new AppServiceError('WEB_UNAVAILABLE', '公网 DNS 无法解析网页域名')
      if (answer.Answer != null && !Array.isArray(answer.Answer))
        throw new AppServiceError('WEB_UNAVAILABLE', '公网 DNS 响应无效')
      const addresses = (answer.Answer ?? [])
        .filter(
          (item: unknown): item is { type: number; data: string } =>
            typeof item === 'object' &&
            item !== null &&
            'type' in item &&
            item.type === recordType &&
            'data' in item &&
            typeof item.data === 'string',
        )
        .map((item: { data: string }) => ({ address: item.data, family }))
      if (addresses.length) return addresses
    }
    throw new AppServiceError('WEB_UNAVAILABLE', '公网 DNS 无法解析网页域名')
  }

  private once(
    url: URL,
    address: { address: string; family: number },
    budget: WebBudget,
    method: string,
    body?: Buffer,
    pageUrl?: string,
    accept = 'text/html,application/json,text/plain,application/javascript,text/css,*/*;q=0.1',
  ): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const transport = url.protocol === 'https:' ? https : http
      const request = transport.request(
        url,
        {
          method,
          timeout: 15_000,
          lookup: (_hostname, options, callback) => {
            if (options.all) callback(null, [{ address: address.address, family: address.family }])
            else callback(null, address.address, address.family)
          },
          headers: {
            'User-Agent': USER_AGENT,
            Accept: accept,
            'Accept-Encoding': 'identity',
            ...(body
              ? {
                  'Content-Type': 'application/json',
                  'Content-Length': String(body.length),
                  Origin: new URL(pageUrl!).origin,
                  Referer: pageUrl!,
                }
              : {}),
          },
        },
        (response) => {
          const chunks: Buffer[] = []
          let length = 0
          response.on('data', (chunk: Buffer) => {
            length += chunk.length
            budget.bytes += chunk.length
            if (length > MAX_RESPONSE_BYTES || budget.bytes > MAX_TOTAL_BYTES) {
              request.destroy(new AppServiceError('WEB_TOO_LARGE', '网页内容超过大小上限'))
              return
            }
            chunks.push(chunk)
          })
          response.on('end', () => {
            try {
              let body = Buffer.concat(chunks)
              const encoding = String(response.headers['content-encoding'] ?? '').toLowerCase()
              if (encoding === 'gzip')
                body = zlib.gunzipSync(body, { maxOutputLength: MAX_RESPONSE_BYTES })
              else if (encoding === 'deflate')
                body = zlib.inflateSync(body, { maxOutputLength: MAX_RESPONSE_BYTES })
              else if (encoding === 'br')
                body = zlib.brotliDecompressSync(body, { maxOutputLength: MAX_RESPONSE_BYTES })
              else if (encoding && encoding !== 'identity')
                throw new AppServiceError('WEB_UNSUPPORTED', '网页使用了不支持的压缩格式')
              budget.bytes += Math.max(0, body.length - length)
              if (body.length > MAX_RESPONSE_BYTES || budget.bytes > MAX_TOTAL_BYTES)
                throw new AppServiceError('WEB_TOO_LARGE', '网页内容超过大小上限')
              resolve({ status: response.statusCode ?? 0, headers: response.headers, body })
            } catch (error) {
              reject(
                error instanceof AppServiceError
                  ? error
                  : new AppServiceError('WEB_TOO_LARGE', '网页解压失败或超过大小上限'),
              )
            }
          })
          response.on('error', reject)
        },
      )
      const abort = () => request.destroy(webAbortError(budget.signal))
      budget.signal.addEventListener('abort', abort, { once: true })
      request.on('close', () => budget.signal.removeEventListener('abort', abort))
      request.on('timeout', () =>
        request.destroy(new AppServiceError('WEB_TIMEOUT', '网页读取超时')),
      )
      request.on('error', reject)
      request.end(body)
    })
  }
}
