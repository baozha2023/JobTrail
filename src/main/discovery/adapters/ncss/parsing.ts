import { z } from 'zod'
import { SourceError, type JobIdentityPolicy, type ParsedBatch } from '../../adapter'
import { batch, job } from '../../parsing'

export const ncssOrigin = 'https://job.ncss.cn'
export const ncssIdentity: JobIdentityPolicy = {
  id: 'ncss',
  domains: [
    'job.ncss.cn',
    'account.chsi.com.cn',
    'open.weixin.qq.com',
    'lp.open.weixin.qq.com',
    'long.open.weixin.qq.com',
  ],
  canonicalJob(url) {
    const id = /^\/student\/jobs\/([A-Za-z0-9]{6,80})\/detail\.html$/.exec(url.pathname)?.[1]
    return url.origin === ncssOrigin && id
      ? { url: `${ncssOrigin}/student/jobs/${id}/detail.html`, externalId: id }
      : null
  },
}
const nullableText = z.string().nullable().optional()
const nullableNumber = z.number().finite().nullable().optional()
const rowSchema = z.object({
  jobId: z.string().regex(/^[A-Za-z0-9]{6,80}$/),
  jobName: z.string().trim().min(1),
  recName: z.string().trim().min(1),
  areaCodeName: nullableText,
  degreeName: nullableText,
  lowMonthPay: nullableNumber,
  highMonthPay: nullableNumber,
  recruitType: z.string(),
  sourcesName: nullableText,
  sourcesType: nullableText,
})
const envelope = z.discriminatedUnion('flag', [
  z.object({
    flag: z.literal(true),
    data: z.object({
      list: z.array(z.unknown()).max(10),
      pagenation: z.object({
        offset: z.number().int().positive(),
        limit: z.literal(10),
      }),
    }),
  }),
  z.object({
    flag: z.literal(false),
    global: z.array(z.object({ des: z.string() })).optional(),
  }),
])
export function ncssResponse(value: unknown, page: number): ParsedBatch {
  const parsed = envelope.safeParse(value)
  if (!parsed.success) throw new SourceError('parse_error', 'response_contract_changed')
  const result = parsed.data
  if (!result.flag) {
    const message = result.global?.map((item) => item.des).join(' ') ?? ''
    if (/请登录|登录后查看|未登录/.test(message)) throw new SourceError('login_required')
    if (/验证|频繁/.test(message)) throw new SourceError('challenge')
    throw new SourceError('parse_error', 'response_contract_changed')
  }
  if (result.data.pagenation.offset !== page)
    throw new SourceError('parse_error', 'response_contract_changed')
  const source = result.data.list
  return batch(
    ncssIdentity,
    page,
    source,
    (value) => {
      const parsedRow = rowSchema.safeParse(value)
      if (!parsedRow.success) return null
      const row = parsedRow.data
      if (
        row.recruitType !== '0' ||
        ![null, undefined, '', '0', 'null'].includes(row.sourcesName) ||
        ![null, undefined, '', 'null'].includes(row.sourcesType)
      )
        return null
      const low = row.lowMonthPay,
        high = row.highMonthPay
      const salary =
        typeof low !== 'number' || typeof high !== 'number'
          ? ''
          : low === 0 && high === 0
            ? '面议'
            : `${low}-${high}K/月`
      return job(ncssIdentity, {
        url: `${ncssOrigin}/student/jobs/${row.jobId}/detail.html`,
        title: row.jobName,
        company: row.recName,
        city: row.areaCodeName?.trim() ?? '',
        education: row.degreeName?.trim() ?? '',
        salary,
        detailRead: false,
      })
    },
    source.length ? true : false,
  )
}
