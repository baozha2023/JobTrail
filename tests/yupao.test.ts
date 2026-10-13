// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import {
  yupaoAdapter,
  yupaoPageScript,
  yupaoRequest,
  yupaoResponse,
  YupaoSearch,
} from '../src/main/discovery/adapters/yupao'
import { yupaoOptions, yupaoQr, yupaoSso } from '../src/main/discovery/adapters/yupao/protocol'
import type { QrTransport } from '../src/main/discovery/qr-protocol'
import type { SearchTransport } from '../src/main/discovery/adapter'
import type { PageSnapshot } from '../src/main/discovery/extraction'
import { canonicalJob } from '../src/main/discovery/platforms'

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
  window.history.replaceState({}, '', '/')
})
const row = {
  jobId: 485431773,
  title: 'Java 开发',
  address: '北京·海淀',
  detail: '列表摘要',
  checkDegreeStatus: 2,
  companyInfo: { brandName: '合成公司' },
  showTags: [
    { type: 1, name: '1-2万/月' },
    { type: 3, name: '本科' },
  ],
}
const response = (list: unknown[] = [row], total = 45) => ({ code: 0, data: { list, total } })
const query = { keyword: 'Java', city: '北京' }
const body = {
  keywords: 'Java',
  pageSize: 15,
  currentPage: 1,
  areaIds: ['2'],
  occV2: [],
  filterCondition: {},
}
const request = (data: object) => ({
  url: 'https://yupao-prod.yupaowang.com/job/v2/search/job/search',
  method: 'POST',
  body: JSON.stringify(data),
})

