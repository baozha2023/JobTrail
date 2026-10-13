import { load } from 'cheerio'
import { createCityLookup } from '../../../shared/discovery-city-catalog'
import cityCatalog from '../../../shared/discovery-cities/yupao.json'
import {
  SourceError,
  type JobIdentityPolicy,
  type NativeQuery,
  type ParsedBatch,
  type PlatformAdapter,
  type PlatformSearch,
  type SearchRequest,
  type SearchTransport,
  type SourceBatch,
} from '../adapter'
import { batch, job, record, rows, text } from '../parsing'
import { pageScript, type PageRules, type PageSnapshot } from '../extraction'
import { api, origin, yupaoAccount, yupaoData, yupaoQr } from './yupao/protocol'

const cities = createCityLookup(cityCatalog)
const identity: JobIdentityPolicy = {
  id: 'yupao',
  domains: ['yupao.com', 'yupaowang.com'],
  canonicalJob(url) {
    const id = /^\/zhaogong\/([1-9]\d{0,29})(?:\/[a-zA-Z0-9_-]+)?\.html$/.exec(url.pathname)?.[1]
    return url.hostname === 'www.yupao.com' && id
      ? { url: `${origin}/zhaogong/${id}.html`, externalId: id }
      : null
  },
}
const decimal = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? String(value)
    : text(value)
function plainText(value: unknown): string {
  // Yupao returns keyword highlights as HTML even in structured display fields.
  // Parse once so tags disappear while escaped literal text remains intact.
  const $ = load(text(value), {}, false)
  $('script,style,template,noscript').remove()
  $('br,p,div,li').after('\n')
  return $.root()
    .text()
    .replace(/\u00a0/g, ' ')
    .trim()
}
function tags(values: unknown[]) {
  const names = values.map((v) => plainText(record(v).name)).filter(Boolean)
  return {
    experience:
      names.find((v) =>
        /^(经验不限|不限经验|应届生?|\d+[-~至]\d+年|\d+年以上|\d+年以内)$/.test(v),
      ) ?? '',
    education:
      names.find((v) =>
        /^(学历不限|不限学历|博士|硕士|研究生|本科|大专|中专|高中|初中)(及以上|以上)?$/.test(v),
      ) ?? '',
    recruitment: names.find((v) => /^(校招|校园招聘|社招|社会招聘)$/.test(v)) ?? '',
    employment: names.find((v) => /^(全职|兼职|实习|劳务|外包)$/.test(v)) ?? '',
  }
}
export function yupaoRequest(
  request: SearchRequest,
  query: NativeQuery,
  page: number,
  cityCode?: string,
): boolean | null {
  const url = new URL(request.url)
  if (
    url.origin !== api ||
    url.pathname !== '/job/v2/search/job/search' ||
    request.method !== 'POST'
  )
    return null
  let data: Record<string, unknown>
  try {
    data = record(JSON.parse(request.body))
  } catch {
    return false
  }
  const areas = Array.isArray(data.areaIds) ? data.areaIds.map(decimal) : []
  const expected = query.city ? cities.code(query.city) : cityCode
  return (
    data.keywords === query.keyword &&
    data.currentPage === page &&
    data.pageSize === 15 &&
    areas.length === 1 &&
    /^\d+$/.test(areas[0]) &&
    (!expected || areas[0] === expected) &&
    (!query.city || !!expected) &&
    Array.isArray(data.occV2) &&
    data.occV2.length === 0 &&
    !!data.filterCondition &&
    typeof data.filterCondition === 'object' &&
    !Array.isArray(data.filterCondition) &&
    Object.keys(data.filterCondition).length === 0 &&
    Object.keys(data).every((key) =>
      [
        'keywords',
        'currentPage',
        'pageSize',
        'areaIds',
        'occV2',
        'filterCondition',
        'token',
      ].includes(key),
    )
  )
}
export function yupaoResponse(value: unknown, page: number): ParsedBatch {
  const data = record(yupaoData(value)),
    source = rows(data.list)
  if (
    !Number.isSafeInteger(data.total) ||
    Number(data.total) < 0 ||
    source.length > 15 ||
    (!source.length && (page - 1) * 15 < Number(data.total)) ||
    (data.total === 0 && source.length)
  )
    throw new SourceError('parse_error', 'response_contract_changed')
  return batch(
    identity,
    page,
    source,
    (value) => {
      const r = record(value),
        id = decimal(r.jobId)
      if (!/^[1-9]\d{0,29}$/.test(id)) return null
      const labels = Array.isArray(r.showTags) ? r.showTags : []
      const company = record(r.companyInfo)
      return job(identity, {
        url: `${origin}/zhaogong/${id}.html`,
        title: plainText(r.title),
        company:
          r.checkDegreeStatus === 2
            ? plainText(company.brandName) || plainText(company.enterpriseName)
            : '',
        city: plainText(r.address),
        salary: plainText(record(labels.find((v) => record(v).type === 1)).name),
        ...tags(labels),
        jd: plainText(r.detail),
        detailRead: false,
      })
    },
    page * 15 < Number(data.total),
  )
}

