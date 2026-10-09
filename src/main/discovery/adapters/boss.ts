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
import { cityCode, discoveryCity, platformCity } from '../../../shared/discovery-cities'
import { batch, job, record, rows, text } from '../parsing'

export function bossRequest(
  request: SearchRequest,
  query: NativeQuery,
  page: number,
): boolean | null {
  const url = new URL(request.url)
  const parameters = new URLSearchParams(request.body)
  if (
    request.method !== 'POST' ||
    url.hostname !== 'www.zhipin.com' ||
    url.pathname !== '/wapi/zpgeek/search/joblist.json'
  )
    return null
  return (
    ['salary', 'experience', 'degree', 'industry', 'scale', 'stage', 'jobType'].every(
      (key) => !parameters.get(key) || parameters.get(key) === '0',
    ) &&
    parameters.get('query') === query.keyword &&
    (!query.city || parameters.get('city') === cityCode('boss', query.city)) &&
    Number(parameters.get('page')) === page
  )
}
export function bossResponse(value: unknown, page: number): ParsedBatch {
  const root = record(value),
    data = record(root.zpData)
  if (root.code !== 0) {
    if (root.code === 35) throw new SourceError('login_required')
    if (root.code === 37) throw new SourceError('challenge')
    throw new SourceError('parse_error', 'response_contract_changed')
  }
  const result = batch(
    bossIdentity,
    page,
    rows(data.jobList),
    (v) => {
      const r = record(v)
      return job(bossIdentity, {
        url: `https://www.zhipin.com/job_detail/${text(r.encryptJobId)}.html`,
        title: text(r.jobName),
        company: text(r.brandName),
        city: [r.cityName, r.areaDistrict, r.businessDistrict].map(text).filter(Boolean).join('·'),
        salary: text(r.salaryDesc),
        experience: text(r.jobExperience),
        education: text(r.jobDegree),
      })
    },
    typeof data.hasMore === 'boolean' ? data.hasMore : null,
  )
  if (result.jobs.some((item) => !item.salary)) throw new SourceError('session_expired')
  return result
}

