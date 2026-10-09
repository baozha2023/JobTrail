import {
  MAX_OBSERVATION_BYTES,
  observationSchema,
  sourceProgressSchema,
  type JobObservation,
  type SourceProgress,
} from '../../shared/job-discovery'
import { jobIdentity } from './platforms'
import { parseSalary } from './normalization'

export function observationPayload(value: JobObservation): string {
  const item = observationSchema.parse(value)
  const salary = parseSalary(item.salary)
  if (item.salaryMin !== salary.salaryMin || item.salaryMax !== salary.salaryMax)
    throw new Error('Invalid normalized salary')
  const text = JSON.stringify(item)
  if (Buffer.byteLength(text, 'utf8') > MAX_OBSERVATION_BYTES)
    throw new Error('Oversized discovery observation')
  return text
}
export function readObservation(text: string): JobObservation {
  if (Buffer.byteLength(text, 'utf8') > MAX_OBSERVATION_BYTES)
    throw new Error('Oversized discovery observation')
  const item = observationSchema.parse(JSON.parse(text))
  observationPayload(item)
  jobIdentity(item.platform, item.url, item.externalId)
  return item
}
export const sourceProjection = [
  'platform',
  'state',
  'count',
  'batches',
  'source_page AS sourcePage',
  'raw_count AS rawCount',
  'valid_count AS validCount',
  'duplicate_count AS duplicateCount',
  'rejected_count AS rejectedCount',
  'cursor',
  'generation',
  'remote',
  'message',
  'cached_at AS cachedAt',
  "json_object('out_of_range',excluded_range,'day',excluded_day,'hour',excluded_hour,'foreign',excluded_foreign,'unknown',excluded_unknown) AS salaryExcluded",
].join(',')
export type SourceRow = Omit<SourceProgress, 'remote' | 'salaryExcluded'> & {
  remote: string
  salaryExcluded: string
}
export function readSource(row: SourceRow): SourceProgress {
  return sourceProgressSchema.parse({
    ...row,
    remote: JSON.parse(row.remote),
    salaryExcluded: JSON.parse(row.salaryExcluded),
  })
}
export const collectDiscoveryGarbage = [
  'DELETE FROM discovery_jobs WHERE NOT EXISTS(SELECT 1 FROM discovery_results WHERE job_id=discovery_jobs.id) AND NOT EXISTS(SELECT 1 FROM discovery_view_items WHERE job_id=discovery_jobs.id) AND NOT EXISTS(SELECT 1 FROM discovery_saved WHERE job_id=discovery_jobs.id)',
  'DELETE FROM discovery_observations WHERE NOT EXISTS(SELECT 1 FROM discovery_results WHERE observation_id=discovery_observations.id) AND NOT EXISTS(SELECT 1 FROM discovery_view_items WHERE observation_id=discovery_observations.id) AND NOT EXISTS(SELECT 1 FROM discovery_saved WHERE observation_id=discovery_observations.id) AND NOT EXISTS(SELECT 1 FROM discovery_jobs WHERE current_observation_id=discovery_observations.id)',
].join(';\n')
