import { platformAdapter } from '../src/main/discovery/adapter-registry'
import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { bossRequest, bossResponse, BossSearch } from '../src/main/discovery/adapters/boss'
import { liepinRequest, liepinResponse } from '../src/main/discovery/adapters/liepin'
import {
  zhilianRequest,
  zhilianResponse,
  zhilianInitial,
} from '../src/main/discovery/adapters/zhilian'
import { wuyouRequest, wuyouResponse, wuyouBody } from '../src/main/discovery/adapters/wuyou'
import { SearchPage } from '../src/main/discovery/search-page'
import { SourceError, type SourceBatch } from '../src/main/discovery/adapter'
import { BatchCache, RoundBudget } from '../src/main/discovery/collection'

const query = { keyword: 'agent', city: '北京' }
const bossBody = {
  code: 0,
  zpData: {
    hasMore: true,
    jobList: [
      {
        encryptJobId: 'one',
        jobName: '智能体工程师',
        brandName: '公司',
        cityName: '北京',
        salaryDesc: '20-40K',
        jobExperience: '3-5年',
        jobDegree: '本科',
      },
    ],
  },
}
const source = (page = 1, count = 1): SourceBatch => ({
  ...bossResponse(
    {
      ...bossBody,
      zpData: {
        ...bossBody.zpData,
        jobList: Array.from({ length: count }, (_, i) => ({
          ...bossBody.zpData.jobList[0],
          encryptJobId: 'job-' + page + '-' + i,
        })),
      },
    },
    page,
  ),
  submitted: { keyword: 'agent', cityCode: '101010100' },
})

