export interface WebQueryPost {
  pageUrl: string
  url: string
  body: Record<string, unknown>
  requiredForContent: boolean
  assurance: 'verified' | 'heuristic'
}

const BEISEN_HOST = /^(?!-)[a-z0-9-]+\.zhiye\.com$/i
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DISPLAY_FIELD = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const FILTER_VALUE = /^[A-Za-z0-9_-]{1,64}$/
const QUERY_PATH = new Set(['search', 'query', 'list', 'filter', 'lookup', 'find'])
const MUTATION_PATH = new Set([
  'create',
  'update',
  'delete',
  'remove',
  'save',
  'submit',
  'send',
  'upload',
  'login',
  'register',
  'auth',
  'checkout',
  'purchase',
  'pay',
  'subscribe',
  'unsubscribe',
  'set',
  'reset',
  'approve',
  'accept',
  'cancel',
  'follow',
  'vote',
  'comment',
  'review',
  'feedback',
  'track',
  'log',
  'collect',
])
const QUERY_FIELD =
  /^(?:q|query|search|searchterm|keyword|keywords|term|page|pageindex|pageno|pagesize|limit|offset|cursor|filter|filters|sort|sortby|category|categories|ids|conditions)$/i
const UNSAFE_FIELD =
  /(?:^__proto__$|^prototype$|^constructor$|password|passcode|secret|token|authorization|credential|cookie|csrf|api.?key|access.?key|private.?key|payment|cardnumber|cvv|file|upload|mutation|command|action|method|operation|create|update|delete|remove|save|submit|send|write|redirect|callback|returnurl|webhook)/i

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}

function validCategory(value: unknown): boolean {
  if (value === undefined) return true
  const categories = Array.isArray(value) ? value : [value]
  return (
    categories.length >= 1 &&
    categories.length <= 4 &&
    categories.every((category) =>
      typeof category === 'string' ? /^(0|1|2|3)$/.test(category) : false,
    )
  )
}

function validJobListBody(value: Record<string, unknown>): boolean {
  return (
    hasOnlyKeys(value, [
      'PageIndex',
      'PageSize',
      'Category',
      'KeyWords',
      'SpecialType',
      'PortalId',
      'DisplayFields',
    ]) &&
    Number.isInteger(value.PageIndex) &&
    (value.PageIndex as number) >= 0 &&
    (value.PageIndex as number) <= 10_000 &&
    Number.isInteger(value.PageSize) &&
    (value.PageSize as number) >= 1 &&
    (value.PageSize as number) <= 30 &&
    validCategory(value.Category) &&
    typeof value.KeyWords === 'string' &&
    value.KeyWords.length <= 100 &&
    Number.isInteger(value.SpecialType) &&
    (value.SpecialType as number) >= 0 &&
    (value.SpecialType as number) <= 10 &&
    typeof value.PortalId === 'string' &&
    value.PortalId.length <= 100 &&
    Array.isArray(value.DisplayFields) &&
    value.DisplayFields.length <= 20 &&
    value.DisplayFields.every((field) => typeof field === 'string' && DISPLAY_FIELD.test(field))
  )
}

function validSearchConditionsBody(value: Record<string, unknown>): boolean {
  return (
    hasOnlyKeys(value, ['PageId', 'displayFilters', 'Category', 'Classification3']) &&
    typeof value.PageId === 'string' &&
    UUID.test(value.PageId) &&
    validCategory(value.Category) &&
    Array.isArray(value.displayFilters) &&
    value.displayFilters.length <= 20 &&
    value.displayFilters.every((field) => typeof field === 'string' && DISPLAY_FIELD.test(field)) &&
    (value.Classification3 === undefined ||
      (Array.isArray(value.Classification3) &&
        value.Classification3.length <= 20 &&
        value.Classification3.every((item) => typeof item === 'string' && item.length <= 100)))
  )
}

