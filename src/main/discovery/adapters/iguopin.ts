import { z } from 'zod'
import QRCode from 'qrcode'
import type { QrLoginMethod } from '../../../shared/job-discovery'
import { createCityLookup } from '../../../shared/discovery-city-catalog'
import cityCatalog from '../../../shared/discovery-cities/iguopin.json'
import {
  SourceError,
  type AccountTransport,
  type PlatformAdapter,
  type JobIdentityPolicy,
  type NativeQuery,
  type PlatformSearch,
  type SearchTransport,
  type SearchRequest,
  type SourceBatch,
  type ParsedBatch,
} from '../adapter'
import { pageScript, type PageRules } from '../extraction'
import { LoginError, type QrProtocol, type QrTransport } from '../qr-protocol'
import { batch, job, record, rows, text } from '../parsing'

const cities = createCityLookup(cityCatalog)

const origin = 'https://www.iguopin.com'
const api = 'https://gp-api.iguopin.com'
const headers = { Device: 'pc', Version: '5.2.300', Subsite: 'iguopin' }
const identity: JobIdentityPolicy = {
  id: 'iguopin',
  domains: ['iguopin.com'],
  canonicalJob(url) {
    if (url.hostname !== 'www.iguopin.com' || url.pathname !== '/job/detail') return null
    const id = url.searchParams.get('id')
    if (!id || !/^\d{1,30}$/.test(id)) return null
    return { url: `${origin}/job/detail?id=${id}`, externalId: id }
  },
}

const envelope = z.object({ code: z.number(), data: z.unknown().optional() })
function responseData(value: unknown): Record<string, unknown> {
  const result = envelope.safeParse(value)
  if (!result.success) throw new SourceError('parse_error', 'response_contract_changed')
  if ([401, 10001].includes(result.data.code)) throw new SourceError('login_required')
  if ([403, 429, 620101].includes(result.data.code)) throw new SourceError('challenge')
  if (result.data.code !== 200) throw new SourceError('parse_error', 'response_contract_changed')
  return record(result.data.data)
}

export function iguopinRequest(
  request: SearchRequest,
  query: NativeQuery,
  page: number,
): boolean | null {
  const url = new URL(request.url)
  if (url.origin !== api || url.pathname !== '/api/jobs/v1/recom-job' || request.method !== 'POST')
    return null
  let data: Record<string, unknown>
  try {
    data = record(record(JSON.parse(request.body)).search)
  } catch {
    return false
  }
  const empty = (value: unknown) =>
    value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length)
  const district =
    Array.isArray(data.district) && data.district.length === 1
      ? text(data.district[0])
      : text(data.district)
  return (
    text(data.keyword) === query.keyword &&
    Number(data.page) === page &&
    (!query.city ? empty(data.district) : district === cities.code(query.city)) &&
    [
      'wage',
      'min_wage',
      'max_wage',
      'experience',
      'nature',
      'education',
      'major',
      'company_nature',
      'company_scale',
      'company_financing_stage',
      'industry',
      'category',
      'update_time_range',
      'om',
      'company_id',
      'project_id',
    ].every((key) => empty(data[key]))
  )
}

function salary(row: Record<string, unknown>): string {
  if (row.is_negotiable === true) return '面议'
  const low = row.min_wage,
    high = row.max_wage
  if (
    typeof low !== 'number' ||
    !Number.isFinite(low) ||
    low < 0 ||
    typeof high !== 'number' ||
    !Number.isFinite(high) ||
    high < low ||
    !text(row.wage_unit_cn)
  )
    return ''
  if (!low && !high) return ''
  const range = low === high ? String(low) : `${low}-${high}`
  const months = typeof row.months === 'number' && row.months > 12 ? `·${row.months}薪` : ''
  return `${range}${text(row.wage_unit_cn)}${months}`
}
export function iguopinResponse(value: unknown, page: number): ParsedBatch {
  const data = responseData(value)
  if (
    data.page !== page ||
    !Number.isSafeInteger(data.total) ||
    Number(data.total) < 0 ||
    !Number.isSafeInteger(data.page_size) ||
    Number(data.page_size) <= 0
  )
    throw new SourceError('parse_error', 'response_contract_changed')
  // The official API returns null, rather than an array, for a confirmed empty result.
  const source = data.total === 0 && data.list === null ? [] : rows(data.list)
  if (source.length > Number(data.page_size))
    throw new SourceError('parse_error', 'response_contract_changed')
  return batch(
    identity,
    page,
    source,
    (value) => {
      const r = record(value),
        id = text(r.job_id)
      // IDs are supplied as decimal strings. Never round a JSON number into an identity.
      if (!/^\d{1,30}$/.test(id) || r.index !== 'iguopin') return null
      const locations = Array.isArray(r.district_list)
        ? r.district_list.map((v) => text(record(v).area_cn)).filter(Boolean)
        : []
      return job(identity, {
        url: `${origin}/job/detail?id=${id}`,
        title: text(r.job_name),
        company: text(r.company_name),
        city: [...new Set(locations)].join('、'),
        salary: salary(r),
        experience: text(r.experience_cn),
        education: text(r.education_cn),
        recruitment: text(r.recruitment_type_cn),
        employment: /^(全职|兼职|实习|见习)$/.test(text(r.nature_cn)) ? text(r.nature_cn) : '',
        jd: text(r.contents),
        detailRead: false,
      })
    },
    page * Number(data.page_size) < Number(data.total),
  )
}