describe('official platform request contracts', () => {
  it('uses BOSS POST form fields and rejects old keywords, cities and page numbers', () => {
    const req = {
      url: 'https://www.zhipin.com/wapi/zpgeek/search/joblist.json',
      method: 'POST',
      body: 'query=agent&city=101010100&page=2',
    }
    expect(bossRequest(req, query, 2)).toBe(true)
    expect(bossRequest({ ...req, body: req.body + '&salary=405' }, query, 2)).toBe(false)
    expect(bossRequest(req, { ...query, keyword: 'Java' }, 2)).toBe(false)
    expect(bossRequest(req, { ...query, city: '上海' }, 2)).toBe(false)
    expect(bossRequest(req, query, 1)).toBe(false)
    expect(bossRequest(req, { ...query, city: '' }, 2)).toBe(true)
    expect(bossRequest({ ...req, method: 'GET' }, query, 2)).toBeNull()
    expect(bossResponse(bossBody, 2).jobs[0].title).toBe('智能体工程师')
  })
  it('checks Liepin native zero-based pagination and retains campus job links', () => {
    const req = {
      url: 'https://api-c.liepin.com/api/com.liepin.searchfront4c.pc-search-job',
      method: 'POST',
      body: JSON.stringify({
        data: {
          mainSearchPcConditionForm: { key: 'agent', dq: '010', currentPage: 2, pageSize: 40 },
        },
      }),
    }
    expect(liepinRequest(req, query, 3)).toBe(true)
    const residual = JSON.parse(req.body)
    residual.data.mainSearchPcConditionForm.salaryLow = '10'
    expect(liepinRequest({ ...req, body: JSON.stringify(residual) }, query, 3)).toBe(false)
    expect(liepinRequest(req, query, 2)).toBe(false)
    const parsed = liepinResponse(
      {
        flag: 1,
        data: {
          data: {
            jobCardList: [
              {
                job: { title: 'Agent实习', link: 'https://www.liepin.com/lptjob/85677533?track=1' },
                comp: { compName: '公司' },
              },
            ],
          },
        },
      },
      3,
      '',
    )
    expect(parsed.jobs[0].externalId).toBe('lptjob:85677533')
    expect(parsed.hasMore).toBeNull() // Only the verified official pager establishes the end.
  })
  it.each([undefined, null, '', '   ', 20000])(
    'requires BOSS re-login when a valid job has no salary text: %s',
    (salaryDesc) => {
      expect(() =>
        bossResponse(
          {
            ...bossBody,
            zpData: {
              ...bossBody.zpData,
              jobList: [
                bossBody.zpData.jobList[0],
                { ...bossBody.zpData.jobList[0], encryptJobId: 'hidden', salaryDesc },
              ],
            },
          },
          1,
        ),
      ).toThrow(expect.objectContaining({ state: 'session_expired' }))
    },
  )
  it.each(['面议', '20-40K'])('retains BOSS jobs with explicit salary text: %s', (salaryDesc) => {
    const result = bossResponse(
      {
        ...bossBody,
        zpData: {
          ...bossBody.zpData,
          jobList: [null, { ...bossBody.zpData.jobList[0], salaryDesc }],
        },
      },
      1,
    )
    expect(result.jobs[0].salary).toBe(salaryDesc)
    expect(result.rejectedCount).toBe(1)
  })
  it('accepts Zhilian official relevance results without trusting empty keyword echoes or zero SSR counts', () => {
    const req = {
      url: 'https://fe-api.zhaopin.com/c/i/search/positions',
      method: 'POST',
      body: JSON.stringify({
        S_SOU_FULL_INDEX: 'agent',
        S_SOU_WORK_CITY: '530',
        pageIndex: 1,
        eventScenario: 'pcSearchedSouSearch',
      }),
    }
    expect(zhilianRequest(req, query, 1)).toBe(true)
    expect(
      zhilianRequest(
        { ...req, body: JSON.stringify({ ...JSON.parse(req.body), S_SOU_SALARY: '10000,20000' }) },
        query,
        1,
      ),
    ).toBe(false)
    expect(
      zhilianRequest(
        { ...req, body: req.body.replace('pcSearchedSouSearch', 'recommend') },
        query,
        1,
      ),
    ).toBe(false)
    const list = [
      {
        positionUrl: 'https://www.zhaopin.com/jobdetail/CC1234.htm',
        name: '智能应用研发',
        companyName: '公司',
        workCity: '海淀',
        salary60: '20-40K',
      },
    ]
    expect(
      zhilianResponse({ code: 200, data: { kw: '', count: 0, list, isEndPage: 0 } }, 1),
    ).toMatchObject({ rawCount: 1, hasMore: true })
    const initial = {
      pageMode: 'search',
      queryParams: { kw: 'agent', jl: '530' },
      pageIndex: 1,
      positionCount: 0,
      loadingStatus: false,
      listLoadError: false,
      hasMore: true,
      positionList: list,
    }
    expect(zhilianInitial(initial, query, 1)?.jobs).toHaveLength(1)
    expect(zhilianInitial(initial, { ...query, city: '上海' }, 1)).toBeNull()
    expect(zhilianInitial({ ...initial, pageMode: 'recommend' }, query, 1)).toBeNull()
  })
  it('reads the 51job resultbody contract and uses requested page size for a short final page', () => {
    const req = {
      url: 'https://we.51job.com/api/job/search-pc?keyword=agent&jobArea=010000&pageNum=2&pageSize=20',
      method: 'GET',
      body: '',
    }
    expect(wuyouRequest(req, query, 2)).toBe(true)
    expect(wuyouRequest({ ...req, url: req.url + '&salary=08' }, query, 2)).toBe(false)
    expect(wuyouRequest(req, { ...query, city: '上海' }, 2)).toBe(false)
    const value = {
      status: '1',
      resultbody: {
        job: {
          totalCount: 21,
          items: [
            {
              jobHref: 'https://jobs.51job.com/beijing/12345.html',
              jobName: '智能体',
              companyName: '公司',
              jobAreaString: '北京',
            },
          ],
        },
      },
    }
    expect(wuyouResponse(value, 2, 20, '北京')).toMatchObject({ rawCount: 1, hasMore: false })
    expect(() => wuyouResponse({ status: '1', data: { items: [] } }, 1, 20, '')).toThrow(
      SourceError,
    )
  })
  it('distinguishes verified empty arrays from contract errors', () => {
    expect(() =>
      wuyouBody('<!doctypehtml><meta name="aliyun_waf_aa" content="challenge">'),
    ).toThrow(expect.objectContaining({ state: 'challenge' }))
    expect(() => zhilianResponse({ code: 200, data: { isVerification: 1, list: [] } }, 1)).toThrow(
      expect.objectContaining({ state: 'challenge' }),
    )
    expect(bossResponse({ code: 0, zpData: { hasMore: false, jobList: [] } }, 1)).toMatchObject({
      rawCount: 0,
      hasMore: false,
    })
    expect(() => bossResponse({ code: 0, zpData: {} }, 1)).toThrow(SourceError)
    expect(zhilianResponse({ code: 200, data: { list: [], isEndPage: 1 } }, 1)).toMatchObject({
      rawCount: 0,
      hasMore: false,
    })
  })
})

