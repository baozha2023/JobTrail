import { platformAdapter } from '../src/main/discovery/adapter-registry'
import { beforeEach, expect, it, vi } from 'vitest'
import { recordEvent, captureError } from '../src/main/diagnostics'
import { bossResponse } from '../src/main/discovery/adapters/boss'
import {
  liepinResponse,
  liepinCityFilter,
  LiepinSearch,
} from '../src/main/discovery/adapters/liepin'
import { wuyouResponse, wuyouCityFilter } from '../src/main/discovery/adapters/wuyou'
import { zhilianResponse, zhilianInitial } from '../src/main/discovery/adapters/zhilian'
import { SearchPage } from '../src/main/discovery/search-page'
import { batch } from '../src/main/discovery/parsing'
import { RoundBudget } from '../src/main/discovery/collection'
vi.mock('../src/main/diagnostics', () => ({ recordEvent: vi.fn(), captureError: vi.fn() }))
beforeEach(() => vi.clearAllMocks())
const liepin = (locations: string[], city: string) =>
  liepinResponse(
    {
      flag: 1,
      data: {
        data: {
          jobCardList: locations.map((dq, i) => ({
            job: { title: 'Java', dq, link: `https://www.liepin.com/job/${100 + i}.shtml` },
          })),
        },
      },
    },
    1,
    city,
  )
const wuyou = (locations: string[], city: string) =>
  wuyouResponse(
    {
      status: '1',
      resultbody: {
        job: {
          totalCount: 40,
          items: locations.map((jobAreaString, i) => ({
            jobName: 'Java',
            jobAreaString,
            jobHref: `https://jobs.51job.com/beijing/${100 + i}.html`,
          })),
        },
      },
    },
    1,
    20,
    city,
  )