export class YupaoSearch implements PlatformSearch {
  private pageNumber = 1
  private ready = false
  private cityCode = ''
  private pending?: SourceBatch
  constructor(
    private page: SearchTransport,
    private query: NativeQuery,
  ) {}
  private async inputReady(selector: string, signal: AbortSignal) {
    // Next renders the form on the server before React installs its handlers.
    // A click against that first DOM can silently do nothing or lose the input.
    await this.page.until(
      () =>
        this.page.evaluate<boolean>(
          `(()=>{const e=document.querySelector(${JSON.stringify(selector)});return !!e && document.readyState==='complete' && Object.keys(e).some(k=>k.startsWith('__reactProps$'))})()`,
          signal,
        ),
      signal,
    )
  }
  async read(signal: AbortSignal): Promise<SourceBatch> {
    if (this.pending) return this.pending
    const city = this.query.city ? cities.find(this.query.city) : undefined
    if (this.query.city && !city) throw new SourceError('unsupported_city')
    if (!this.ready) {
      await this.page.load(`${origin}/`, signal)
      await this.inputReady('#homeSearchBox input', signal)
      await this.page.fill(
        '#homeSearchBox input[placeholder="搜索职位、公司"]',
        this.query.keyword,
        signal,
      )
      await this.page.click('#homeSearchBox > span', '搜索', signal)
      await this.page.until(
        () =>
          this.page.evaluate<boolean>(
            `!!document.querySelector('#jobRecPageSearchInput input') && location.pathname.startsWith('/topic/')`,
            signal,
          ),
        signal,
      )
      await this.inputReady('#jobRecPageSearchInput input', signal)
      const originalCity = await this.page.evaluate<string>(
        `document.querySelector('.abhha .abhhc')?.textContent.trim() || ''`,
        signal,
      )
      const selectedCity = city ?? cities.find(originalCity)
      if (!selectedCity && originalCity !== '全国') throw new SourceError('scope_unverified')
      // Clearing the site's advanced filters also resets its city to 全国.
      // Restore either the requested city or the actual default captured above.
      const clear = await this.page.evaluate<boolean>(
        `[...document.querySelectorAll('#jobRecFilters .ahdd')].some(e=>e.getBoundingClientRect().width>0)`,
        signal,
      )
      if (clear) {
        await this.page.click('#jobRecFilters .ahdd', '清空筛选条件', signal)
        await this.page.until(
          () =>
            this.page.evaluate<boolean>(
              `location.pathname==='/topic/a1c0/' && document.querySelector('.abhha .abhhc')?.textContent.trim()==='全国'`,
              signal,
            ),
          signal,
        )
      }
      if (selectedCity) {
        await this.page.click('.abhha .abhhc', null, signal)
        await this.page.click('.adhie .adhjc', '热门城市', signal)
        await this.page.until(
          () =>
            this.page.evaluate<boolean>(
              `!!document.querySelector('.adhie .adhjg .adhjh')?.getBoundingClientRect().width`,
              signal,
            ),
          signal,
        )
        const hot = await this.page.evaluate<boolean>(
          `[...document.querySelectorAll('.adhie .adhjh')].some(e=>e.textContent.trim()===${JSON.stringify(selectedCity.platformName)} && e.getBoundingClientRect().width>0)`,
          signal,
        )
        if (!hot) {
          const group = ['ABCDE', 'FGHJ', 'KLMN', 'PQRST', 'WXYZ'].find((group) =>
            group.includes(selectedCity.initial),
          )
          if (!group) throw new SourceError('unsupported_city')
          await this.page.click('.adhie .adhjc', group, signal)
        }
        await this.page.click('.adhie .adhjh', selectedCity.platformName, signal)
        await this.page.until(
          () =>
            this.page.evaluate<boolean>(
              `/^\\/topic\\/a${selectedCity.code}c0\\/$/.test(location.pathname) && document.querySelector('.abhha .abhhc')?.textContent.trim()===${JSON.stringify(selectedCity.platformName)}`,
              signal,
            ),
          signal,
        )
        await this.inputReady('#jobRecPageSearchInput input', signal)
      }
      // The first SSR list hides upstream errors; resubmit to observe the real API.
      await this.page.fill(
        '#jobRecPageSearchInput input[placeholder="搜索职位、公司"]',
        this.query.keyword,
        signal,
      )
    }
    let submittedCity = this.cityCode
    const result = await this.page.response(
      {
        request: (request) => {
          const matches = yupaoRequest(
            request,
            this.query,
            this.pageNumber,
            this.cityCode || undefined,
          )
          if (matches)
            submittedCity = decimal((record(JSON.parse(request.body)).areaIds as unknown[])[0])
          return matches
        },
        response: (body) => yupaoResponse(body, this.pageNumber),
      },
      async () => {
        if (!this.ready) await this.page.click('#jobRecPageSearchInput > span', '搜索', signal)
        else {
          // The response can arrive before React appends the cards and releases
          // its infinite-scroll loading lock. Move away before approaching the
          // footer again so a subsequent batch has a real scroll transition.
          await this.page.evaluate(
            `new Promise(resolve=>{window.scrollTo(0,0);requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true)))})`,
            signal,
          )
          await this.page.until(
            () =>
              this.page.evaluate<boolean>(
                `(()=>{const e=document.querySelector('.yp-pagelist-infinite');if(!e)return false;e.scrollIntoView({block:'end'});return true})()`,
                signal,
              ),
            signal,
          )
        }
      },
      signal,
    )
    // The associated response is the source of truth. The official frontend
    // may omit a card during rendering; that does not invalidate the batch.
    // The next read waits for the pagination control and checks its request.
    this.cityCode = submittedCity
    this.ready = true
    this.pending = {
      ...result,
      submitted: { keyword: this.query.keyword, cityCode: submittedCity },
    }
    return this.pending
  }
  commit(value: SourceBatch) {
    if (value !== this.pending) throw new Error('Uncommitted source batch')
    this.pending = undefined
    this.pageNumber++
  }
}

