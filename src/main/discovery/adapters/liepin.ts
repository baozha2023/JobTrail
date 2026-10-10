import { randomUUID } from 'node:crypto'
import { allowedUrl } from '../identity'
import type { VerificationPage } from '../adapter'
import { z } from 'zod'
import {
  SourceError,
  type PlatformAdapter,
  type JobIdentityPolicy,
  type NativeQuery,
  type PlatformSearch,
  type SearchRequest,
  type SourceBatch,
  type ParsedBatch,
  type SearchTransport,
} from '../adapter'
import { pageScript, type PageRules } from '../extraction'
import { LoginError, qrImage, type QrProtocol, type QrTransport } from '../qr-protocol'
import { createCityLookup } from '../../../shared/discovery-city-catalog'
import cityCatalog from '../../../shared/discovery-cities/liepin.json'
import { batch, job, record, rows, text } from '../parsing'

const cities = createCityLookup(cityCatalog)

export function liepinRequest(
  request: SearchRequest,
  query: NativeQuery,
  page: number,
): boolean | null {
  const url = new URL(request.url)
  if (
    url.hostname !== 'api-c.liepin.com' ||
    url.pathname !== '/api/com.liepin.searchfront4c.pc-search-job' ||
    request.method !== 'POST'
  )
    return null
  let data: Record<string, unknown>
  try {
    data = record(record(record(JSON.parse(request.body)).data).mainSearchPcConditionForm)
  } catch {
    return false
  }
  return (
    [
      'salaryCode',
      'salaryLow',
      'salaryHigh',
      'workYearCode',
      'eduLevel',
      'compIndustry',
      'compScale',
      'compKind',
      'jobKind',
    ].every((key) => data[key] === undefined || data[key] === null || data[key] === '') &&
    text(data.key) === query.keyword &&
    (!query.city || String(data.dq) === cities.code(query.city)) &&
    Number(data.currentPage) === page - 1
  )
}
export function liepinCityFilter(city: string): (location: string) => boolean {
  const target = city ? cities.find(city) : undefined
  if (city && !target) throw new SourceError('unsupported_city')
  const cityNames = new Set(
    [target?.platformName, target?.name, ...(target?.aliases ?? [])].map((name) =>
      name?.replace(/市$/, ''),
    ),
  )
  return (location) =>
    !target || cityNames.has(location.split(/[-·]/, 1)[0].trim().replace(/市$/, ''))
}

export function liepinResponse(value: unknown, page: number, city: string): ParsedBatch {
  const root = record(value),
    data = record(record(root.data).data)
  if (root.flag !== 1) throw new SourceError('parse_error', 'response_contract_changed')
  const acceptsCity = liepinCityFilter(city)
  return batch(
    liepinIdentity,
    page,
    rows(data.jobCardList),
    (v) => {
      const card = record(v),
        r = record(card.job),
        company = record(card.comp)
      return job(liepinIdentity, {
        url: text(r.link),
        title: text(r.title),
        company: text(company.compName),
        city: text(r.dq),
        salary: text(r.salary),
        experience: text(r.requireWorkYears),
        education: text(r.requireEduLevel),
      })
    },
    null,
    {
      // Liepin's dq is city[-district]; compare its city segment, never a substring of an address.
      accept: (item) => acceptsCity(item.city),
    },
  )
}

