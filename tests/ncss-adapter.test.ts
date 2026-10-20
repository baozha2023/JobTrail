// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ncssAdapter } from '../src/main/discovery/adapters/ncss'
import { ncssResponse } from '../src/main/discovery/adapters/ncss/parsing'
import { ncssParameters, ncssRequest, NcssSearch } from '../src/main/discovery/adapters/ncss/search'
import { ncssAccount, ncssQr } from '../src/main/discovery/adapters/ncss/protocol'
import type { AccountTransport, SearchTransport } from '../src/main/discovery/adapter'
import type { PageSnapshot } from '../src/main/discovery/extraction'
import type { QrTransport, QrPageTransport } from '../src/main/discovery/qr-protocol'

const row = {
  jobId: 'SyntheticJob123',
  jobName: 'Java开发',
  recName: '合成公司',
  areaCodeName: '北京',
  degreeName: '博士及以上',
  lowMonthPay: 3,
  highMonthPay: 6,
  recruitType: '0',
  sourcesName: null,
  sourcesType: null,
}
const response = (list: unknown[] = [row], page = 1) => ({
  flag: true,
  global: [],
  data: { list, pagenation: { offset: page, limit: 10, count: 500, total: 50 } },
})
const query = { keyword: 'Java', city: '北京' }
const request = (parameters: URLSearchParams) => ({
  method: 'GET',
  url: 'https://job.ncss.cn/student/jobs/jobslist/ajax/?' + parameters,
  body: '',
})
afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