it('requires the actual keyword, city, page and empty advanced filters; rejects recommendations', () => {
  expect(yupaoRequest(request(body), query, 1)).toBe(true)
  for (const patch of [
    { keywords: '销售' },
    { currentPage: 2 },
    { areaIds: ['25'] },
    { areaIds: ['2', '25'] },
    { recommended: 1 },
    { filterCondition: { salary: [1] } },
    { occV2: [123] },
  ])
    expect(yupaoRequest(request({ ...body, ...patch }), query, 1)).toBe(false)
  expect(yupaoRequest(request(body), { ...query, city: '' }, 1)).toBe(true)
  expect(yupaoRequest(request({ ...body, areaIds: ['25'] }), { ...query, city: '' }, 1, '2')).toBe(
    false,
  )
  expect(
    yupaoRequest(
      { ...request(body), url: 'https://yupao-prod.yupaowang.com/job/v2/search/recommend/search' },
      query,
      1,
    ),
  ).toBeNull()
})
it('keeps source pagination separate from deduplication, original salaries and personal recruiters', () => {
  const parsed = yupaoResponse(
    response([
      row,
      row,
      {
        ...row,
        jobId: 485431774,
        checkDegreeStatus: 1,
        userName: '个人姓名',
        showTags: [{ type: 1, name: '300元/天' }],
      },
    ]),
    1,
  )
  expect(parsed).toMatchObject({ rawCount: 3, duplicateCount: 1, hasMore: true })
  expect(parsed.jobs).toHaveLength(2)
  expect(parsed.jobs[0]).toMatchObject({
    company: '合成公司',
    jd: '列表摘要',
    detailRead: false,
    education: '本科',
  })
  expect(parsed.jobs[1]).toMatchObject({ company: '', salary: '300元/天' })
  expect(yupaoResponse(response([], 0), 1)).toMatchObject({ jobs: [], hasMore: false })
  expect(yupaoResponse(response([row], 31), 3).hasMore).toBe(false)
  for (const invalid of [
    response([], 12),
    response([{ jobId: Number.MAX_SAFE_INTEGER + 2, title: '岗位' }]),
    { code: 500, data: { list: [], total: 0 } },
  ])
    expect(() => yupaoResponse(invalid, 1)).toThrow(
      expect.objectContaining({ state: 'parse_error' }),
    )
  expect(() => yupaoResponse({ code: 10160001 }, 1)).toThrow(
    expect.objectContaining({ state: 'login_required' }),
  )
  expect(() => yupaoResponse({ code: 429 }, 1)).toThrow(
    expect.objectContaining({ state: 'challenge' }),
  )
})
it('canonicalizes only official numeric job identities', () => {
  expect(
    canonicalJob('yupao', 'https://www.yupao.com/zhaogong/485431773/opaque.html?from=test'),
  ).toEqual({ url: 'https://www.yupao.com/zhaogong/485431773.html', externalId: '485431773' })
  for (const url of [
    'https://www.yupao.com/qiye/123.html',
    'https://evil.yupao.com/zhaogong/123.html',
    'https://www.yupao.com/zhaogong/a2c0/',
  ])
    expect(canonicalJob('yupao', url)).toBeNull()
})
it.each([
  ["<span style='color:#0099ff'>Java</span>", 'Java'],
  ["金蝶<span style='color:#0099ff'>java</span>开发工程师", '金蝶java开发工程师'],
  ['<SPAN class="hit"><b>Java</b></SPAN> / <span>销售</span>', 'Java / 销售'],
  ['<span>Java &amp; C++</span>&nbsp;&lt;T&gt; &#x5F00;&#21457;', 'Java & C++ <T> 开发'],
  ['<span>Java<span>开发', 'Java开发'],
  ['C++ / C# / Java，要求 1 < 2', 'C++ / C# / Java，要求 1 < 2'],
])('extracts a plain title from Yupao search markup: %s', (title, expected) => {
  const parsed = yupaoResponse(response([{ ...row, title }]), 1)
  expect(parsed.jobs[0].title).toBe(expected)
  expect(parsed.jobs[0].externalId).toBe(String(row.jobId))
  expect(parsed).toMatchObject({ rawCount: 1, rejectedCount: 0, hasMore: true })
})
it('decodes list display fields before storage and rejects titles with no visible text', () => {
  const parsed = yupaoResponse(
    response([
      {
        ...row,
        title: '<script>bad()</script><style>.hit{}</style><span>Java</span>',
        companyInfo: { brandName: '<span>研发</span>&amp;销售' },
        address: '<span>北京</span>·海淀',
        detail: '<p>职责：<span>Java</span></p><p>要求：C++<br>沟通能力</p>',
        showTags: [
          { type: 1, name: '<span>1-2万/月</span>' },
          { type: 3, name: '<span>本科</span>' },
        ],
      },
      { ...row, jobId: 485431774, title: '<span> </span><script>bad()</script>' },
    ]),
    1,
  )
  expect(parsed.jobs).toHaveLength(1)
  expect(parsed.jobs[0]).toMatchObject({
    title: 'Java',
    company: '研发&销售',
    city: '北京·海淀',
    salary: '1-2万/月',
    education: '本科',
    jd: '职责：Java\n要求：C++\n沟通能力',
    detailRead: false,
  })
  expect(parsed).toMatchObject({ rawCount: 2, rejectedCount: 1, hasMore: true })
})
it('allows the observed official QR CDN only for its image path', () => {
  const allows = yupaoAdapter.qr.allowsImageUrl!
  expect(allows('https://stat108.cdqlkj.cn/r/synthetic.png')).toBe(true)
  for (const value of [
    'http://stat108.cdqlkj.cn/r/synthetic.png',
    'https://stat108.cdqlkj.cn/login',
    'https://stat108.cdqlkj.cn.evil.test/r/synthetic.png',
    'https://user:secret@stat108.cdqlkj.cn/r/synthetic.png',
  ])
    expect(allows(value)).toBe(false)
})
function qrFixture(values: unknown[], cookie = 'synthetic-token') {
  const pending = [...values]
  const transport: QrTransport = {
    cookie: vi.fn(async () => cookie),
    json: vi.fn(async (_url, parse) => parse(pending.shift())),
    text: vi.fn(async () => ''),
    setCookie: vi.fn(async () => {}),
    scanned: vi.fn(),
  }
  return transport
}
const sso = {
  code: 0,
  data: [
    { url: 'https://passport-prod.yupao.com/account/v1/login/setCookie?ticket=synthetic-ticket' },
  ],
}
const account = { code: 0, data: { userId: 123456, role: { nowRole: 2 } } }
it.each([1, 2])(
  'confirms official account identity independently of the current role (%s)',
  async (role) => {
    const t = qrFixture([{ code: 0, data: { userId: 123456, role: { nowRole: role } } }])
    await expect(
      yupaoAdapter.checkSession!({
        ...t,
        page: vi.fn(async () => {
          throw new Error('Account endpoint should be sufficient')
        }),
      }),
    ).resolves.toBe('authenticated')
    const qr = yupaoQr(
      qrFixture([
        { code: 0, data: { sunCode: 'code', sunCodeImg: 'image', expireTime: 120 } },
        { code: 0, data: { token: 'synthetic-token' } },
        sso,
        { code: 0 },
        { code: 0, data: { userId: 123456, role: { nowRole: role } } },
      ]),
    )
    await qr.initialize()
    await expect(qr.poll()).resolves.toBe('authenticated')
  },
)
it.each([
  [{ code: 403 }, 'verification'],
  [{ code: 0, data: { userId: '0' } }, 'protocol'],
] as const)(
  'preserves the final account-check error category during QR completion (%j)',
  async (result, reason) => {
    const qr = yupaoQr(
      qrFixture([
        { code: 0, data: { sunCode: 'code', sunCodeImg: 'image', expireTime: 120 } },
        { code: 0, data: { token: 'synthetic-token' } },
        sso,
        { code: 0 },
        result,
      ]),
    )
    await qr.initialize()
    await expect(qr.poll()).rejects.toMatchObject({ reason })
  },
)
it.each(['wechat', 'app'] as const)(
  'completes %s only after the official SSO exchange, saved Session and account confirmation',
  async (method) => {
    const t = qrFixture([
      {
        code: 0,
        data: {
          qrCode: 'synthetic-qr',
          qrCodeImg: 'data:image/png;base64,aGVsbG8=',
          sunCode: 'synthetic-mini',
          sunCodeImg: 'data:image/png;base64,aGVsbG8=',
          expireTime: 90,
        },
      },
      ...(method === 'app' ? [{ code: 0, data: { headPortrait: 'public-avatar', role: 2 } }] : []),
      { code: 10010018 },
      { code: 0, data: { token: 'synthetic-token' } },
      sso,
      { code: 0 },
      account,
    ])
    const qr = yupaoQr(t, method)
    expect((await qr.initialize()).expiresInMs).toBe(method === 'wechat' ? 90000 : 120000)
    if (method === 'app')
      expect(await qr.poll()).toMatchObject({ state: 'scanned', expiresInMs: 120000 })
    expect(await qr.poll()).toBe(method === 'app' ? 'scanned' : 'waiting')
    expect(await qr.poll()).toBe('authenticated')
    expect(t.setCookie).not.toHaveBeenCalled()
    const urls = vi.mocked(t.json).mock.calls.map(([url]) => new URL(url).pathname)
    expect(urls.slice(-3)).toEqual([
      '/account/v1/login/sso',
      '/account/v1/login/setCookie',
      '/account/v1/userBase/getLoginUserInfo',
    ])
  },
)
it('rejects SSO redirects, alternate hosts, duplicate tickets and credentials before sending a token', () => {
  for (const url of [
    'https://evil.test/account/v1/login/setCookie?ticket=t',
    'http://passport-prod.yupao.com/account/v1/login/setCookie?ticket=t',
    'https://passport-prod.yupao.com/other?ticket=t',
    'https://passport-prod.yupao.com/account/v1/login/setCookie?ticket=t&ticket=u',
    'https://user:pass@passport-prod.yupao.com/account/v1/login/setCookie?ticket=t',
  ])
    expect(() => yupaoSso([{ url }])).toThrow(expect.objectContaining({ reason: 'protocol' }))
})
it('does not authenticate from a returned token when SSO failed to establish the browser Session', async () => {
  const t = qrFixture(
    [
      { code: 0, data: { sunCode: 'code', sunCodeImg: 'image', expireTime: 120 } },
      { code: 0, data: { token: 'synthetic-token' } },
      sso,
      { code: 0 },
    ],
    '',
  )
  const qr = yupaoQr(t)
  await qr.initialize()
  await expect(qr.poll()).rejects.toMatchObject({ reason: 'protocol' })
})
it('reports official QR expiration and uses the server mini code lifetime', async () => {
  const qr = yupaoQr(
    qrFixture([
      { code: 0, data: { sunCode: 'code', sunCodeImg: 'image', expireTime: 83 } },
      { code: 10010013 },
    ]),
  )
  expect(await qr.initialize()).toMatchObject({ expiresInMs: 83000 })
  expect(await qr.poll()).toBe('expired')
  expect(yupaoOptions({ ext: null }, '', '1', '2').data).toEqual({ ext: null })
  expect(yupaoAdapter.sessionCheck).toBe('batch')
  expect(yupaoAdapter.qr.methods?.map((m) => m.id)).toEqual(['wechat', 'app'])
})
it('keeps the observed APP unscanned response waiting without extending its lifetime', async () => {
  const qr = yupaoQr(
    qrFixture([
      { code: 0, data: { qrCode: 'code', qrCodeImg: 'image' } },
      { code: 10010016, data: null },
      { code: 10010016, data: null },
      { code: 10010017 },
    ]),
    'app',
  )
  expect(await qr.initialize()).toMatchObject({ expiresInMs: 120000 })
  expect(await qr.poll()).toBe('waiting')
  expect(await qr.poll()).toBe('waiting')
  expect(await qr.poll()).toBe('expired')
})
it.each([
  [500, 'protocol'],
  [403, 'verification'],
  [429, 'verification'],
] as const)(
  'classifies QR business code %s without disguising it as a network failure',
  async (code, reason) => {
    const qr = yupaoQr(
      qrFixture([{ code: 0, data: { qrCode: 'code', qrCodeImg: 'image' } }, { code }]),
      'app',
    )
    await qr.initialize()
    await expect(qr.poll()).rejects.toMatchObject({ reason })
  },
)
it('retries the uncommitted batch without issuing another website request', async () => {
  const page: SearchTransport = {
    evaluate: vi.fn(async () => false) as SearchTransport['evaluate'],
    load: vi.fn(),
    fill: vi.fn(),
    click: vi.fn(),
    guard: vi.fn(),
    enter: vi.fn(),
    until: vi.fn(async () => true) as SearchTransport['until'],
    response: vi.fn(async (reader) => {
      reader.request(request(body))
      return reader.response(response())
    }) as SearchTransport['response'],
  }
  const search = new YupaoSearch(page, query),
    signal = new AbortController().signal
  const first = await search.read(signal)
  expect(await search.read(signal)).toBe(first)
  expect(page.response).toHaveBeenCalledOnce()
  search.commit(first)
  expect(() => search.commit(first)).toThrow()
})
it.each(['北京', ''])(
  'restores the requested or default city after clearing filters (%s)',
  async (city) => {
    document.body.innerHTML = `<div id="homeSearchBox"><input placeholder="搜索职位、公司"><span>搜索</span></div>
    <div id="jobRecPageSearchInput"><input placeholder="搜索职位、公司"><span>搜索</span></div>
    <div class="abhha"><span class="abhhc">上海</span></div>
    <div id="jobRecFilters"><button class="ahdd">清空筛选条件</button></div>
    <div class="adhie"><button class="adhjc">热门城市</button><div class="adhjg"><button class="adhjh">北京</button><button class="adhjh">上海</button></div></div>
    <a href="/zhaogong/485431773.html">Java</a><div class="yp-pagelist-infinite"></div>`
    for (const input of document.querySelectorAll('input'))
      Object.assign(input, { __reactProps$test: {} })
    vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete')
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 100,
      height: 20,
    } as DOMRect)
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0)
      return 1
    })
    const scroll = vi.fn()
    document.querySelector('.yp-pagelist-infinite')!.scrollIntoView = scroll
    document
      .querySelector('#homeSearchBox > span')!
      .addEventListener('click', () => window.history.replaceState({}, '', '/topic/a25c0/'))
    const label = document.querySelector('.abhhc')!
    document.querySelector('.ahdd')!.addEventListener('click', () => {
      label.textContent = '全国'
      window.history.replaceState({}, '', '/topic/a1c0/')
    })
    for (const item of document.querySelectorAll('.adhjh'))
      item.addEventListener('click', () => {
        label.textContent = item.textContent
        window.history.replaceState(
          {},
          '',
          `/topic/a${item.textContent === '北京' ? '2' : '25'}c0/`,
        )
      })
    let pageNumber = 1
    const page: SearchTransport = {
      evaluate: async (script) => window.eval(script),
      load: vi.fn(),
      guard: vi.fn(),
      enter: vi.fn(),
      fill: async (selector, value) => {
        ;(document.querySelector(selector) as HTMLInputElement).value = value
      },
      click: async (selector, label) => {
        const item = [...document.querySelectorAll<HTMLElement>(selector)].find(
          (e) => label === null || e.textContent === label,
        )
        expect(item).toBeDefined()
        item!.click()
      },
      until: async (read) => {
        const result = await read()
        expect(result).toBeTruthy()
        return result as never
      },
      response: async (reader, action) => {
        await action()
        expect(
          reader.request(
            request({
              ...body,
              currentPage: pageNumber++,
              areaIds: [label.textContent === '北京' ? '2' : '25'],
            }),
          ),
        ).toBe(true)
        // The official frontend need not render every response row. Pagination
        // still follows the associated response, including its final job.
        return reader.response(response([row, { ...row, jobId: 485431775 }]))
      },
    }
    const search = new YupaoSearch(page, { keyword: 'Java', city }),
      signal = new AbortController().signal
    const first = await search.read(signal)
    expect(first.jobs).toHaveLength(2)
    expect(first.submitted.cityCode).toBe(city ? '2' : '25')
    search.commit(first)
    expect((await search.read(signal)).page).toBe(2)
    expect(window.scrollTo).toHaveBeenCalledWith(0, 0)
    expect(scroll).toHaveBeenCalledOnce()
  },
)
it('reads only the original JD for the matching job and leaves personal company information missing', () => {
  window.history.replaceState({}, '', '/zhaogong/485431773.html')
  document.body.innerHTML =
    '<h1>开发工程师</h1><div class="addeh">原始职责与要求</div><div class="addgd">AI 总结：推荐岗位</div><script id="__NEXT_DATA__" type="application/json"></script>'
  const data = {
    props: {
      pageProps: {
        ppJobInfo: {
          id: 485431773,
          title: '开发工程师',
          desc: 'AI 总结',
          salary: '1-2万/月',
          username: '个人姓名',
          fullData: {
            jobId: 485431773,
            detail: '原始职责与要求',
            title: '开发工程师',
            showTags: [],
            infoSeoExtra: { detail: 'AI 总结' },
          },
        },
        ppRecTopJobList: [{ detail: '推荐岗位' }],
      },
    },
  }
  document.querySelector('#__NEXT_DATA__')!.textContent = JSON.stringify(data)
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 100,
    height: 50,
  } as DOMRect)
  const state = window.eval(yupaoPageScript(true)) as PageSnapshot
  expect(state.detail).toMatchObject({
    jd: '原始职责与要求',
    company: '',
    detailRead: true,
    missing: { company: 'not_provided' },
  })
  data.props.pageProps.ppJobInfo.fullData.jobId = 999
  document.querySelector('#__NEXT_DATA__')!.textContent = JSON.stringify(data)
  expect((window.eval(yupaoPageScript(true)) as PageSnapshot).detail).toEqual({})
})
it('keeps highlighted detail fields plain without replacing the original JD with AI content', () => {
  window.history.replaceState({}, '', '/zhaogong/485431773.html')
  document.body.innerHTML =
    '<h1>Java 开发</h1><div class="addeh">职责：Java &amp; C++\n要求：沟通能力</div><script id="__NEXT_DATA__" type="application/json"></script>'
  document.querySelector('#__NEXT_DATA__')!.textContent = JSON.stringify({
    props: {
      pageProps: {
        ppJobInfo: {
          id: 485431773,
          title: '<span>备用标题</span>',
          salary: '<span>1-2万/月</span>',
          fullData: {
            jobId: 485431773,
            title: "<span style='color:#0099ff'>Java</span>&nbsp;开发",
            companyBrandName: '<span></span>',
            companyName: '<span>研发</span>&amp;销售',
            address: '<span>北京</span>·海淀',
            detail: '<p>职责：<span>Java &amp; C++</span></p><p>要求：沟通能力</p>',
            showTags: [{ name: '<span>本科</span>' }],
            infoSeoExtra: { detail: 'AI 总结' },
          },
        },
      },
    },
  })
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 100,
    height: 50,
  } as DOMRect)
  const state = window.eval(yupaoPageScript(true)) as PageSnapshot
  expect(state.detail).toMatchObject({
    title: 'Java 开发',
    company: '研发&销售',
    city: '北京·海淀',
    salary: '1-2万/月',
    education: '本科',
    jd: '职责：Java & C++\n要求：沟通能力',
    detailRead: true,
    missing: {},
  })
})