export class LiepinSearch implements PlatformSearch {
  private pageNumber = 1
  private pending?: SourceBatch
  private ready = false
  constructor(
    private page: SearchTransport,
    private query: NativeQuery,
  ) {}
  private async selectCity(signal: AbortSignal) {
    const target = cities.find(this.query.city)!
    const hotSelector = `li[data-selector="filter-option-item"][data-key="dq"][data-code="${target.code}"]`
    const hot = await this.page.evaluate<boolean>(
      `!!document.querySelector(${JSON.stringify(hotSelector)})`,
      signal,
    )
    if (hot) return this.page.click(hotSelector, null, signal)
    await this.page.click('#filter-option-other-city span', '其他', signal)
    await this.page.click(`.ant-city-menu-list [data-code="${target.parentCode}"]`, null, signal)
    // Selecting a city may open its districts. Only the whole-city item is accepted.
    if (target.parentCode !== target.code) {
      await this.page.click(`.data-list #code_${target.code} .ant-tag`, null, signal)
    }
    await this.page.until(
      () =>
        this.page.evaluate<boolean>(
          `(()=>{const menu=document.querySelector('.ant-city-menu-list');if(!menu||!menu.getBoundingClientRect().width)return true;const e=[...document.querySelectorAll('.data-list .ant-tag')].find(e=>e.getBoundingClientRect().width&&e.textContent.trim()===${JSON.stringify('全' + target.platformName)});if(!e)return false;e.click();return true})()`,
          signal,
        ),
      signal,
      'city_selection_not_confirmed',
    )
  }
  private async response(
    query: NativeQuery,
    action: () => Promise<void>,
    signal: AbortSignal,
  ): Promise<SourceBatch> {
    let submittedCity = ''
    const result = await this.page.response(
      {
        request: (r) => {
          const matches = liepinRequest(r, query, this.pageNumber)
          if (matches !== true) return matches
          submittedCity = String(
            record(record(record(JSON.parse(r.body)).data).mainSearchPcConditionForm).dq,
          )
          return true
        },
        response: (v) =>
          liepinResponse(
            v,
            this.pageNumber,
            submittedCity === cities.code(this.query.city) ? this.query.city : '',
          ),
      },
      action,
      signal,
    )
    return { ...result, submitted: { keyword: query.keyword, cityCode: submittedCity } }
  }
  async read(signal: AbortSignal): Promise<SourceBatch> {
    if (this.pending) return this.pending
    if (this.query.city && cities.code(this.query.city) === undefined)
      throw new SourceError('unsupported_city')
    let result: SourceBatch
    if (!this.ready) {
      await this.page.load('https://www.liepin.com/zhaopin/', signal)
      await this.page.until(
        () =>
          this.page.evaluate<boolean>(
            '!!document.querySelector("li[data-selector=filter-option-item][data-key=dq]")',
            signal,
          ),
        signal,
        'initial_list_not_ready',
      )
      result = await this.response(
        { ...this.query, city: '' },
        async () => {
          await this.page.fill(
            '.search-job-bar-container input[placeholder="搜索职位、公司"]',
            this.query.keyword,
            signal,
          )
          await this.page.click('.search-job-bar-container span', '搜索', signal)
        },
        signal,
      )
      if (this.query.city && result.submitted.cityCode !== cities.code(this.query.city))
        result = await this.response(this.query, () => this.selectCity(signal), signal)
    } else
      result = await this.response(
        this.query,
        () =>
          this.page.click(
            '.ant-pagination-next:not(.ant-pagination-disabled) button',
            null,
            signal,
          ),
        signal,
      )
    if (result.rawCount) {
      const pager = await this.page.until(
        () =>
          this.page.evaluate<{ hasMore: boolean } | null>(
            `(()=>{const current=Number(document.querySelector('.ant-pagination-item-active')?.textContent);const next=document.querySelector('.ant-pagination-next');return current===${this.pageNumber}&&next?{hasMore:next.getAttribute('aria-disabled')!=='true'&&!next.classList.contains('ant-pagination-disabled')}:null})()`,
            signal,
          ),
        signal,
        'pagination_not_confirmed',
      )
      result.hasMore = pager.hasMore
    } else result.hasMore = false
    this.pending = result
    this.ready = true
    return this.pending
  }
  commit(value: SourceBatch) {
    if (value !== this.pending) throw new Error('Uncommitted source batch')
    this.pageNumber++
    this.pending = undefined
  }
}

const liepinIdentity: JobIdentityPolicy = {
  id: 'liepin',
  domains: ['liepin.com', 'lietou-static.com'],
  canonicalJob(u) {
    const normal = u.pathname.match(/^\/job\/(\d+)\.shtml$/)?.[1]
    const recruiter = u.pathname.match(/^\/lptjob\/(\d+)$/)?.[1]
    const id = normal || (recruiter ? 'lptjob:' + recruiter : null)
    if (!id) return null
    u.hash = ''
    u.search = ''
    return { url: u.href, externalId: id }
  },
}
const pageRules: PageRules = {
  loginUrlNeedsText: false,
  loginSelector:
    'input[type="password"],input[autocomplete="current-password"],.login-dialog,.login-layer',
  loginUrl: '',
  authenticatedSelector:
    '.header-quick-menu-login .header-quick-menu-user-photo,a[href*="logout"],a[href*="signout"]',
  descriptionSelector: '.job-intro-container .paragraph,.job-description,.content.content-word',
  statusSelector: '.job-status,.job-title-box .status,.job-apply-container',
  tagsSelector:
    '.tag-list li,.job-labels span,.job-labels li,.job-card__tags span,.job-card__tags li,.joblist-item-jobinfo span,.job-properties span,.text-desc span,.job-qualifications span,.job-require span',
  fields: {
    title: '.job-name h1,.name h1,.job-title h1,.cn h1',
    company: '.sider-company .company-info a,.company-name,.company-title',
    city: '.job-banner .text-city,.job-area,.job-address,.job-dq',
    salary: '.job-banner .salary,.salary,.job-salary,.cn strong',
    experience: '.job-experience,[class*="work-years"],[class*="workyear"]',
    education: '.job-education,[class*="education"]',
  },
  foldedSelector: '.job-sec button,.job-description button',
  excludedSelector: 'aside,[class*="recommend"],.job-list,.company-intro',
}

