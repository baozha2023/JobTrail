export interface WebQueryPost {
  pageUrl: string
  url: string
  body: Record<string, unknown>
  headers: Record<string, string>
  requiredForContent: boolean
}

const MAX_POST_BODY_BYTES = 16 * 1024
const BEISEN_HOST = /^(?!-)[a-z0-9-]+\.zhiye\.com$/i

// Exact site endpoints and common data endpoint names form one allowlist.
const BEISEN_ENDPOINTS = new Map<string, boolean>([
  ['/api/jobad/getjobadpagelist', true],
  ['/api/jobad/getjobadsearchconditions', false],
  ['/api/jobad/getjobcount', true],
])
const FORWARDED_HEADERS = [
  'accept',
  'accept-language',
  'cookie',
  'env',
  'portal-channel',
  'portal-platform',
  'user-agent',
  'website-path',
  'x-csrf-token',
] as const
const POST_ENDPOINTS = new Set([
  'search',
  'query',
  'list',
  'filter',
  'lookup',
  'find',
  'posts',
  'count',
  'results',
  'items',
  'details',
  'suggestions',
])
const MUTATION_SEGMENTS = new Set([
  'create',
  'update',
  'delete',
  'remove',
  'save',
  'submit',
  'upload',
  'login',
  'register',
  'auth',
  'checkout',
  'purchase',
  'pay',
  'subscribe',
  'unsubscribe',
  'approve',
  'cancel',
  'mutation',
])

export function approveWebQueryPost(
  pageUrl: string,
  requestUrl: string,
  method: string,
  rawBody: string | null,
  contentType = '',
  requestHeaders: Record<string, string> = {},
): WebQueryPost | null {
  if (method !== 'POST' || !rawBody || Buffer.byteLength(rawBody) > MAX_POST_BODY_BYTES) return null

  try {
    const page = new URL(pageUrl)
    const target = new URL(requestUrl)
    const body: unknown = JSON.parse(rawBody)
    if (
      page.protocol !== 'https:' ||
      target.origin !== page.origin ||
      page.username ||
      page.password ||
      target.username ||
      target.password ||
      target.hash ||
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body)
    )
      return null

    const path = target.pathname.toLowerCase().replace(/\/$/, '')
    const beisen = BEISEN_HOST.test(page.hostname) ? BEISEN_ENDPOINTS.get(path) : undefined
    const csrf = path.endsWith('/csrf/token')
    if (beisen === undefined) {
      const segments = path
        .split('/')
        .filter(Boolean)
        .map((segment) => decodeURIComponent(segment).toLowerCase())
      const endpoint = segments.at(-1)
      if (
        (!csrf && (!endpoint || !POST_ENDPOINTS.has(endpoint))) ||
        segments.some(
          (segment) =>
            !/^[a-z0-9_-]{1,64}$/.test(segment) ||
            segment.split(/[-_]/).some((part) => MUTATION_SEGMENTS.has(part)),
        ) ||
        !/^application\/json(?:\s*;|$)/i.test(contentType)
      )
        return null
    }

    const headers: Record<string, string> = {}
    for (const name of FORWARDED_HEADERS) {
      const value = requestHeaders[name]
      if (value && value.length <= 8_192) headers[name] = value
    }

    return {
      pageUrl,
      url: target.href,
      body: body as Record<string, unknown>,
      headers,
      requiredForContent: beisen ?? !csrf,
    }
  } catch {
    return null
  }
}
