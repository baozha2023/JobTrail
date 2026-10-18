import { load } from 'cheerio'
import { z } from 'zod'
import { SourceError, type JobIdentityPolicy, type ParsedBatch } from '../../adapter'
import { batch, job, record, text } from '../../parsing'

export const nowcoderOrigin = 'https://www.nowcoder.com'
export const nowcoderIdentity: JobIdentityPolicy = {
  id: 'nowcoder',
  domains: ['nowcoder.com'],
  canonicalJob(url) {
    const id = /^\/jobs\/detail\/([1-9]\d{0,15})\/?$/.exec(url.pathname)?.[1]
    return url.hostname === 'www.nowcoder.com' && id
      ? { url: `${nowcoderOrigin}/jobs/detail/${id}`, externalId: id }
      : null
  },
}
export const nowcoderEnvelope = z.object({ code: z.number().int(), data: z.unknown().optional() })
export function nowcoderData(value: unknown): unknown {
  const result = nowcoderEnvelope.safeParse(value)
  if (!result.success) throw new SourceError('parse_error', 'response_contract_changed')
  if ([999, 401].includes(result.data.code)) throw new SourceError('login_required')
  if ([403, 429, 1125].includes(result.data.code)) throw new SourceError('challenge')
  if (result.data.code !== 0) throw new SourceError('parse_error', 'response_contract_changed')
  return result.data.data
}
export function nowcoderText(value: unknown): string {
  if (typeof value !== 'string') return ''
  const $ = load(value, {}, false)
  $('script,style').remove()
  $('br').replaceWith('\n')
  $('p,div,li').append('\n')
  return $.root()
    .text()
    .replace(/\u00a0/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .trim()
}
const education: Record<string, string> = {
  0: '学历不限',
  1000: '小学',
  2000: '初中',
  3000: '高中',
  4000: '专科',
  5000: '本科',
  5500: '双学位',
  6000: '硕士',
  7000: '博士',
}
const experience: Record<string, string> = {
  999: '经验不限',
  0: '在校生',
  1: '1年以内',
  2: '1-3年',
  3: '3-5年',
  4: '5-10年',
  5: '10年以上',
}
const recruitment: Record<string, string> = { 1: '校招', 2: '实习', 3: '社招' }
function id(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value)
  return /^[1-9]\d{0,15}$/.test(text(value)) ? text(value) : ''
}
function salary(r: Record<string, unknown>): string {
  if (
    typeof r.salaryMin !== 'number' ||
    typeof r.salaryMax !== 'number' ||
    !Number.isFinite(r.salaryMin) ||
    !Number.isFinite(r.salaryMax) ||
    r.salaryMin < 0 ||
    r.salaryMax < r.salaryMin
  )
    return ''
  if (r.salaryMin === 0 && r.salaryMax >= 9999999) return '薪资面议'
  const range = r.salaryMin === r.salaryMax ? String(r.salaryMin) : `${r.salaryMin}-${r.salaryMax}`
  if (r.salaryType === 1) return range + '元/天'
  if (r.salaryType === 2)
    return (
      range +
      'K/月' +
      (typeof r.salaryMonth === 'number' && r.salaryMonth > 0 ? ` · ${r.salaryMonth}薪` : '')
    )
  if (r.salaryType === 3) return range + '万/年'
  return ''
}
const resultSchema = z.object({
  datas: z.array(z.unknown()).max(200),
  currentPage: z.number().int().nonnegative(),
  totalPage: z.number().int().nonnegative(),
  totalCount: z.number().int().nonnegative(),
})
export function nowcoderResponse(value: unknown, page: number): ParsedBatch {
  const parsed = resultSchema.safeParse(nowcoderData(value))
  if (!parsed.success) throw new SourceError('parse_error', 'response_contract_changed')
  const data = parsed.data
  // The official no-results response resets all pagination fields to zero,
  // even though the correlated request submitted a positive page number.
  const empty =
    data.currentPage === 0 && data.totalPage === 0 && data.totalCount === 0 && !data.datas.length
  if (
    (!empty && data.currentPage !== page) ||
    (data.datas.length > 0 && (data.totalCount === 0 || data.totalPage < page)) ||
    data.datas.length > data.totalCount
  )
    throw new SourceError('parse_error', 'response_contract_changed')
  return batch(
    nowcoderIdentity,
    page,
    data.datas,
    (value) => {
      const card = record(value),
        r = record(card.data),
        externalId = id(r.id)
      if (!externalId) return null
      const url = `${nowcoderOrigin}/jobs/detail/${externalId}`
      if (card.rc_type === 3030) {
        const type = text(record(r.extraInfo).positionType_var)
        return job(nowcoderIdentity, {
          url,
          title: nowcoderText(r.jobTitle),
          company: nowcoderText(r.companyName),
          city: nowcoderText(r.city),
          salary: nowcoderText(r.salary),
          education: nowcoderText(r.education),
          recruitment: ['校招', '实习', '社招'].includes(type) ? type : '',
          employment: type === '实习' ? '实习' : '',
          jd: nowcoderText(r.description),
          detailRead: false,
        })
      }
      if (card.rc_type !== 3010 || !recruitment[String(r.recruitType)]) return null
      let ext: Record<string, unknown> = {}
      if (typeof r.ext === 'string' && r.ext.trim()) ext = record(JSON.parse(r.ext))
      const terms =
        r.recruitType === 2
          ? [
              typeof r.durationDays === 'number' && r.durationDays > 0
                ? `每周到岗：${r.durationDays}天`
                : '',
              typeof r.durationMonths === 'number' && r.durationMonths > 0
                ? `实习时长：至少${r.durationMonths}个月`
                : '',
              r.jobOffer === 1 ? '有转正机会' : r.jobOffer === 2 ? '无转正机会' : '',
            ].filter(Boolean)
          : []
      return job(nowcoderIdentity, {
        url,
        title: nowcoderText(r.jobName),
        company: nowcoderText(record(r.recommendInternCompany).companyName),
        city: Array.isArray(r.jobCityList)
          ? r.jobCityList.map(nowcoderText).filter(Boolean).join('、')
          : nowcoderText(r.jobCity),
        salary: salary(r),
        education: education[String(r.eduLevel)] ?? '',
        experience: r.recruitType === 3 ? (experience[String(r.workYearType)] ?? '') : '',
        recruitment: recruitment[String(r.recruitType)],
        employment: r.recruitType === 2 ? '实习' : '',
        jd: [...terms, nowcoderText(ext.infos), nowcoderText(ext.requirements)]
          .filter(Boolean)
          .join('\n\n'),
        detailRead: false,
      })
    },
    page < data.totalPage,
  )
}
