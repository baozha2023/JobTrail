export interface ReadOnlyWebQuery {
  pageUrl: string
  url: string
  body: Record<string, unknown>
  requiredForContent: boolean
}

const BEISEN_HOST = /^(?!-)[a-z0-9-]+\.zhiye\.com$/i
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DISPLAY_FIELD = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}

function validJobListBody(value: Record<string, unknown>): boolean {
  return (
    hasOnlyKeys(value, [
      'PageIndex',
      'PageSize',
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
    hasOnlyKeys(value, ['PageId', 'displayFilters']) &&
    typeof value.PageId === 'string' &&
    UUID.test(value.PageId) &&
    Array.isArray(value.displayFilters) &&
    value.displayFilters.length <= 20 &&
    value.displayFilters.every((field) => typeof field === 'string' && DISPLAY_FIELD.test(field))
  )
}

/** Only explicitly verified same-origin read-only page requests may use POST. */
export function approveReadOnlyQuery(
  pageUrl: string,
  requestUrl: string,
  method: string,
  rawBody: string | null,
): ReadOnlyWebQuery | null {
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
    !BEISEN_HOST.test(page.hostname) ||
    target.origin !== page.origin ||
    target.search ||
    target.hash ||
    !record(body)
  )
    return null
  if (target.pathname === '/api/Jobad/GetJobAdPageList' && validJobListBody(body))
    return { pageUrl, url: target.href, body, requiredForContent: true }
  if (target.pathname === '/api/Jobad/GetJobAdSearchConditions' && validSearchConditionsBody(body))
    return { pageUrl, url: target.href, body, requiredForContent: false }
  return null
}
