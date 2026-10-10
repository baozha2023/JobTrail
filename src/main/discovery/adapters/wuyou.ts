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
import cityCatalog from '../../../shared/discovery-cities/wuyou.json'
import { batch, job, record, rows, text } from '../parsing'

const cities = createCityLookup(cityCatalog)

export function wuyouBody(body: string): unknown {
  if (/<meta\b[^>]*\bname=["']aliyun_waf_aa["']/i.test(body)) throw new SourceError('challenge')
  return JSON.parse(body)
}

export function wuyouRequest(
  request: SearchRequest,
  query: NativeQuery,
  page: number,
): boolean | null {
  const url = new URL(request.url)
  if (
    request.method !== 'GET' ||
    url.hostname !== 'we.51job.com' ||
    url.pathname !== '/api/job/search-pc'
  )
    return null
  return (
    ['salary', 'workYear', 'degree', 'companyType', 'companySize', 'industryType', 'jobType'].every(
      (key) => !url.searchParams.get(key),
    ) &&
    url.searchParams.get('keyword') === query.keyword &&
    (!query.city || url.searchParams.get('jobArea') === cities.code(query.city)) &&
    Number(url.searchParams.get('pageNum')) === page
  )
}
export function wuyouCityFilter(city: string): (location: string) => boolean {
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

export function wuyouResponse(
  value: unknown,
  page: number,
  pageSize: number,
  city: string,
): ParsedBatch {
  const root = record(value),
    source = record(record(root.resultbody).job)
  if (root.status !== '1') throw new SourceError('parse_error', 'response_contract_changed')
  const acceptsCity = wuyouCityFilter(city)
  const items = rows(source.items),
    total = Number(source.totalCount)
  return batch(
    wuyouIdentity,
    page,
    items,
    (value) => {
      const r = record(value)
      return job(wuyouIdentity, {
        url: text(r.jobHref),
        title: text(r.jobName),
        company: text(r.companyName),
        city: text(r.jobAreaString),
        salary: text(r.provideSalaryString),
        experience: text(r.workYearString),
        education: text(r.degreeString),
        employment: text(r.termStr),
        jd: text(r.jobDescribe),
        detailRead: false,
      })
    },
    Number.isSafeInteger(total) && total >= 0 ? page * pageSize < total : null,
    {
      // The search list mixes isPromotion jobs from other cities into its results.
      // Apply 51job's jobAreaString city[·district] rule here, before storage and caching.
      accept: (item) => acceptsCity(item.city),
    },
  )
}

export class WuyouSearch implements PlatformSearch {
  private pageNumber = 1
  private pending?: SourceBatch
  private ready = false
  constructor(
    private page: SearchTransport,
    private query: NativeQuery,
  ) {}
  private async selectCity(signal: AbortSignal) {
    if (!this.query.city) return
    const city = cities.find(this.query.city)!.platformName
    const selected = await this.page.evaluate<string[]>(
      `[...document.querySelectorAll('.c_area a.ch.on')].map(e=>e.textContent.trim())`,
      signal,
    )
    if (selected.length === 1 && selected[0] === city) return
    // Hot-city links add a city. Use the official dialog for a single-city query.
    await this.page.response(
      {
        parseBody: wuyouBody,
        request: (r) => {
          const u = new URL(r.url)
          if (
            r.method !== 'GET' ||
            u.hostname !== 'we.51job.com' ||
            u.pathname !== '/api/job/search-pc'
          )
            return null
          return (
            u.searchParams.get('jobArea') === cities.code(this.query.city) &&
            u.searchParams.get('pageNum') === '1'
          )
        },
        response: (value) => {
          if (record(value).status !== '1')
            throw new SourceError('parse_error', 'response_contract_changed')
          return true
        },
      },
      async () => {
        await this.page.click('.c_area .allcity', null, signal)
        await this.page.until(
          () =>
            this.page.evaluate<boolean>(
              `[...document.querySelectorAll('.el-dialog .selected_list_wrapper')].some(e=>e.getBoundingClientRect().width>0)`,
              signal,
            ),
          signal,
        )
        while (
          await this.page.evaluate<boolean>(
            `[...document.querySelectorAll('.el-dialog .selected_list_wrapper_tag .el-tag__close')].some(e=>e.getBoundingClientRect().width>0)`,
            signal,
          )
        ) {
          const count = await this.page.evaluate<number>(
            `[...document.querySelectorAll('.el-dialog .selected_list_wrapper_tag .el-tag__close')].filter(e=>e.getBoundingClientRect().width>0).length`,
            signal,
          )
          await this.page.click(
            '.el-dialog .selected_list_wrapper_tag .el-tag__close',
            null,
            signal,
          )
          await this.page.until(
            () =>
              this.page.evaluate<boolean>(
                `document.querySelectorAll('.el-dialog .selected_list_wrapper_tag .el-tag__close').length<${count}`,
                signal,
              ),
            signal,
            'city_selection_not_confirmed',
          )
        }
        await this.page.click(
          '.el-dialog .resumeDialog__top-city, .el-dialog .resumeDialog__right-city',
          city,
          signal,
        )
        await this.page.until(
          () =>
            this.page.evaluate<boolean>(
              `(()=>{const tags=[...document.querySelectorAll('.el-dialog .selected_list_wrapper_tag .el-tag')].filter(e=>e.getBoundingClientRect().width>0).map(e=>e.textContent.trim());return tags.length===1&&tags[0]===${JSON.stringify(city)}})()`,
              signal,
            ),
          signal,
          'city_selection_not_confirmed',
        )
        await this.page.click('.el-dialog .confirm_button', null, signal)
      },
      signal,
    )
  }
  async read(signal: AbortSignal): Promise<SourceBatch> {
    if (this.pending) return this.pending
    if (this.query.city && cities.code(this.query.city) === undefined)
      throw new SourceError('unsupported_city')
    if (!this.ready) {
      await this.page.response(
        {
          parseBody: wuyouBody,
          request: (r) => {
            const u = new URL(r.url)
            return r.method === 'GET' &&
              u.hostname === 'we.51job.com' &&
              u.pathname === '/api/job/search-pc'
              ? true
              : null
          },
          response: (value) => {
            if (record(value).status !== '1')
              throw new SourceError('parse_error', 'response_contract_changed')
            return true
          },
        },
        () => this.page.load('https://we.51job.com/pc/search', signal),
        signal,
      )
      await this.page.until(
        () => this.page.evaluate<boolean>('!!document.querySelector("input.shadedword")', signal),
        signal,
      )
      await this.selectCity(signal)
    }
    let size = 20,
      submittedCity = ''
    const result = await this.page.response(
      {
        parseBody: wuyouBody,
        request: (request) => {
          const matches = wuyouRequest(request, this.query, this.pageNumber)
          if (matches !== true) return matches
          size = Number(new URL(request.url).searchParams.get('pageSize'))
          submittedCity = new URL(request.url).searchParams.get('jobArea') ?? ''
          if (!Number.isInteger(size) || size < 1)
            throw new SourceError('parse_error', 'response_contract_changed')
          return true
        },
        response: (value) => wuyouResponse(value, this.pageNumber, size, this.query.city),
      },
      async () => {
        if (!this.ready) {
          await this.page.fill('input.shadedword', this.query.keyword, signal)
          this.page.enter()
        } else {
          await this.page.click('.el-pagination .btn-next', null, signal)
        }
      },
      signal,
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

const wuyouIdentity: JobIdentityPolicy = {
  id: 'wuyou',
  domains: ['51job.com', '51jobcdn.com', '51job.com.cn'],
  canonicalJob(u) {
    const campusKey = u.searchParams.has('jobId') ? 'jobId' : 'jobid'
    const campusId = u.hostname === 'campus.51job.com' ? u.searchParams.get(campusKey) : null
    const id =
      (campusId && /^\d+$/.test(campusId) ? campusId : null) ||
      u.pathname.match(/\/(\d+)\.html$/)?.[1] ||
      (u.pathname.includes('jobdetail') ? u.searchParams.get('jobId') : null)
    if (!id) return null
    u.hash = ''
    u.search = ''
    if (campusId) u.searchParams.set(campusKey, id)
    else if (u.pathname.includes('jobdetail')) u.searchParams.set('jobId', id)
    return { url: u.href, externalId: id }
  },
}

const passport = 'https://login.51job.com'
const qrResponse = z.object({
  status: z.union([z.string(), z.number()]).optional(),
  result: z.union([z.string(), z.number()]).optional(),
  error_code: z.string().optional(),
})
function qrBody(body: string): unknown {
  // The official endpoint returns JSONP; parse its data without executing scripts.
  const quoted = body.match(/^\s*callback\(\{status:'([01])',result:'([^'\\]*)'\}\)\s*;?\s*$/)
  return quoted
    ? { status: quoted[1], result: quoted[2] }
    : JSON.parse(body.replace(/^\s*callback\s*\(/, '').replace(/\)\s*;?\s*$/, ''))
}
function createQr(transport: QrTransport): QrProtocol {
  let key = ''
  return {
    async initialize() {
      const html = await transport.text(passport + '/')
      const guid = html.match(/\bguid['"]?\s*:\s*['"]([^'"]+)['"]/)?.[1]
      if (!guid || guid.length > 200) throw new LoginError('protocol')
      key = guid
      const r = await transport.json(
        `${passport}/ajax/qrcodelogin.php?${new URLSearchParams({ jsoncallback: 'callback', guid, partner: 'pc_scanner_login', from: 'pc', type: 'refresh' })}`,
        qrResponse.parse,
        undefined,
        qrBody,
      )
      if (Number(r.status) !== 1) throw new LoginError('verification')
      return { image: qrImage(r.result, passport), expiresInMs: 180000 }
    },
    async poll() {
      const r = await transport.json(
        `${passport}/ajax/pcqr_scanlogin_poll.php?_=${Date.now()}`,
        qrResponse.parse,
        { data: { guid: key }, jsonBody: true },
        qrBody,
      )
      if (String(r.result) === '1') return 'authenticated'
      if (r.error_code === 'scanned') return 'scanned'
      if (['system', 'inhibited'].includes(r.error_code ?? '')) return 'expired'
      if (String(r.result) !== '0') throw new LoginError('protocol')
      return 'waiting'
    },
  }
}
export const wuyouAdapter: PlatformAdapter = {
  cities,
  ...wuyouIdentity,
  // The marketing homepage can show a login form while the search session is authenticated.
  accountCheckUrl: 'https://we.51job.com/pc/search',
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
  createSearch: (page, query) => new WuyouSearch(page, query),
  qr: {
    scanHint: {
      'zh-CN': '使用前程无忧 App 或微信扫一扫并确认。',
      'en-US': 'Scan and confirm using the 51job app or WeChat.',
    },
    create: createQr,
    headers: () => ({ 'X-Requested-With': 'XMLHttpRequest' }),
  },
}
const pageRules: PageRules = {
  loginUrlNeedsText: false,
  loginSelector:
    'input[type="password"],input[autocomplete="current-password"],.login-dialog,.login-layer,.login-card .phone-login-form',
  loginUrl: '://login\\.51job\\.com/',
  authenticatedSelector: '.user-info .name-span:not(:empty),a[href*="logout"],a[href*="signout"]',
  descriptionSelector: '.bmsg.job_msg,.job-detail .job-intro,.job-description',
  statusSelector: '.job-status,.cn .status,.job-expired',
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