export class IguopinSearch implements PlatformSearch {
  private pageNumber = 1
  private ready = false
  private pending?: SourceBatch
  constructor(
    private page: SearchTransport,
    private query: NativeQuery,
  ) {}
  async read(signal: AbortSignal): Promise<SourceBatch> {
    if (this.pending) return this.pending
    const city = this.query.city ? cities.find(this.query.city) : undefined
    if (this.query.city && !city) throw new SourceError('unsupported_city')
    if (!this.ready) await this.page.load(`${origin}/job/list`, signal)
    const fetch = async (query: NativeQuery, action: () => Promise<void>): Promise<SourceBatch> => {
      let submittedCity = ''
      const result = await this.page.response(
        {
          request: (request) => {
            const matches = iguopinRequest(request, query, this.pageNumber)
            if (matches === true) {
              const district = record(record(JSON.parse(request.body)).search).district
              submittedCity = Array.isArray(district) ? text(district[0]) : text(district)
            }
            return matches
          },
          response: (value) => iguopinResponse(value, this.pageNumber),
        },
        action,
        signal,
      )
      return { ...result, submitted: { keyword: query.keyword, cityCode: submittedCity } }
    }
    let result: SourceBatch
    if (this.ready) {
      result = await fetch(this.query, () =>
        this.page.click('.ant-pagination-next:not(.ant-pagination-disabled) button', null, signal),
      )
    } else {
      result = await fetch({ ...this.query, city: '' }, async () => {
        await this.page.fill('input[placeholder="请输入关键词搜索"]', this.query.keyword, signal)
        await this.page.click('button.ant-input-search-button', null, signal)
      })
      if (city) {
        result = await fetch(this.query, async () => {
          await this.page.click('#district .filter-option', '全部地区 >', signal)
          await this.page.click(
            '.ant-modal .flat-left .item-txt',
            city.province === '台湾' ? '中国台湾' : city.province,
            signal,
          )
          await this.page.click(
            '.ant-modal .flat-right .leaf-item',
            city.code.split('.').length === 2 ? '全' + city.platformName : city.platformName,
            signal,
          )
          if (city.code.split('.').length > 2) {
            const selection = await this.page.until(
              () =>
                this.page.evaluate<'selected' | 'all' | null>(
                  `(() => {
            const modal = [...document.querySelectorAll('.ant-modal')].find(e => e.getBoundingClientRect().height > 0);
            if (!modal) return 'selected';
            return [...modal.querySelectorAll('.flat-right .leaf-item')].some(e => e.textContent.trim() === ${JSON.stringify('全' + city.platformName)}) ? 'all' : null;
          })()`,
                  signal,
                ),
              signal,
            )
            if (selection === 'all')
              await this.page.click(
                '.ant-modal .flat-right .leaf-item',
                '全' + city.platformName,
                signal,
              )
          }
        })
      }
    }
    this.ready = true
    this.pending = result
    return this.pending
  }
  commit(value: SourceBatch) {
    if (value !== this.pending) throw new Error('Uncommitted source batch')
    this.pending = undefined
    this.pageNumber++
  }
}

