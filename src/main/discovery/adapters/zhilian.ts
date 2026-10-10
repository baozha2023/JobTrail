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
import cityCatalog from '../../../shared/discovery-cities/zhilian.json'
import { batch, job, record, rows, text } from '../parsing'

const cities = createCityLookup(cityCatalog)

export function zhilianRequest(
  request: SearchRequest,
  query: NativeQuery,
  page: number,
): boolean | null {
  const url = new URL(request.url)
  if (
    url.hostname !== 'fe-api.zhaopin.com' ||
    url.pathname !== '/c/i/search/positions' ||
    request.method !== 'POST'
  )
    return null
  let data: Record<string, unknown>
  try {
    data = record(JSON.parse(request.body))
  } catch {
    return false
  }
  return (
    [
      'S_SOU_SALARY',
      'S_SOU_SALARY_MIN',
      'S_SOU_SALARY_MAX',
      'S_SOU_WORK_TYPE',
      'S_SOU_EDUCATION',
      'S_SOU_WORK_EXPERIENCE',
      'S_SOU_COMPANY_TYPE',
      'S_SOU_COMPANY_SIZE',
    ].every((key) => data[key] === undefined || data[key] === null || data[key] === '') &&
    data.eventScenario === 'pcSearchedSouSearch' &&
    text(data.S_SOU_FULL_INDEX).toLowerCase() === query.keyword.toLowerCase() &&
    (!query.city || String(data.S_SOU_WORK_CITY) === cities.code(query.city)) &&
    Number(data.pageIndex) === page
  )
}
function decode(value: unknown) {
  const r = record(value)
  return job(zhilianIdentity, {
    url: text(r.positionUrl),
    title: text(r.name),
    company: text(r.companyName),
    city: text(r.workCity),
    salary: text(r.salary60),
    experience: text(r.workingExp),
    education: text(r.education),
    jd: text(r.jobSummary),
    detailRead: false,
  })
}
export function zhilianResponse(value: unknown, page: number): ParsedBatch {
  const root = record(value),
    data = record(root.data)
  if (root.code !== 200) throw new SourceError('parse_error', 'response_contract_changed')
  if (data.isVerification === true || data.isVerification === 1) throw new SourceError('challenge')
  return batch(
    zhilianIdentity,
    page,
    rows(data.list),
    decode,
    data.isEndPage === 1 ? false : data.isEndPage === 0 ? true : null,
  )
}
export function zhilianInitial(
  value: unknown,
  query: NativeQuery,
  page: number,
): ParsedBatch | null {
  const state = record(value),
    params = record(state.queryParams)
  if (
    ['sl', 'el', 'we', 'et', 'ct', 'cs'].some(
      (key) => params[key] !== undefined && params[key] !== null && params[key] !== '',
    ) ||
    state.pageMode !== 'search' ||
    text(params.kw).toLowerCase() !== query.keyword.toLowerCase() ||
    (query.city && String(params.jl) !== cities.code(query.city)) ||
    state.pageIndex !== page ||
    state.loadingStatus !== false ||
    state.listLoadError === true
  )
    return null
  // positionCount is not populated on this site's SSR path, even for a full result page.
  if (!Array.isArray(state.positionList) || typeof state.hasMore !== 'boolean') return null
  return batch(zhilianIdentity, page, state.positionList, decode, state.hasMore, {
    evidence: 'search_initial_state',
  })
}

