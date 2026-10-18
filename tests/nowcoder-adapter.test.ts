// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { nowcoderAdapter } from '../src/main/discovery/adapters/nowcoder'
import { nowcoderResponse } from '../src/main/discovery/adapters/nowcoder/parsing'
import {
  nowcoderForm,
  nowcoderRequest,
  NowcoderSearch,
} from '../src/main/discovery/adapters/nowcoder/search'
import { nowcoderAccount, nowcoderQr } from '../src/main/discovery/adapters/nowcoder/protocol'
import type { AccountTransport, SearchTransport } from '../src/main/discovery/adapter'
import type { QrTransport } from '../src/main/discovery/qr-protocol'
import type { PageSnapshot } from '../src/main/discovery/extraction'
import { salaryExclusion } from '../src/main/discovery/normalization'

// Synthetic cards shaped after the official 2026-10-16 square-search contract.
const row = (id: number, type = 1) => ({
  rc_type: 3010,
  data: {
    id,
    recruitType: type,
    jobName: '<em>Java</em>开发',
    recommendInternCompany: { companyName: '合成公司' },
    user: { nickname: '不得作为公司' },
    jobCityList: ['北京', '上海'],
    eduLevel: 5000,
    workYearType: 2,
    salaryMin: type === 2 ? 200 : 15,
    salaryMax: type === 2 ? 300 : 25,
    salaryType: type === 2 ? 1 : 2,
    salaryMonth: 14,
    durationDays: 4,
    durationMonths: 3,
    jobOffer: 1,
    ext: JSON.stringify({ infos: '完整职责\n第二段', requirements: '原始要求' }),
  },
})
const official = {
  rc_type: 3030,
  data: {
    id: 30300000146368,
    recruitType: 0,
    jobTitle: '官网职位',
    companyName: '官网公司',
    salary: '薪资面议',
    city: null,
    education: null,
    extraInfo: { positionType_var: '校招' },
    description: '<p>职责<br>第二行</p><p>要求</p>',
  },
}
const response = (
  datas: unknown[] = [row(1), row(2, 2), row(3, 3), official],
  page = 1,
  totalPage = 3,
) => ({ code: 0, data: { datas, currentPage: page, totalPage, totalCount: datas.length ? 42 : 0 } })
const query = { keyword: 'Java', city: '上海' }
const endpoint = 'https://www.nowcoder.com/np-api/u/job/square-search'
afterEach(() => vi.restoreAllMocks())