it.each([
  ['liepin', liepin],
  ['wuyou', wuyou],
] as const)(
  '%s admits only the selected city, keeping source identities for filtered jobs',
  (platform, parse) => {
    const result = parse(
      ['北京-朝阳区', '北京市·海淀区', '上海-浦东新区', '北海', '北京路', '吉林省', ''],
      '北京',
    )
    expect(result.jobs.map((j) => j.city)).toEqual(['北京-朝阳区', '北京市·海淀区'])
    expect(result.sourceIds).toHaveLength(7)
    expect(result.rejectedCount).toBe(0)
    expect(recordEvent).toHaveBeenCalledWith({
      operation: `discovery.${platform}.city-filtered`,
      attributes: { count: 7, skippedCount: 5 },
    })
    expect(parse(['上海', ''], '').jobs).toHaveLength(2)
  },
)
it.each([liepinCityFilter, wuyouCityFilter])(
  'recognizes exact catalog names and municipal suffixes without broad prefix matching',
  (filter) => {
    expect(filter('吉林')('吉林市·船营区')).toBe(true)
    expect(filter('吉林')('吉林省')).toBe(false)
    expect(filter('杭州')('杭州湾新区')).toBe(false)
    expect(filter('延边朝鲜族自治州')('延边朝鲜族自治州·延吉市')).toBe(true)
    expect(() => filter('不存在的城市')).toThrow()
  },
)
it('drops the observed foreign-city samples in the corresponding adapters', () => {
  for (const [city, foreign] of [
    ['上海', '成都-青羊区'],
    ['成都', '北京-大兴区'],
    ['绵阳', '杭州-滨江区'],
    ['济南', '温州-鹿城区'],
    ['福州', '西安'],
    ['昆明', '广州-黄埔区'],
  ])
    expect(liepin([city, foreign], city).jobs.map((j) => j.city)).toEqual([city])
  for (const [city, foreign] of [
    ['长沙', '衡阳'],
    ['合肥', '宿州'],
  ])
    expect(wuyou([city, foreign], city).jobs.map((j) => j.city)).toEqual([city])
})
it('trusts BOSS and Zhilian job locations without applying a city predicate', () => {
  const boss = bossResponse(
    {
      code: 0,
      zpData: {
        hasMore: true,
        jobList: [
          { encryptJobId: 'valid', jobName: 'Java', cityName: '上海', salaryDesc: '20-40K' },
        ],
      },
    },
    1,
  )
  const row = {
    positionUrl: 'https://www.zhaopin.com/jobdetail/CC1234.htm',
    name: 'Java',
    workCity: '上海',
  }
  const zhi = zhilianResponse({ code: 200, data: { list: [row], isEndPage: 0 } }, 1)
  const ssr = zhilianInitial(
    {
      pageMode: 'search',
      queryParams: { kw: 'Java', jl: '530' },
      pageIndex: 1,
      loadingStatus: false,
      listLoadError: false,
      hasMore: true,
      positionList: [row],
    },
    { keyword: 'Java', city: '北京' },
    1,
  )
  expect([boss, zhi, ssr].map((b) => b?.jobs[0].city)).toEqual(['上海', '上海', '上海'])
})
it('silently skips malformed rows for every platform while retaining valid jobs and logging counts', () => {
  const b = bossResponse(
    {
      code: 0,
      zpData: {
        hasMore: true,
        jobList: [null, { encryptJobId: 'ok', jobName: 'Java', salaryDesc: '20-40K' }],
      },
    },
    1,
  )
  const l = liepinResponse(
    {
      flag: 1,
      data: {
        data: {
          jobCardList: [
            null,
            { job: { title: 'Java', link: 'https://www.liepin.com/job/123.shtml', dq: '北京' } },
          ],
        },
      },
    },
    1,
    '北京',
  )
  const w = wuyouResponse(
    {
      status: '1',
      resultbody: {
        job: {
          totalCount: 2,
          items: [
            null,
            {
              jobName: 'Java',
              jobHref: 'https://jobs.51job.com/beijing/123.html',
              jobAreaString: '北京',
            },
          ],
        },
      },
    },
    1,
    20,
    '北京',
  )
  const z = zhilianResponse(
    {
      code: 200,
      data: {
        list: [null, { name: 'Java', positionUrl: 'https://www.zhaopin.com/jobdetail/CC1234.htm' }],
        isEndPage: 1,
      },
    },
    1,
  )
  for (const result of [b, l, w, z]) {
    expect(result.jobs).toHaveLength(1)
    expect(result).toMatchObject({ rawCount: 2, rejectedCount: 1, duplicateCount: 0 })
    expect(result.sourceIds).toHaveLength(1)
  }
  for (const p of ['boss', 'liepin', 'wuyou', 'zhilian'])
    expect(recordEvent).toHaveBeenCalledWith({
      operation: `discovery.${p}.parse-skipped`,
      attributes: { count: 2, failedCount: 1 },
    })
  expect(JSON.stringify(vi.mocked(recordEvent).mock.calls)).not.toMatch(/https|Java|北京/)
})
it('isolates a decoder exception to its row and records the exception', () => {
  const good = liepin(['北京'], '北京').jobs[0]
  const result = batch(
    platformAdapter('liepin'),
    1,
    ['broken', 'valid'],
    (value) => {
      if (value === 'broken') throw new TypeError('Malformed field type')
      return good
    },
    true,
  )
  expect(result.jobs).toEqual([good])
  expect(result.rejectedCount).toBe(1)
  expect(captureError).toHaveBeenCalledWith(expect.any(TypeError), {
    operation: 'discovery.liepin.item-parse',
    level: 'warn',
  })
})
it('continues filtered pages according to native pagination and source budgets', () => {
  const budget = new RoundBudget()
  for (let i = 1; i <= 3; i++) {
    const result = liepin(['上海'], '北京')
    expect(budget.saved({ ...result, page: i, hasMore: true }, 1, false)).toBe('more')
  }
  expect(budget.exhausted).toBe(true)
  expect(budget.jobs).toBe(3)
})
it.each([
  [
    'boss',
    (list: unknown[]) => bossResponse({ code: 0, zpData: { hasMore: false, jobList: list } }, 1),
  ],
  [
    'liepin',
    (list: unknown[]) => liepinResponse({ flag: 1, data: { data: { jobCardList: list } } }, 1, ''),
  ],
  [
    'wuyou',
    (list: unknown[]) =>
      wuyouResponse(
        { status: '1', resultbody: { job: { items: list, totalCount: list.length } } },
        1,
        20,
        '',
      ),
  ],
  ['zhilian', (list: unknown[]) => zhilianResponse({ code: 200, data: { list, isEndPage: 1 } }, 1)],
] as const)(
  '%s rejects an unrecognizable nonempty batch but accepts a real empty list',
  (_platform, parse) => {
    expect(() => parse([null, { unexpected: 'value' }])).toThrowError(
      expect.objectContaining({ state: 'parse_error', message: 'response_contract_changed' }),
    )
    expect(parse([])).toMatchObject({ jobs: [], sourceIds: [], rawCount: 0, rejectedCount: 0 })
  },
)
it('reports a batch accounting mismatch as a website request failure', () => {
  const result = liepin(['北京'], '北京')
  expect(() => new RoundBudget().saved({ ...result, rawCount: 2 }, 1, false)).toThrowError(
    expect.objectContaining({ state: 'network_error', message: 'batch_accounting_mismatch' }),
  )
})
it('does not treat an entirely filtered Liepin page as the end', async () => {
  const filtered = liepin(['上海'], '北京')
  const transport = {
    load: vi.fn(),
    response: vi
      .fn()
      .mockResolvedValue({ ...filtered, submitted: { keyword: 'Java', cityCode: '010' } }),
    until: vi.fn().mockResolvedValue({ hasMore: true }),
  } as unknown as SearchPage
  const result = await new LiepinSearch(transport, { keyword: 'Java', city: '北京' }).read(
    AbortSignal.timeout(2000),
  )
  expect(result.jobs).toHaveLength(0)
  expect(result.hasMore).toBe(true)
  expect(transport.until).toHaveBeenCalledTimes(2)
})