describe('whole batch advancement and cache', () => {
  it('retains a pending source batch until the save is explicitly committed', async () => {
    const response = vi.fn().mockResolvedValue(bossResponse(bossBody, 1))
    const transport = { load: vi.fn(), response } as unknown as SearchPage
    const adapter = new BossSearch(transport, query),
      signal = new AbortController().signal
    const first = await adapter.read(signal)
    expect(await adapter.read(signal)).toBe(first)
    expect(response).toHaveBeenCalledTimes(1)
    expect(() => adapter.commit({ ...first })).toThrow()
    adapter.commit(first)
    await adapter.read(signal)
    expect(response).toHaveBeenCalledTimes(2)
  })
  it('continues past 100 and preserves the whole batch that reaches the 200 candidate limit', () => {
    const budget = new RoundBudget()
    budget.saved(source(1, 110), 110, false)
    expect(budget.exhausted).toBe(false)
    budget.saved(source(2, 110), 110, false)
    expect(budget.exhausted).toBe(true)
    expect(budget.jobs).toBe(220)
    expect(budget.batches).toBe(2)
    const exact = new RoundBudget()
    exact.saved(source(1, 200), 200, false)
    expect(exact.exhausted).toBe(true)
  })
  it('still stops at three batches or two no-growth pages even below 200 candidates', () => {
    const budget = new RoundBudget()
    for (let i = 1; i <= 3; i++) budget.saved(source(i, 42), 42, false)
    expect(budget.exhausted).toBe(true)
    expect(budget.jobs).toBe(126)
    const repeated = new RoundBudget()
    expect(repeated.saved(source(), 0, false)).toBe('more')
    expect(repeated.saved(source(2), 0, false)).toBe('no_growth')
    expect(new RoundBudget().saved({ ...source(), hasMore: false }, 0, false)).toBe('completed')
    expect(new RoundBudget(1).saved(source(4), 0, false)).toBe('no_growth')
    expect(new RoundBudget(1).saved(source(1), 0, true)).toBe('more')
  })
  it('caches a contiguous prefix, isolates scopes and expires the full prefix', () => {
    const cache = new BatchCache()
    for (let i = 1; i <= 5; i++) cache.append('account-generation-1', source(i), 100 + i)
    expect(cache.read('account-generation-1', 200)?.batches.map((b) => b.page)).toEqual([
      1, 2, 3, 4, 5,
    ])
    cache.append('account-generation-1', source(7), 201)
    expect(cache.read('account-generation-1', 201)?.batches).toHaveLength(5)
    expect(cache.read('account-generation-2', 201)).toBeUndefined()
    cache.append('account-generation-1', source(2, 2), 202)
    expect(cache.read('account-generation-1', 202)?.batches.map((b) => b.jobs.length)).toEqual([
      1, 2,
    ])
    expect(cache.read('account-generation-1', 120102)).toBeUndefined()
  })
})