const rules: PageRules = {
  loginSelector: 'input[type="password"],input[name="login-code"]',
  loginUrl: '://www\\.yupao\\.com/web/login/',
  loginUrlNeedsText: false,
  authenticatedSelector: 'a[href*="/web/user-center"]',
  descriptionSelector: '.addeh',
  statusSelector: 'h1',
  tagsSelector: '.addfb',
  fields: {
    title: 'h1',
    company: '[data-unused-company]',
    city: '[data-unused-city]',
    salary: '[data-unused-salary]',
    experience: '[data-unused-experience]',
    education: '[data-unused-education]',
  },
  foldedSelector: '.addeh button',
  excludedSelector: '#mainR,.addgd,footer,script,style',
}
export function yupaoPageScript(detail: boolean): string {
  return `(${readYupaoPage.toString()})(${pageScript(rules, false)},${detail})`
}
// Only the current job's original fullData.detail is admitted. The site's desc
// and infoSeoExtra.detail can contain AI rewrites and must never replace the JD.
function readYupaoPage(state: PageSnapshot, detail: boolean): PageSnapshot {
  if (!detail || state.challenge || state.login) return state
  const obj = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  const str = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
  const plain = (value: unknown) => {
    // This function runs in the isolated website page; template content is inert.
    const fragment = document.createElement('template')
    fragment.innerHTML = str(value)
    fragment.content.querySelectorAll('script,style,template,noscript').forEach((e) => e.remove())
    fragment.content.querySelectorAll('br,p,div,li').forEach((e) => {
      e.after(document.createTextNode('\n'))
    })
    return (fragment.content.textContent || '').replace(/\u00a0/g, ' ').trim()
  }
  const id = (value: unknown) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0
      ? String(value)
      : str(value)
  let props: Record<string, unknown>
  try {
    props = obj(obj(JSON.parse(document.querySelector('#__NEXT_DATA__')?.textContent || '')).props)
  } catch {
    return state
  }
  const page = obj(props.pageProps),
    current = obj(page.ppJobInfo),
    raw = obj(current.fullData)
  const expected = /^\/zhaogong\/([1-9]\d*)(?:\/[a-zA-Z0-9_-]+)?\.html$/.exec(
    location.pathname,
  )?.[1]
  if (!expected || id(current.id) !== expected || id(raw.jobId) !== expected) return state
  const visible = (e: Element) => {
    const r = e.getBoundingClientRect()
    return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'
  }
  state.offline =
    (current.isEnd === true || obj(raw.isEnd).code === 2) &&
    [...document.querySelectorAll('h1,h2,button,span')].some(
      (e) =>
        visible(e) && /^(职位已关闭|该职位已下架|已停止招聘|职位已下架)$/.test(str(e.textContent)),
    )
  if (state.offline) return state
  const jd = plain(raw.detail)
  const rendered = [...document.querySelectorAll('.addeh')]
    .filter(visible)
    .map((e) => (e as HTMLElement).innerText || e.textContent || '')
    .join('\n')
  const complete =
    !!jd &&
    rendered.replace(/\s/g, '').includes(jd.replace(/\s/g, '')) &&
    !/展开全部|展开更多|登录后查看|付费查看/.test(rendered)
  const labels = (Array.isArray(raw.showTags) ? raw.showTags : []).map((v) => plain(obj(v).name))
  const company = plain(raw.companyBrandName) || plain(raw.companyName)
  state.detail = {
    url: location.href,
    title: plain(raw.title) || plain(current.title),
    company,
    city: plain(raw.address) || plain(current.address),
    salary: plain(current.salary),
    education:
      labels.find((v) =>
        /^(学历不限|不限学历|博士|硕士|研究生|本科|大专|中专|高中|初中)(及以上|以上)?$/.test(v),
      ) || '',
    experience:
      labels.find((v) =>
        /^(经验不限|不限经验|应届生?|\d+[-~至]\d+年|\d+年以上|\d+年以内)$/.test(v),
      ) || '',
    employment: labels.find((v) => /^(全职|兼职|实习|劳务|外包)$/.test(v)) || '',
    recruitment: labels.find((v) => /^(校招|校园招聘|社招|社会招聘)$/.test(v)) || '',
    jd,
    detailRead: complete,
    missing: {
      ...(!complete ? { jd: 'parse_error' as const } : {}),
      ...(!company ? { company: 'not_provided' as const } : {}),
    },
  }
  return state
}
const wechatHint = {
  'zh-CN': '使用微信扫码并在鱼泡小程序中确认登录。',
  'en-US': 'Scan with WeChat and confirm in the Yupao mini program.',
}
const appHint = {
  'zh-CN': '使用鱼泡直聘 APP 扫码并确认登录。',
  'en-US': 'Scan and confirm using the Yupao app.',
}
export const yupaoAdapter: PlatformAdapter = {
  ...identity,
  cities,
  accountCheckUrl: `${origin}/web/login/`,
  contractVersion: 1,
  sessionCheck: 'batch',
  remoteFilters: ['keyword', 'city'],
  checkSession: async (transport) =>
    (await yupaoAccount(transport)) ? 'authenticated' : 'login_required',
  createSearch: (page, query) => new YupaoSearch(page, query),
  pageScript: yupaoPageScript,
  qr: {
    scanHint: wechatHint,
    // Official mini-program QR images are served by this dedicated CDN.
    // This exception permits images only, never authentication or navigation.
    allowsImageUrl(value) {
      try {
        const url = new URL(value)
        return (
          url.origin === 'https://stat108.cdqlkj.cn' &&
          !url.username &&
          !url.password &&
          !url.hash &&
          url.pathname.startsWith('/r/')
        )
      } catch {
        return false
      }
    },
    methods: [
      { id: 'wechat', label: { 'zh-CN': '微信', 'en-US': 'WeChat' }, scanHint: wechatHint },
      { id: 'app', label: { 'zh-CN': '鱼泡 APP', 'en-US': 'Yupao app' }, scanHint: appHint },
    ],
    create: yupaoQr,
  },
}