it('sends one fixed mixed query and isolates typed, expanded, stale and duplicate parameters', () => {
  const body = nowcoderForm(query, 2),
    request = { url: endpoint, method: 'POST', body }
  expect(new URLSearchParams(body).has('recruitType')).toBe(false)
  expect(new URLSearchParams(body).get('jobCity')).toBe('上海')
  expect(new URLSearchParams(nowcoderForm({ ...query, city: '' }, 1)).get('jobCity')).toBe('')
  expect(nowcoderRequest(request, query, 2)).toBe(true)
  for (const suffix of ['&page=2', '&careerJobId=1'])
    expect(nowcoderRequest({ ...request, body: body + suffix }, query, 2)).toBe(false)
  for (const suffix of ['&recruitType=1', '&recruitType='])
    expect(nowcoderRequest({ ...request, body: body + suffix }, query, 2)).toBeNull()
  expect(nowcoderRequest(request, { ...query, city: '北京' }, 2)).toBe(false)
  expect(nowcoderRequest(request, query, 1)).toBe(false)
  expect(
    nowcoderRequest({ ...request, url: endpoint.replace('square-search', 'expand-job') }, query, 2),
  ).toBeNull()
  expect(() => nowcoderForm({ ...query, city: '不存在' }, 1)).toThrow('unsupported_city')
})
it('decodes mixed cards, imported type zero, terms and salary without claiming a complete JD', () => {
  const result = nowcoderResponse(response(), 1)
  expect(result).toMatchObject({ rawCount: 4, rejectedCount: 0, duplicateCount: 0, hasMore: true })
  expect(result.jobs.map((j) => j.recruitment)).toEqual(['校招', '实习', '社招', '校招'])
  expect(result.jobs.map((j) => j.company)).toEqual([
    '合成公司',
    '合成公司',
    '合成公司',
    '官网公司',
  ])
  expect(result.jobs.every((j) => !j.detailRead)).toBe(true)
  expect(result.jobs[0]).toMatchObject({
    title: 'Java开发',
    salary: '15-25K/月 · 14薪',
    city: '北京、上海',
  })
  expect(result.jobs[1].jd).toContain('至少3个月')
  expect(result.jobs[1].salary).toBe('200-300元/天')
  expect(
    salaryExclusion(result.jobs[1].salary, { ...query, platforms: ['nowcoder'], salaryMin: 1 }),
  ).toBe('day')
  expect(result.jobs[2].experience).toBe('1-3年')
  expect(result.jobs[3]).toMatchObject({
    externalId: '30300000146368',
    city: '',
    jd: '职责\n第二行\n要求',
  })
  expect(nowcoderResponse(response([row(1), row(1), { rc_type: 999 }]), 1)).toMatchObject({
    rawCount: 3,
    duplicateCount: 1,
    rejectedCount: 1,
  })
})
it('uses explicit pagination evidence and rejects malformed/nonempty unparseable responses', () => {
  expect(nowcoderResponse(response([row(1)], 1, 4), 1).hasMore).toBe(true)
  expect(nowcoderResponse(response([], 1, 0), 1).hasMore).toBe(false)
  expect(nowcoderResponse(response([], 0, 0), 1)).toMatchObject({
    page: 1,
    rawCount: 0,
    hasMore: false,
  })
  expect(nowcoderResponse(response([row(1)], 3, 3), 3).hasMore).toBe(false)
  for (const v of [
    response([{ rc_type: 999 }]),
    response([row(1)], 2),
    response([row(1)], 0),
    response([], 0, 3),
    { code: 0, data: {} },
    { code: 0, data: { ...response().data, totalCount: 0 } },
  ])
    expect(() => nowcoderResponse(v, 1)).toThrow('response_contract_changed')
  expect(() => nowcoderResponse({ code: 999 }, 1)).toThrow('login_required')
  expect(() => nowcoderResponse({ code: 1125 }, 1)).toThrow('challenge')
  expect(
    nowcoderAdapter.canonicalJob(new URL('https://www.nowcoder.com/jobs/detail/123?track=x')),
  ).toEqual({ url: 'https://www.nowcoder.com/jobs/detail/123', externalId: '123' })
  expect(
    nowcoderAdapter.canonicalJob(new URL('https://evil.nowcoder.com/jobs/detail/123')),
  ).toBeNull()
})
it('retains a batch until committed, advances once, and respects cancellation', async () => {
  const scripts: string[] = []
  const transport: SearchTransport = {
    load: vi.fn().mockResolvedValue(undefined),
    guard: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn(async (script) => {
      scripts.push(script)
      return true as never
    }),
    response: vi.fn(async (reader, action) => {
      await action()
      return reader.response(response([row(scripts.length)], scripts.length))
    }),
    fill: vi.fn(),
    click: vi.fn(),
    enter: vi.fn(),
    until: vi.fn(),
  }
  const search = new NowcoderSearch(transport, query),
    signal = new AbortController().signal
  const first = await search.read(signal)
  expect(await search.read(signal)).toBe(first)
  expect(transport.response).toHaveBeenCalledTimes(1)
  expect(() => search.commit({ ...first })).toThrow('Uncommitted')
  search.commit(first)
  expect((await search.read(signal)).page).toBe(2)
  expect(scripts.join('\n')).not.toContain('recruitType')
  expect(transport.load).toHaveBeenCalledTimes(1)
  await expect(search.read(AbortSignal.abort())).rejects.toThrow()
})
it('requires positive account evidence and distinguishes login, verification and unknown states', async () => {
  const page = vi.fn().mockResolvedValue({ authenticated: true }),
    json = vi.fn(async (_url, parse) => parse({ code: 0, data: { nickname: 'synthetic' } }))
  const t = { page, json, cookie: vi.fn() } as AccountTransport
  expect(await nowcoderAccount(t)).toBe('authenticated')
  page.mockResolvedValue({ authenticated: false })
  expect(await nowcoderAccount(t)).toBe('unknown')
  json.mockImplementation(async (_url, parse) => parse({ code: 999 }))
  expect(await nowcoderAccount(t)).toBe('login_required')
  json.mockImplementation(async (_url, parse) => parse({ code: 1125 }))
  expect(await nowcoderAccount(t)).toBe('challenge')
})
it('uses only official App QR endpoints and checks the account after the official confirmation', async () => {
  const values = [
    { code: 0, data: { code: 'synthetic-code', expireSecs: 180 } },
    { code: 1 },
    { code: 0 },
    { code: 999 },
    { code: 0 },
    { code: 0, data: { id: 123 } },
  ]
  const json = vi.fn(async (_url, parse) => parse(values.shift()))
  const t = { json } as unknown as QrTransport,
    qr = nowcoderQr(t)
  expect(await qr.initialize()).toMatchObject({
    image: 'https://www.nowcoder.com/qrcode/to-pc-code?code=synthetic-code',
    expiresInMs: 180000,
  })
  expect(await qr.poll()).toBe('waiting')
  expect(await qr.poll()).toBe('scanned')
  expect(await qr.poll()).toBe('authenticated')
  expect(json.mock.calls.at(-1)?.[0]).toBe('https://www.nowcoder.com/profile/user-info-v2')
  expect(() => nowcoderQr(t, 'wechat')).toThrow('protocol')
  json.mockImplementation(async (_url, parse) => parse({ code: 2 }))
  expect(await qr.poll()).toBe('expired')
})
it('reads only the current header, complete JD and official company card', () => {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 100,
    height: 50,
  } as DOMRect)
  document.body.innerHTML = `<div class="nc-nav-header-avatar"></div>
    <div class="job-detail-wrap"><h1 class="title">Java</h1><div class="salary">20-30K * 14薪</div>
    <div class="extra"><span class="el-tooltip">北京</span><span class="edu-level">本科</span><span>1-3年</span><span>4天/周</span><span>至少3个月</span></div></div>
    <div class="job-detail-infos">岗位职责：完整原始职责\n岗位要求：三年及以上</div>
    <div class="job-detail-right-wrap"><div class="company-card"><div class="fs-20">真实公司</div></div><div class="recommend-list"><h1 class="title">推荐标题</h1><div class="job-detail-infos">推荐正文</div></div></div>`
  const read = () => (0, eval)(nowcoderAdapter.pageScript(true)) as PageSnapshot
  expect(read()).toMatchObject({
    authenticated: true,
    detail: {
      title: 'Java',
      company: '真实公司',
      city: '北京',
      experience: '1-3年',
      detailRead: true,
    },
  })
  expect(read().detail.jd).toContain('至少3个月')
  expect(read().detail.jd).not.toContain('推荐正文')
  const experience = document.querySelector('.job-detail-wrap .extra>span:nth-child(3)')!
  for (const value of ['在校生', '应届毕业生', '不限经验']) {
    experience.textContent = value
    expect(read().detail.experience).toBe(value)
  }
  const recruitment = document.createElement('span')
  document.querySelector('.job-detail-wrap .extra')!.appendChild(recruitment)
  for (const value of ['校招', '实习', '社招', '校园招聘', '社会招聘']) {
    recruitment.textContent = value
    expect(read().detail.recruitment).toBe(value)
  }
  document
    .querySelector('.job-detail-infos')!
    .appendChild(Object.assign(document.createElement('button'), { textContent: '展开全部' }))
  expect(read().detail.detailRead).toBe(false)
})