export class ZhilianSearch implements PlatformSearch {
  private pageNumber = 1
  private pending?: SourceBatch
  private ready = false
  constructor(
    private page: SearchTransport,
    private query: NativeQuery,
  ) {}
  async read(signal: AbortSignal): Promise<SourceBatch> {
    if (this.pending) return this.pending
    if (this.query.city && cities.code(this.query.city) === undefined)
      throw new SourceError('unsupported_city')
    if (!this.ready) await this.page.load('https://www.zhaopin.com/', signal)
    let submittedCity = ''
    const result = await this.page.response(
      {
        request: (r) => {
          const matches = zhilianRequest(r, this.query, this.pageNumber)
          if (matches !== true) return matches
          submittedCity = String(record(JSON.parse(r.body)).S_SOU_WORK_CITY)
          return true
        },
        response: (v) => zhilianResponse(v, this.pageNumber),
      },
      async () => {
        if (!this.ready) {
          await this.page.fill('input.search-wrapper__input', this.query.keyword, signal)
          this.page.enter()
          await this.page.until(
            () =>
              this.page.evaluate<boolean>(
                '!!document.querySelector("input.query-sug__input")',
                signal,
              ),
            signal,
          )
          const code = cities.code(this.query.city)
          const selected = await this.page.evaluate<string>(
            'new URL(location.href).searchParams.get("jl")||""',
            signal,
          )
          if (this.query.city && selected !== code) {
            const target = cities.find(this.query.city)!
            await this.page.click('.filter-region-box .filter-select-box__trigger', null, signal)
            const dialog = '.s-dialog[aria-label="请选择地区"]'
            await this.page.until(
              () =>
                this.page.evaluate<boolean>(
                  `document.querySelectorAll('${dialog} .s-cascader__options').length>=2`,
                  signal,
                ),
              signal,
            )
            // The first column is provinces, the second is cities (including the hot group).
            const hasCity = await this.page.evaluate<boolean>(
              `[...document.querySelectorAll('${dialog} .s-cascader__options')[1].querySelectorAll('.s-cascader__option-content')].some(e=>e.textContent.trim()===${JSON.stringify(target.platformName)})`,
              signal,
            )
            if (!hasCity) {
              const province = ['香港', '澳门', '台湾'].includes(target.province)
                ? '港澳台'
                : target.province
              await this.page.click(`${dialog} .s-cascader__option-content`, province, signal)
            }
            // Scope to the city column so 吉林省 and 吉林市 cannot be confused.
            await this.page.until(
              () =>
                this.page.evaluate<boolean>(
                  `(()=>{const column=document.querySelectorAll('${dialog} .s-cascader__options')[1];const e=[...column.querySelectorAll('.s-cascader__option-content')].find(e=>e.textContent.trim()===${JSON.stringify(target.platformName)});if(!e)return false;e.click();return true})()`,
                  signal,
                ),
              signal,
            )
            // A city without districts submits immediately; otherwise choose its whole-city item.
            await this.page.until(
              () =>
                this.page.evaluate<boolean>(
                  `(()=>{const root=document.querySelector('${dialog}');if(!root||!root.getBoundingClientRect().width)return true;const e=[...root.querySelectorAll('.s-checkbutton__item')].find(e=>e.textContent.trim()===${JSON.stringify('全' + target.platformName)});if(!e)return false;e.click();return true})()`,
                  signal,
                ),
              signal,
            )
          }
        } else {
          await this.page.evaluate(
            `(()=>{const card=document.querySelector('.job-list-panel');let e=card;while(e){if(/auto|scroll/.test(getComputedStyle(e).overflowY)&&e.scrollHeight>e.clientHeight){e.scrollTo(0,e.scrollHeight);return}e=e.parentElement}window.scrollTo(0,document.documentElement.scrollHeight)})()`,
            signal,
          )
        }
      },
      signal,
      async () => {
        if (this.pageNumber !== 1) return null
        const value = await this.page.evaluate<unknown>(
          `(()=>{const s=window.__INITIAL_STATE__;return s?{pageMode:s.pageMode,queryParams:s.queryParams,pageIndex:s.pageIndex,loadingStatus:s.loadingStatus,listLoadError:s.listLoadError,hasMore:s.hasMore,positionList:s.positionList?.map(j=>({positionUrl:j.positionUrl,name:j.name,companyName:j.companyName,workCity:j.workCity,salary60:j.salary60,workingExp:j.workingExp,education:j.education,jobSummary:j.jobSummary}))}:null})()`,
          signal,
        )
        const initial = zhilianInitial(value, this.query, this.pageNumber)
        if (initial) submittedCity = String(record(record(value).queryParams).jl)
        return initial
      },
    )
    this.pending = {
      ...result,
      submitted: { keyword: this.query.keyword, cityCode: submittedCity },
    }
    this.ready = true
    return this.pending
  }
  commit(value: SourceBatch) {
    if (value !== this.pending) throw new Error('Uncommitted source batch')
    this.pageNumber++
    this.pending = undefined
  }
}

const zhilianIdentity: JobIdentityPolicy = {
  id: 'zhilian',
  domains: ['zhaopin.com', 'zhaopin.cn', 'zhaopin.com.cn'],
  canonicalJob(u) {
    if (u.hostname === 'jobs.zhaopin.com') {
      u.hostname = 'www.zhaopin.com'
      u.pathname = '/jobdetail' + u.pathname
    }
    const id = u.pathname.match(/\/(CC[\w]+|\d+)\.htm[l]?$/i)?.[1]
    if (!id) return null
    u.hash = ''
    u.search = ''
    return { url: u.href, externalId: id }
  },
}