const passport = 'https://api-passport.liepin.com/api/com.liepin.passport.qr.'
const qrParams = {
  businessId: '1100100019',
  appId: '6dp2Re4xQVd69gSD',
  keepLogin: 'true',
  backurl: '',
  programCode: 'wxmini_lp01',
}
const qrResponse = z.object({
  flag: z.number().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
})
function createQr(transport: QrTransport): QrProtocol {
  let key = ''
  return {
    async initialize() {
      const r = await transport.json(passport + 'get-mini-qrcode', qrResponse.parse, {
        data: qrParams,
      })
      if (r.flag !== 1 || typeof r.data?.key !== 'string') throw new LoginError('protocol')
      key = r.data.key
      return { image: qrImage(r.data.qrcode, 'https://www.liepin.com'), expiresInMs: 180000 }
    },
    async poll() {
      const r = await transport.json(passport + 'ack', qrResponse.parse, {
        data: { ...qrParams, key },
      })
      if (r.flag !== 1) throw new LoginError('protocol')
      const state = String(r.data?.status)
      if (['10003', '10004'].includes(state)) return 'expired'
      if (state === '10006') return 'scanned'
      if (state === '0') return 'authenticated'
      if (state !== '10001') throw new LoginError('protocol')
      return 'waiting'
    },
  }
}
export const liepinAdapter: PlatformAdapter = {
  cities,
  ...liepinIdentity,
  accountCheckUrl: 'https://www.liepin.com/',
  contractVersion: 1,
  sessionCheck: 'operation',
  remoteFilters: ['keyword', 'city'],
  async checkSession(transport) {
    const page = await transport.page(this.accountCheckUrl, pageScript(pageRules, false))
    if (page.challenge) return 'challenge'
    if (page.authenticated) return 'authenticated'
    if (page.login) return 'login_required'
    return 'unknown'
  },
  pageScript: (detail) => pageScript(pageRules, detail),
  createSearch: (page, query) => new LiepinSearch(page, query),
  verification: {
    acceptsUrl: liepinVerificationUrl,
    allowsNavigation: (url) => allowedUrl(['liepin.com'], url),
    referrer: 'https://www.liepin.com/',
    pageScript: verificationPageScript,
  },
  qr: {
    scanHint: {
      'zh-CN': '使用微信扫一扫，在猎聘小程序中确认。',
      'en-US': 'Scan with WeChat and confirm in the Liepin mini program.',
    },
    create: createQr,
    headers: (url): Record<string, string> =>
      url.startsWith(passport)
        ? {
            'X-Requested-With': 'XMLHttpRequest',
            Accept: 'application/json, text/plain, */*',
            Referer: 'https://www.liepin.com/',
            'X-Client-Type': 'web',
            'X-Fscp-Fe-Version': '',
            'X-Fscp-Version': '1.1',
            // The public passport gateway requires this web client ID after verification too.
            'X-Fscp-Std-Info': JSON.stringify({ client_id: '40108' }),
            'X-Fscp-Bi-Stat': JSON.stringify({ location: 'https://www.liepin.com/' }),
            'X-Fscp-Trace-Id': randomUUID(),
          }
        : { 'X-Requested-With': 'XMLHttpRequest' },
    challenge: (response) =>
      response.headers.has('TD-SecIntercept-Redirect')
        ? { url: liepinVerificationUrl(response.headers.get('TD-SecIntercept-Redirect')) }
        : null,
  },
}

export function liepinVerificationUrl(value: string | null): string | null {
  if (!value || value.length > 2048) return null
  try {
    const u = new URL(value)
    return allowedUrl(liepinIdentity.domains, value) &&
      u.hostname === 'safe.liepin.com' &&
      u.pathname.startsWith('/intercept/')
      ? value
      : null
  } catch {
    return null
  }
}

export function verificationPageScript(): string {
  return `(${readVerificationPage.toString()})()`
}

// The safety site is an SPA: HTTP 200 and a loaded mascot are not a challenge.
function readVerificationPage(): VerificationPage {
  const text = (document.body?.innerText || document.body?.textContent || '').trim()
  if (
    /此页面似乎不存在|我们找遍了所有地方|页面不存在|页面未找到|page\s+not\s+found/i.test(text) ||
    /^404(?:\D|$)/.test(document.title.trim())
  )
    return 'not_found'
  const visible = (e: Element) => {
    const r = e.getBoundingClientRect(),
      style = getComputedStyle(e)
    return r.width > 0 && r.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
  }
  const has = (selectors: string) => Array.from(document.querySelectorAll(selectors)).some(visible)
  if (
    (/安全验证|人机验证|滑动验证|请.{0,12}验证|拖动.{0,12}滑块|点击.{0,12}验证/.test(text) ||
      /安全中心.*验证码/.test(document.title)) &&
    has(
      'button,input,canvas,[role="button"],[class*="captcha"],[id*="captcha"],iframe[src*="captcha"],iframe[src*="verify"]',
    )
  )
    return 'challenge'
  return text || has('iframe,canvas,img,input,button') ? 'loading' : 'blank'
}
