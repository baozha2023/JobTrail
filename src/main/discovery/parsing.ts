import type { RawJob } from '../../shared/job-discovery'
import { SourceError, type JobIdentityPolicy, type ParsedBatch } from './adapter'
import { canonicalUrl, identityFor } from './identity'
import { captureError, recordEvent } from '../diagnostics'

export const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
export const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
export const rows = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) throw new SourceError('parse_error', 'response_contract_changed')
  return value
}
export function job(
  policy: JobIdentityPolicy,
  fields: Partial<RawJob> & Pick<RawJob, 'title' | 'url'>,
): RawJob | null {
  const key = canonicalUrl(policy, fields.url)
  if (!key || !fields.title.trim()) return null
  return {
    platform: policy.id,
    company: '',
    city: '',
    salary: '',
    experience: '',
    education: '',
    recruitment: '',
    employment: '',
    jd: '',
    detailRead: false,
    ...fields,
    externalId: key.externalId ?? undefined,
    url: key.url,
    provenance: Object.fromEntries(
      Object.keys(fields)
        .filter((k) => !['url', 'externalId', 'detailRead'].includes(k))
        .map((k) => [k, 'response']),
    ),
  }
}
export function batch(
  policy: JobIdentityPolicy,
  page: number,
  source: unknown[],
  decode: (row: unknown) => RawJob | null,
  hasMore: boolean | null,
  options: {
    evidence?: ParsedBatch['evidence']
    accept?: (job: RawJob) => boolean
  } = {},
): ParsedBatch {
  const parsed = new Map<string, RawJob>()
  let duplicateCount = 0,
    rejectedCount = 0
  for (const value of source) {
    try {
      const item = decode(value)
      if (!item) {
        rejectedCount++
        continue
      }
      if (item.platform !== policy.id) throw new Error('Job belongs to a different adapter')
      const { id } = identityFor(policy, item.url, item.externalId)
      if (parsed.has(id)) duplicateCount++
      else parsed.set(id, item)
    } catch (error) {
      rejectedCount++
      captureError(error, { operation: `discovery.${policy.id}.item-parse`, level: 'warn' })
    }
  }
  const jobs = [...parsed.values()].filter((item) => !options.accept || options.accept(item))
  if (rejectedCount)
    recordEvent({
      operation: `discovery.${policy.id}.parse-skipped`,
      attributes: { count: source.length, failedCount: rejectedCount },
    })
  // A real empty list is valid. A nonempty list with no decodable identities is
  // an unrecognized response, before any city or salary filters are applied.
  if (source.length && !parsed.size)
    throw new SourceError('parse_error', 'response_contract_changed')
  if (parsed.size > jobs.length)
    recordEvent({
      operation: `discovery.${policy.id}.city-filtered`,
      attributes: { count: parsed.size, skippedCount: parsed.size - jobs.length },
    })
  return {
    jobs,
    sourceIds: [...parsed.keys()],
    page,
    rawCount: source.length,
    duplicateCount,
    rejectedCount,
    hasMore,
    evidence: options.evidence ?? 'search_response',
  }
}