async function account(transport: Pick<QrTransport, 'json'>, token: string): Promise<boolean> {
  const value = await transport.json(`${api}/personal/user/account/v1/userinfo`, envelope.parse, {
    data: {},
    jsonBody: true,
    headers: { ...headers, ApiAuth: token },
  })
  if ([401, 10001].includes(value.code)) return false
  const user = responseData(value)
  if (!text(user.id) || user.user_type !== 'personal')
    throw new SourceError('parse_error', 'account_contract_changed')
  return true
}
async function checkSession(transport: AccountTransport): Promise<boolean> {
  const token = await transport.cookie(origin, '__token__')
  return !!token && account(transport, token)
}
function createQr(transport: QrTransport, method: QrLoginMethod = 'app'): QrProtocol {
  let key = ''
  return {
    async initialize() {
      const value = await transport.json(`${api}/personal/user/passport/v1/randKey`, envelope.parse)
      if (value.code !== 200 || !text(record(value.data).qcode)) throw new LoginError('protocol')
      key = text(record(value.data).qcode)
      let image: string
      if (method === 'wechat') {
        const value = await transport.json(
          `${api}/personal/user/wechat/v1/login-mini-qcode`,
          envelope.parse,
          { data: { qcode: key }, jsonBody: true },
        )
        const pixels = text(record(value.data).url)
        if (value.code !== 200 || !/^[a-z\d+/=]+$/i.test(pixels)) throw new LoginError('protocol')
        image = `data:image/jpeg;base64,${pixels}`
      } else {
        image = await QRCode.toDataURL(
          Buffer.from(JSON.stringify({ t: 'login', c: key })).toString('base64'),
          { width: 300, margin: 1 },
        )
      }
      return { image, expiresInMs: 180000 }
    },
    async poll() {
      const value = await transport.json(
        `${api}/personal/user/passport/v1/scan?_=${Date.now()}`,
        envelope.parse,
        { data: { qcode: key }, jsonBody: true },
      )
      if ([403, 429, 620101].includes(value.code)) throw new LoginError('verification')
      if (value.code !== 200) throw new LoginError('protocol')
      const state = record(value.data)
      if (state.is_timeOut === true) return 'expired'
      if (text(state.token) && state.user_type === 'personal') {
        try {
          if (!(await account(transport, text(state.token)))) throw new LoginError('protocol')
        } catch (error) {
          if (error instanceof SourceError)
            throw new LoginError(error.state === 'challenge' ? 'verification' : 'protocol')
          throw error
        }
        await transport.setCookie({
          url: origin,
          domain: '.iguopin.com',
          path: '/',
          name: '__token__',
          value: text(state.token),
          secure: true,
          expirationDate: Date.now() / 1000 + 8 * 60 * 60,
        })
        return 'authenticated'
      }
      if (state.user_type && state.user_type !== 'personal') throw new LoginError('verification')
      return state.is_scan || state.is_login ? 'scanned' : 'waiting'
    },
  }
}
const appHint = {
  'zh-CN': '使用国聘 APP 扫码并确认登录。',
  'en-US': 'Scan and confirm using the Guopin app.',
}
const wechatHint = {
  'zh-CN': '使用微信扫描国聘小程序码并确认登录；如需绑定账号，请在官方小程序内完成。',
  'en-US':
    'Scan with WeChat and confirm in the Guopin mini program. Complete account linking there if requested.',
}
export const iguopinAdapter: PlatformAdapter = {
  cities,
  ...identity,
  accountCheckUrl: `${origin}/login`,
  contractVersion: 1,
  sessionCheck: 'batch',
  remoteFilters: ['keyword', 'city'],
  checkSession: async (transport) =>
    (await checkSession(transport)) ? 'authenticated' : 'login_required',
  createSearch: (page, query) => new IguopinSearch(page, query),
  pageScript: (detail) => pageScript(rules, detail),
  qr: {
    scanHint: appHint,
    methods: [
      { id: 'app', label: { 'zh-CN': '国聘 APP', 'en-US': 'Guopin app' }, scanHint: appHint },
      { id: 'wechat', label: { 'zh-CN': '微信', 'en-US': 'WeChat' }, scanHint: wechatHint },
    ],
    create: createQr,
    headers: () => ({ ...headers, 'X-Requested-With': 'XMLHttpRequest' }),
  },
}
const rules: PageRules = {
  loginSelector: 'input[type="password"],.app-code-content',
  loginUrl: '://www\\.iguopin\\.com/login(?:/|\\?|$)',
  loginUrlNeedsText: false,
  authenticatedSelector: 'a[href="/personal"]',
  descriptionSelector: '.job-intro-section .job-duty',
  statusSelector: '.job-detail .job-status,.job-detail .apply-btn',
  tagsSelector: '.job-overview-section .overview-desc',
  fields: {
    title: '.job-banner .title-section .title',
    company: '.job-detail-wrap .address-section .address:last-child',
    city: '.job-detail-wrap .address-section .address:first-of-type',
    salary: '.job-detail-wrap .salary-section',
    experience: '.job-overview-section [data-unused-experience]',
    education: '.job-overview-section [data-unused-education]',
  },
  foldedSelector: '.job-intro-section button',
  excludedSelector: '.job-content .right,.job-search-wrap,.job-competition-analysis-wrap,footer',
}