it('requires exactly the screenshot scope and rejects expanded, duplicated or stale requests', () => {
  const params = ncssParameters(query, 1)
  expect(Object.fromEntries(params)).toMatchObject({
    sourcesName: '0',
    sourcesType: '',
    recruitType: '0',
    jobType: '',
    areaCode: '11',
    limit: '10',
    offset: '1',
  })
  expect(ncssRequest(request(params), query, 1)).toBe(true)
  params.set('_', '1790000000000')
  expect(ncssRequest(request(params), query, 1)).toBe(true)
  for (const [key, value] of [
    ['sourcesName', ''],
    ['recruitType', '1'],
    ['jobType', '01'],
    ['areaCode', '31'],
    ['offset', '2'],
    ['monthPay', '10-15'],
    ['unknown', '1'],
  ]) {
    const wrong = new URLSearchParams(params)
    wrong.set(key, value)
    expect(ncssRequest(request(wrong), query, 1)).toBe(false)
  }
  params.append('sourcesName', '0')
  expect(ncssRequest(request(params), query, 1)).toBe(false)
  expect(ncssParameters({ ...query, city: '广州' }, 1).get('areaCode')).toBe('4401')
  expect(ncssParameters({ ...query, city: '济源' }, 1).get('areaCode')).toBe('419001')
  expect(ncssParameters({ ...query, city: '' }, 1).get('areaCode')).toBe('')
  expect(() => ncssParameters({ ...query, city: '不存在' }, 1)).toThrow('unsupported_city')
})
it('rejects complete rows with mismatched consumed types while preserving legal poor-quality values', () => {
  for (const [field, invalid] of [
    ['jobId', 123],
    ['jobName', {}],
    ['recName', []],
    ['areaCodeName', 1],
    ['degreeName', true],
    ['lowMonthPay', '3'],
    ['highMonthPay', '6'],
    ['sourcesName', 0],
    ['sourcesType', 0],
    ['recruitType', 0],
  ]) {
    const parsed = ncssResponse(response([{ ...row, [String(field)]: invalid }, row]), 1)
    expect(parsed).toMatchObject({ rawCount: 2, rejectedCount: 1 })
    expect(parsed.jobs).toHaveLength(1)
  }
  expect(
    ncssResponse(response([{ ...row, lowMonthPay: 99.9, highMonthPay: 99.9, unused: {} }]), 1)
      .jobs[0].salary,
  ).toBe('99.9-99.9K/月')
  expect(ncssResponse(response(), 1).jobs[0]).toMatchObject({
    salary: '3-6K/月',
    education: '博士及以上',
    recruitment: '',
    employment: '',
    detailRead: false,
  })
  expect(
    ncssResponse(response([{ ...row, lowMonthPay: 0, highMonthPay: 0 }]), 1).jobs[0].salary,
  ).toBe('面议')
  expect(
    ncssResponse(response([{ ...row, areaCodeName: null, degreeName: null }]), 1).jobs[0].city,
  ).toBe('')
  for (const change of [
    { recruitType: '1' },
    { sourcesName: 'another-source' },
    { sourcesType: '1' },
    { recName: '' },
  ])
    expect(() => ncssResponse(response([{ ...row, ...change }]), 1)).toThrow(
      'response_contract_changed',
    )
})
it('does not trust totals or short pages and distinguishes empty batches from malformed data', () => {
  expect(ncssResponse(response(), 1).hasMore).toBe(true)
  const unused = response()
  expect(
    ncssResponse(
      {
        ...unused,
        global: null,
        data: {
          ...unused.data,
          pagenation: { offset: 1, limit: 10, count: 'unreliable', total: null },
          newUnusedField: { arbitrary: true },
        },
      },
      1,
    ).jobs,
  ).toHaveLength(1)
  expect(ncssResponse(response([], 2), 2)).toMatchObject({ page: 2, rawCount: 0, hasMore: false })
  expect(() => ncssResponse(response([row], 2), 1)).toThrow('response_contract_changed')
  expect(() => ncssResponse({ flag: true, data: { list: {} } }, 1)).toThrow(
    'response_contract_changed',
  )
  expect(() => ncssResponse({ flag: false, global: [{ des: '请登录后查看' }] }, 1)).toThrow(
    'login_required',
  )
  expect(() => ncssResponse({ flag: false, global: [{ des: '请完成验证' }] }, 1)).toThrow(
    'challenge',
  )
  expect(ncssResponse(response([row, row]), 1)).toMatchObject({
    duplicateCount: 1,
    rejectedCount: 0,
    rawCount: 2,
  })
})
it('uses official controls and keeps pending batches until the durable commit', async () => {
  let number = 0
  const page: SearchTransport = {
    load: vi.fn(),
    guard: vi.fn(),
    fill: vi.fn(),
    click: vi.fn(),
    enter: vi.fn(),
    evaluate: vi.fn(),
    until: vi.fn(),
    response: vi.fn(async (reader, action) => {
      await action()
      return reader.response(response([row], ++number))
    }),
  }
  const search = new NcssSearch(page, query),
    signal = new AbortController().signal
  const first = await search.read(signal)
  expect(await search.read(signal)).toBe(first)
  expect(page.load).toHaveBeenCalledOnce()
  expect(page.click).toHaveBeenCalledWith('.sourceList[data-sourcesName="0"]', null, signal)
  expect(page.click).toHaveBeenCalledWith('.recruitType[data-type="0"]', null, signal)
  expect(() => search.commit({ ...first })).toThrow('Uncommitted')
  search.commit(first)
  expect((await search.read(signal)).page).toBe(2)
  expect(page.click).toHaveBeenLastCalledWith('#page a.next', null, signal)
  await expect(search.read(AbortSignal.abort())).rejects.toThrow()
})
beforeEach(() =>
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 20,
    height: 20,
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 20,
    bottom: 20,
    toJSON() {},
  }),
)
const snapshot = () => (0, eval)(ncssAdapter.pageScript(true)) as PageSnapshot
it('reads only the current detail and preserves positive student account evidence', async () => {
  document.body.innerHTML = `<div id="mask4" style="display:none">true</div><div id="maskUser" style="display:none">true</div><div class="job"><ul class="work"><li id="jobName">原始岗位</li><li>[<span>实习</span>]</li></ul><ul class="salary"><li><span>99.9k-99.9k</span></li><li>本科及以上</li></ul><div class="site-tag">北京市海淀区</div></div><div id="realCorpName">真正公司</div><div class="jobdetail-box"><pre class="mainContent">完整职责\n第二行</pre></div><div class="modal"><span class="corpName">错误公司</span></div><aside>推荐其他岗位</aside>`
  expect(snapshot()).toMatchObject({
    authenticated: true,
    login: false,
    detail: {
      title: '原始岗位',
      company: '真正公司',
      city: '北京市海淀区',
      salary: '99.9k-99.9k',
      employment: '实习',
      jd: '完整职责\n第二行',
      detailRead: true,
    },
  })
  document.body.insertAdjacentHTML(
    'beforeend',
    '<aside><div class="jobdetail-box"><p class="mainContent">推荐职责不应混入</p></div></aside><div class="modal"><div class="jobdetail-box"><p class="mainContent">投递弹窗不应混入</p></div></div>',
  )
  expect(snapshot().detail?.jd).toBe('完整职责\n第二行')
  const account: AccountTransport = {
    page: vi.fn(async () => snapshot()),
    json: vi.fn(),
    cookie: vi.fn(),
  }
  expect(await ncssAccount(account)).toBe('authenticated')
  document.querySelector('#maskUser')!.textContent = 'false'
  expect(snapshot()).toMatchObject({ authenticated: false, login: true, detail: {} })
  document.body.innerHTML = '<h1>404</h1>'
  expect(snapshot().offline).toBe(false)
})