const passport = 'https://passport.zhaopin.com'
const appID = '9f69dd17cf834693b04e06dd5e9b5728'
const qrResponse = z.object({
  code: z.number().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
})
function qrUrl(route: string, params: Record<string, string>) {
  return `${passport}${route}?${new URLSearchParams({ appID, refer: '121126445', clientType: 'n', businessSystem: '1', ...params, time: String(Date.now()) })}`
}
function createQr(transport: QrTransport): QrProtocol {
  let key = ''
  return {
    async initialize() {
      const r = await transport.json(
        qrUrl('/v4/appScan/init', { scene: '10000060' }),
        qrResponse.parse,
      )
      if (r.code !== 100000 || typeof r.data?.validateId !== 'string')
        throw new LoginError('verification')
      key = r.data.validateId
      return { image: qrImage(r.data.path, passport), expiresInMs: 300000 }
    },
    async poll() {
      const r = await transport.json(
        qrUrl('/v4/appScan/login', { validateId: key, rememberMe: 'true' }),
        qrResponse.parse,
      )
      if ([102002, 102003].includes(r.code ?? -1)) return 'expired'
      if (r.code === 102001) return 'scanned'
      if (r.code === 100000) {
        if (
          typeof r.data?.at !== 'string' ||
          !r.data.at ||
          typeof r.data.rt !== 'string' ||
          !r.data.rt
        )
          throw new LoginError('protocol')
        for (const name of ['at', 'rt']) {
          const value = r.data[name]
          if (typeof value !== 'string') throw new LoginError('protocol')
          const seconds = Number(r.data[name + 'Expire'])
          await transport.setCookie({
            url: passport,
            domain: '.zhaopin.com',
            path: '/',
            name,
            value,
            secure: true,
            expirationDate:
              Date.now() / 1000 + (Number.isFinite(seconds) && seconds > 0 ? seconds : 604800),
          })
        }
        return 'authenticated'
      }
      if (r.code !== 102004) throw new LoginError('verification')
      return 'waiting'
    },
  }
}
export const zhilianAdapter: PlatformAdapter = {
  cities,
  ...zhilianIdentity,
  accountCheckUrl: 'https://www.zhaopin.com/',
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
  createSearch: (page, query) => new ZhilianSearch(page, query),
  qr: {
    scanHint: {
      'zh-CN': '使用智联招聘 App 扫一扫并确认。',
      'en-US': 'Scan and confirm using the Zhaopin app.',
    },
    create: createQr,
    headers: () => ({
      'X-Requested-With': 'XMLHttpRequest',
      'x-zp-passport-appid': appID,
      'x-zp-refer': '121126445',
      'x-zp-client-type': 'n',
      'x-zp-business-system': '1',
    }),
  },
}
const pageRules: PageRules = {
  loginUrlNeedsText: false,
  loginSelector:
    'input[type="password"],input[autocomplete="current-password"],.login-dialog,.login-layer,.job-list-login-gate,.job-detail-login-gate__panel',
  loginUrl: '://passport\\.zhaopin\\.com/',
  authenticatedSelector:
    '.home-header__c-login .c-login__top__img,a[href*="logout"],a[href*="signout"]',
  descriptionSelector:
    '.describtion-card__detail-content,.describtion__detail-content,.job-detail-description,.job-detail .describtion',
  statusSelector: '.job-status,.job-summary__status,.job-summary__btn',
  tagsSelector:
    '.summary-planes__info li,.tag-list li,.job-labels span,.job-labels li,.job-card__tags span,.job-card__tags li,.joblist-item-jobinfo span,.job-properties span,.text-desc span,.job-qualifications span,.job-require span',
  fields: {
    title: '.summary-planes__title,.job-name h1,.name h1,.job-title h1,.cn h1',
    company: '.company-info__name,.sider-company .company-info a,.company-name,.company-title',
    city: '.summary-planes__info .workCity-link,.job-banner .text-city,.job-area,.job-address,.job-dq',
    salary: '.summary-planes__salary,.job-banner .salary,.salary,.job-salary,.cn strong',
    experience: '.job-experience,[class*="work-years"],[class*="workyear"]',
    education: '.job-education,[class*="education"]',
  },
  foldedSelector: '.job-sec button,.job-description button',
  excludedSelector: 'aside,[class*="recommend"],.jobs-deliver,.job-list,.company-intro',
}