function validJobCountBody(value: Record<string, unknown>): boolean {
  return (
    hasOnlyKeys(value, ['Condition', 'Category']) &&
    value.Category === 'campus' &&
    Array.isArray(value.Condition) &&
    value.Condition.length >= 1 &&
    value.Condition.length <= 20 &&
    value.Condition.every(
      (condition) =>
        record(condition) &&
        hasOnlyKeys(condition, ['Type', 'Values']) &&
        (condition.Type === 'workLocation' || condition.Type === 1) &&
        Array.isArray(condition.Values) &&
        condition.Values.length >= 1 &&
        condition.Values.length <= 20 &&
        condition.Values.every((item) => typeof item === 'string' && FILTER_VALUE.test(item)),
    )
  )
}

function validGenericQueryPath(pathname: string): boolean {
  let segments: string[]
  try {
    segments = pathname
      .split('/')
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment).toLowerCase())
  } catch {
    return false
  }
  return (
    segments.length > 0 &&
    segments.every(
      (segment) =>
        /^[a-z0-9_-]{1,64}$/.test(segment) &&
        segment.split(/[-_]/).every((part) => !MUTATION_PATH.has(part)),
    ) &&
    QUERY_PATH.has(segments.at(-1)!)
  )
}

function validGenericQueryBody(body: Record<string, unknown>): boolean {
  let nodes = 0
  let hasQueryField = false
  const visit = (value: unknown, depth: number): boolean => {
    if (++nodes > 100 || depth > 4) return false
    if (value === null || typeof value === 'boolean') return true
    if (typeof value === 'number') return Number.isFinite(value) && Math.abs(value) <= 1_000_000_000
    if (typeof value === 'string')
      return value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value)
    if (Array.isArray(value))
      return value.length <= 20 && value.every((item) => visit(item, depth + 1))
    if (!record(value) || Object.keys(value).length > 20) return false
    return Object.entries(value).every(([key, item]) => {
      if (!DISPLAY_FIELD.test(key) || UNSAFE_FIELD.test(key)) return false
      if (QUERY_FIELD.test(key)) hasQueryField = true
      return visit(item, depth + 1)
    })
  }
  return Object.keys(body).length > 0 && visit(body, 0) && hasQueryField
}

/** Approve a verified query or a bounded query-shaped POST from the page origin. */
export function approveWebQueryPost(
  pageUrl: string,
  requestUrl: string,
  method: string,
  rawBody: string | null,
  contentType = '',
): WebQueryPost | null {
  if (method !== 'POST' || !rawBody || Buffer.byteLength(rawBody) > 2_048) return null
  let page: URL
  let target: URL
  let body: unknown
  try {
    page = new URL(pageUrl)
    target = new URL(requestUrl)
    body = JSON.parse(rawBody)
  } catch {
    return null
  }
  if (
    page.protocol !== 'https:' ||
    target.protocol !== 'https:' ||
    page.username ||
    page.password ||
    target.username ||
    target.password ||
    target.origin !== page.origin ||
    target.hash ||
    !record(body)
  )
    return null
  const path = target.pathname.toLowerCase()
  if (BEISEN_HOST.test(page.hostname) && path === '/api/jobad/getjobcount') {
    if (
      target.searchParams.size !== 1 ||
      !UUID.test(target.searchParams.get('portalId') ?? '') ||
      !validJobCountBody(body)
    )
      return null
    return { pageUrl, url: target.href, body, requiredForContent: true, assurance: 'verified' }
  }
  if (target.search) return null
  if (BEISEN_HOST.test(page.hostname)) {
    if (path === '/api/jobad/getjobadpagelist' && validJobListBody(body))
      return { pageUrl, url: target.href, body, requiredForContent: true, assurance: 'verified' }
    if (path === '/api/jobad/getjobadsearchconditions' && validSearchConditionsBody(body))
      return { pageUrl, url: target.href, body, requiredForContent: false, assurance: 'verified' }
  }
  if (
    /^application\/json(?:\s*;|$)/i.test(contentType) &&
    validGenericQueryPath(target.pathname) &&
    validGenericQueryBody(body)
  )
    return { pageUrl, url: target.href, body, requiredForContent: true, assurance: 'heuristic' }
  return null
}