function qrFixture() {
  const state = 'SyntheticState123'
  let urls: string[] = []
  const page: QrPageTransport = { load: vi.fn(), history: () => urls, read: vi.fn() }
  const read = vi.mocked(page.read)
  const t = {
    page: () => page,
    verification: (url: string): never => {
      throw new Error('verification:' + new URL(url).hostname)
    },
  } as unknown as QrTransport
  const qr = ncssQr(t)
  const link =
    'https://open.weixin.qq.com/connect/qrconnect?' +
    new URLSearchParams({
      redirect_uri: 'https://account.chsi.com.cn/passport/login?client_name=wechat',
      state,
    })
  read
    .mockResolvedValueOnce({ authenticated: false })
    .mockResolvedValueOnce(link)
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce('https://open.weixin.qq.com/connect/qrcode/SyntheticUuid123')
  return {
    qr,
    read,
    page,
    setUrls: (next: string[]) => {
      urls = next
    },
    callback: (next = state) =>
      'https://account.chsi.com.cn/passport/login?client_name=wechat&code=private-code&state=' +
      next,
  }
}
it('uses the same official page for QR and callback, requiring matching state and student evidence', async () => {
  const f = qrFixture()
  expect(await f.qr.initialize()).toMatchObject({
    image: 'https://open.weixin.qq.com/connect/qrcode/SyntheticUuid123',
  })
  f.setUrls([f.callback()])
  f.read.mockResolvedValueOnce({ authenticated: true })
  expect(await f.qr.poll()).toBe('authenticated')
  expect(f.page.load).toHaveBeenCalledExactlyOnceWith('https://job.ncss.cn/student/signin.html')
  const wrong = qrFixture()
  await wrong.qr.initialize()
  wrong.setUrls([wrong.callback('mismatched')])
  await expect(wrong.qr.poll()).rejects.toMatchObject({ reason: 'protocol' })
  const missing = qrFixture()
  await missing.qr.initialize()
  missing.read.mockResolvedValueOnce({ authenticated: true })
  await expect(missing.qr.poll()).rejects.toMatchObject({ reason: 'protocol' })
  const linked = qrFixture()
  linked.read.mockReset().mockResolvedValueOnce({ authenticated: true })
  expect(await linked.qr.initialize()).toEqual({ state: 'authenticated' })
  const transient = qrFixture()
  await transient.qr.initialize()
  transient.read.mockRejectedValueOnce(new Error('Execution context was destroyed'))
  expect(await transient.qr.poll()).toBe('waiting')
  const duplicateCode = qrFixture()
  await duplicateCode.qr.initialize()
  duplicateCode.setUrls([duplicateCode.callback() + '&code=another'])
  await expect(duplicateCode.qr.poll()).rejects.toMatchObject({ reason: 'protocol' })
  const binding = qrFixture()
  await binding.qr.initialize()
  const now = vi.spyOn(Date, 'now').mockReturnValue(1000)
  binding.setUrls([binding.callback()])
  binding.read
    .mockResolvedValueOnce({
      url: 'https://account.chsi.com.cn/passport/login',
      authenticated: false,
      login: true,
    })
    .mockResolvedValueOnce({ scanned: false, expired: false })
  expect(await binding.qr.poll()).toBe('waiting')
  now.mockReturnValue(8000)
  binding.read.mockResolvedValueOnce({
    url: 'https://account.chsi.com.cn/passport/login',
    authenticated: false,
    login: true,
  })
  await expect(binding.qr.poll()).rejects.toThrow('verification:account.chsi.com.cn')
})