describe('response correlation', () => {
  function transport() {
    const protocol = Object.assign(new EventEmitter(), {
      isAttached: () => true,
      attach: vi.fn(),
      detach: vi.fn(),
      sendCommand: vi.fn(async (method: string, args?: { requestId: string }) =>
        method === 'Network.getResponseBody'
          ? { body: JSON.stringify({ id: args!.requestId }), base64Encoded: false }
          : {},
      ),
    })
    const wc = {
      debugger: protocol,
      getURL: () => 'https://site.test/',
      isDestroyed: () => false,
      executeJavaScript: async () => '',
    } as unknown as WebContents
    const request = (id: string, match: boolean) =>
      protocol.emit('message', {}, 'Network.requestWillBeSent', {
        requestId: id,
        request: {
          url: match ? 'https://site.test/search' : 'https://site.test/search?old=1',
          method: 'GET',
        },
      })
    const finish = (id: string, encodedDataLength = 20) =>
      protocol.emit('message', {}, 'Network.loadingFinished', {
        requestId: id,
        encodedDataLength,
      })
    return {
      protocol,
      page: new SearchPage(wc, platformAdapter('boss').pageScript(false)),
      request,
      finish,
    }
  }
  it('drops older responses when a later condition change is observed', async () => {
    const t = transport()
    const result = await t.page.response(
      { request: (r) => !r.url.includes('old'), response: (v) => v },
      async () => {
        t.request('old', true)
        t.request('intermediate', false)
        t.finish('old')
        t.request('current', true)
        t.finish('current')
      },
      AbortSignal.timeout(2000),
    )
    expect(result).toEqual({ id: 'current' })
    expect(t.protocol.listenerCount('message')).toBe(0)
  })
  it.each(['login_required', 'session_expired', 'challenge'] as const)(
    'preserves an official %s response when page controls become unavailable',
    async (state) => {
      const t = transport()
      await expect(
        t.page.response(
          {
            request: () => true,
            response: () => {
              throw new SourceError(state)
            },
          },
          async () => {
            t.request('current', true)
            t.finish('current')
            await new Promise((resolve) => setImmediate(resolve))
            throw new SourceError('scope_unverified', 'control_not_found')
          },
          AbortSignal.timeout(2000),
        ),
      ).rejects.toMatchObject({ state })
      expect(t.protocol.listenerCount('message')).toBe(0)
      expect(t.protocol.detach).toHaveBeenCalledOnce()
    },
  )
  it.each(['new_query', 'cancelled', 'network_error', 'challenge'] as const)(
    'does not replace a later %s with an earlier session failure',
    async (reason) => {
      const t = transport()
      const state = reason === 'new_query' ? 'scope_unverified' : reason
      await expect(
        t.page.response(
          {
            request: (r) => !r.url.includes('old'),
            response: () => {
              throw new SourceError('session_expired')
            },
          },
          async () => {
            t.request('current', true)
            t.finish('current')
            await new Promise((resolve) => setImmediate(resolve))
            if (reason === 'new_query') t.request('different-city', false)
            throw new SourceError(state)
          },
          AbortSignal.timeout(2000),
        ),
      ).rejects.toMatchObject({ state })
    },
  )
  it('detaches observers on cancellation without returning an unverified empty result', async () => {
    const t = transport(),
      controller = new AbortController()
    await expect(
      t.page.response(
        { request: () => true, response: (v) => v },
        async () => {
          controller.abort(new SourceError('cancelled'))
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ state: 'cancelled' })
    expect(t.protocol.listenerCount('message')).toBe(0)
  })
  it.each(['encoded', 'decoded', 'body_read', 'invalid_body', 'invalid_json'] as const)(
    'distinguishes transport limits/failures from unrecognizable response data: %s',
    async (failure) => {
      const t = transport()
      if (failure !== 'encoded')
        t.protocol.sendCommand.mockImplementation(async (method) => {
          if (method !== 'Network.getResponseBody') return {}
          if (failure === 'body_read') throw new Error('Response body unavailable')
          if (failure === 'invalid_body') return {}
          return {
            body: failure === 'decoded' ? 'x'.repeat(4_000_001) : '{broken',
            base64Encoded: false,
          }
        })
      await expect(
        t.page.response(
          { request: () => true, response: (v) => v },
          async () => {
            t.request('current', true)
            t.finish('current', failure === 'encoded' ? 4_000_001 : 20)
          },
          AbortSignal.timeout(2000),
        ),
      ).rejects.toMatchObject({
        state: failure === 'invalid_json' ? 'parse_error' : 'network_error',
        message: ['encoded', 'decoded'].includes(failure)
          ? 'response_too_large'
          : failure === 'invalid_json'
            ? 'response_contract_changed'
            : 'search_response_failed',
      })
      expect(t.protocol.listenerCount('message')).toBe(0)
    },
  )
})
