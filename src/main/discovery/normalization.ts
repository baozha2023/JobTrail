import { createHash } from 'node:crypto'
import type {
  JobObservation,
  JobQuery,
  RawJob,
  SalaryExclusionReason,
} from '../../shared/job-discovery'
import { jobFields } from '../../shared/job-discovery'

export interface ParsedSalary {
  salaryMin: number | null
  salaryMax: number | null
  exclusion: Exclude<SalaryExclusionReason, 'out_of_range'> | null
}
export function parseSalary(raw: string): ParsedSalary {
  const text = raw
    .normalize('NFKC')
    .replace(/[,，\s]/g, '')
    .toLowerCase()
  const unknown = (exclusion: ParsedSalary['exclusion']): ParsedSalary => ({
    salaryMin: null,
    salaryMax: null,
    exclusion,
  })
  if (
    /美元|美金|港币|港元|欧元|日元|英镑|澳元|加元|新币|新加坡元|韩元|新台币|台币|卢布|卢比|usd|hkd|eur|jpy|gbp|aud|cad|sgd|krw|twd|\$|€|£/.test(
      text,
    )
  )
    return unknown('foreign')
  if (/小时|时薪|\/时|\/h(?:our)?$/.test(text)) return unknown('hour')
  if (/日薪|天|\/日|\/d(?:ay)?$/.test(text)) return unknown('day')
  if (/面议|保密|以上|以下|起|不低于|不高于/.test(text)) return unknown('unknown')
  const annual = /年|\/y(?:ear)?$/.test(text.replace(/\d+(?:\.\d+)?薪/g, ''))
  if (!/[kw千万元]|人民币|cny|rmb/.test(text)) return unknown('unknown')
  const amount = text
    .replace(/(?:[·×x*]|每年)?\d+(?:\.\d+)?薪/g, '')
    .replace(/人民币|cny|rmb|年薪|月薪/g, '')
    .replace(/(?:元)?(?:\/)?(?:个月|月|年|month|year)$/, '')
    .replace(/元$/, '')
  const match = amount.match(
    /^(\d+(?:\.\d+)?)([kw千万]?)(?:[-~～–—至](\d+(?:\.\d+)?)([kw千万]?))?$/,
  )
  if (!match) return unknown('unknown')
  const scale = (unit: string) => (/[w万]/.test(unit) ? 10000 : /[k千]/.test(unit) ? 1000 : 1)
  const min = (Number(match[1]) * scale(match[2] || match[4] || '')) / (annual ? 12 : 1)
  const max = match[3]
    ? (Number(match[3]) * scale(match[4] || match[2] || '')) / (annual ? 12 : 1)
    : null
  if (!Number.isFinite(min) || (max !== null && (!Number.isFinite(max) || max < min)))
    return unknown('unknown')
  return { salaryMin: min, salaryMax: max, exclusion: null }
}
export function salaryExclusion(raw: string, query: JobQuery): SalaryExclusionReason | null {
  if (query.salaryMin === undefined && query.salaryMax === undefined) return null
  const value = parseSalary(raw)
  if (value.exclusion) return value.exclusion
  const min = value.salaryMin!,
    max = value.salaryMax ?? min
  return max < (query.salaryMin ?? 0) || min > (query.salaryMax ?? Infinity) ? 'out_of_range' : null
}
export function normalizeJob(
  raw: RawJob,
  now = Date.now(),
  previous?: JobObservation,
): JobObservation {
  const merged: RawJob = { ...raw, missing: { ...raw.missing }, provenance: { ...raw.provenance } }
  // A list snapshot may refresh fields, but cannot erase a successful full detail read.
  if (previous)
    for (const field of jobFields) {
      if ((!raw[field]?.trim() || (field === 'jd' && !raw.detailRead)) && previous[field]) {
        merged[field] = previous[field]
        if (previous.provenance?.[field]) merged.provenance![field] = previous.provenance[field]
      }
    }
  const detailReadAt = raw.detailRead && !!raw.jd.trim() ? now : (previous?.detailReadAt ?? null)
  const missing = { ...previous?.missing, ...raw.missing }
  for (const field of jobFields) {
    // A list summary is useful text, but is not evidence of a complete JD.
    if (field === 'jd' && detailReadAt === null) missing.jd ??= 'detail_not_read'
    else if (merged[field]?.trim()) delete missing[field]
    else missing[field] ??= detailReadAt !== null ? 'not_provided' : 'detail_not_read'
  }
  const { salaryMin, salaryMax } = parseSalary(merged.salary)
  return {
    platform: raw.platform,
    externalId: raw.externalId,
    url: raw.url,
    title: merged.title,
    company: merged.company,
    city: merged.city,
    salary: merged.salary,
    experience: merged.experience,
    education: merged.education,
    recruitment: merged.recruitment,
    employment: merged.employment,
    jd: merged.jd,
    detailRead: detailReadAt !== null,
    provenance: merged.provenance,
    missing,
    salaryMin,
    salaryMax,
    readAt: now,
    detailReadAt,
  }
}
const fold = (v: string) => v.normalize('NFKC').toLowerCase().replace(/\s+/g, '')
export function duplicateFingerprint(
  job: Pick<RawJob, 'title' | 'company' | 'city'>,
): string | null {
  const fields = [job.title, job.company, job.city].map(fold)
  return fields.every(Boolean)
    ? createHash('sha256').update(JSON.stringify(fields)).digest('hex')
    : null
}
export function relevance(job: JobObservation, query: JobQuery): number {
  return query.keyword
    .split(/\s+/)
    .reduce(
      (score, term) =>
        score +
        (fold(job.title).includes(fold(term)) ? 10 : 0) +
        (fold(job.company).includes(fold(term)) ? 2 : 0),
      0,
    )
}