export class BossSearch implements PlatformSearch {
  private pageNumber = 1
  private pending?: SourceBatch
  private ready = false
  constructor(
    private page: SearchTransport,
    private query: NativeQuery,
  ) {}
  async read(signal: AbortSignal): Promise<SourceBatch> {
    if (this.pending) return this.pending
    if (this.query.city && cityCode('boss', this.query.city) === undefined)
      throw new SourceError('unsupported_city')
    if (!this.ready) await this.page.load('https://www.zhipin.com/', signal)
    let submittedCity = ''
    const result = await this.page.response(
      {
        request: (r) => {
          const matches = bossRequest(r, this.query, this.pageNumber)
          if (matches !== true) return matches
          submittedCity = new URLSearchParams(r.body).get('city') ?? ''
          return true
        },
        response: (v) => bossResponse(v, this.pageNumber),
      },
      async () => {
        if (!this.ready) {
          await this.page.fill('input.ipt-search', this.query.keyword, signal)
          await this.page.click('button.btn-search', null, signal)
          await this.page.until(
            () =>
              this.page.evaluate<boolean>(
                '!!document.querySelector(".job-search-form input")',
                signal,
              ),
            signal,
          )
          const current = await this.page.evaluate<string>(
            'document.querySelector(".cur-city-label")?.textContent.trim()||""',
            signal,
          )
          const target = platformCity('boss', this.query.city)
          if (target && current !== target.name) {
            await this.page.click('.city-label', null, signal)
            await this.page.until(
              () =>
                this.page.evaluate<boolean>(
                  `!!document.querySelector('.city-select-dialog .city-list-hot li')`,
                  signal,
                ),
              signal,
            )
            const hot = await this.page.evaluate<boolean>(
              `[...document.querySelectorAll('.city-select-dialog .city-list-hot li')].some(e=>e.textContent.trim()===${JSON.stringify(target.name)})`,
              signal,
            )
            if (hot)
              await this.page.click('.city-select-dialog .city-list-hot li', target.name, signal)
            else {
              const initial = discoveryCity(this.query.city)!.initial
              const group = await this.page.evaluate<string | null>(
                `[...document.querySelectorAll('.city-select-dialog .city-char-list li')].map(e=>e.textContent.trim()).find(t=>t.includes(${JSON.stringify(initial)}))??null`,
                signal,
              )
              if (!group) throw new SourceError('scope_unverified', 'control_not_found')
              await this.page.click('.city-select-dialog .city-char-list li', group, signal)
              await this.page.click('.city-select-dialog .list-select-list a', target.name, signal)
            }
          }
        } else {
          await this.page.evaluate(
            `(()=>{let e=document.querySelector('.job-list-box,.job-list-container');while(e){if(/auto|scroll/.test(getComputedStyle(e).overflowY)&&e.scrollHeight>e.clientHeight){e.scrollTo(0,e.scrollHeight);return}e=e.parentElement}window.scrollTo(0,document.documentElement.scrollHeight)})()`,
            signal,
          )
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

const bossIdentity: JobIdentityPolicy = {
  id: 'boss',
  domains: ['zhipin.com', 'zboss.com', 'bosszhipin.com'],
  canonicalJob(u) {
    const id = u.pathname.match(/^\/job_detail\/([\w~-]+)\.html$/)?.[1]
    if (!id) return null
    u.hash = ''
    u.search = ''
    return { url: u.href, externalId: id }
  },
}

const passport = 'https://www.zhipin.com/wapi/zppassport'
const qrResponse = z.object({
  code: z.number().optional(),
  scaned: z.boolean().optional(),
  zpData: z
    .object({ shortRandKey: z.string().optional(), mpCodeUrl: z.string().optional() })
    .optional(),
})
function createQr(transport: QrTransport): QrProtocol {
  let key = ''
  return {
    async initialize() {
      const value = await transport.json(`${passport}/captcha/randkey`, qrResponse.parse, {
        data: {},
      })
      if (value.code !== 0 || !value.zpData?.shortRandKey) throw new LoginError('verification')
      key = value.zpData.shortRandKey
      const qr = await transport.json(
        `${passport}/qrcode/getMpCode?${new URLSearchParams({ uuid: key, width: '240' })}`,
        qrResponse.parse,
      )
      if (qr.code !== 0) throw new LoginError('verification')
      return { image: qrImage(qr.zpData?.mpCodeUrl, 'https://www.zhipin.com'), expiresInMs: 180000 }
    },
    async poll() {
      const value = await transport.json(
        `${passport}/qrcode/scanByMp?${new URLSearchParams({ uuid: key })}`,
        qrResponse.parse,
        { timeoutMs: 95000 },
      )
      if (value.scaned) {
        transport.scanned()
        const result = await transport.json(
          `${passport}/qrcode/loginConfirm?${new URLSearchParams({ uuid: key, pk: 'cpc_user_sign_up' })}`,
          qrResponse.parse,
        )
        if (result.code !== 0) throw new LoginError('verification')
        return 'authenticated'
      }
      if (value.code != null && value.code !== 0) throw new LoginError('verification')
      return 'waiting'
    },
  }
}
export const bossAdapter: PlatformAdapter = {
  ...bossIdentity,
  accountCheckUrl: 'https://www.zhipin.com/',
  contractVersion: 2,
  remoteFilters: ['keyword', 'city'],
  pageScript: (detail) => pageScript(pageRules, detail),
  createSearch: (page, query) => new BossSearch(page, query),
  qr: {
    scanHint: {
      'zh-CN': '使用微信扫一扫，在 BOSS 直聘小程序中确认。',
      'en-US': 'Scan with WeChat and confirm in the BOSS mini program.',
    },
    create: createQr,
  },
}
const pageRules: PageRules = {
  loginUrlNeedsText: true,
  loginSelector:
    'input[type="password"],input[autocomplete="current-password"],.login-dialog,.login-layer,.job-list-login-gate,.job-detail-login-gate__panel',
  loginUrl: '/web/user',
  authenticatedSelector:
    'a[href*="logout"],a[href*="signout"],a[href*="/web/geek/chat"],a[href*="/web/geek/resume"],.geek-avatar',
  descriptionSelector: '.job-sec-text,.job-detail .text,.job-description',
  statusSelector: '.job-status,.job-banner .status,.job-banner .op-btn',
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
