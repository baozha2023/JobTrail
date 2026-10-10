import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { createCityLookup } from '../../../shared/discovery-city-catalog'
import cityCatalog from '../../../shared/discovery-cities/shixiseng.json'
import type { QrLoginMethod } from '../../../shared/job-discovery'
import {
  SourceError,
  type AccountTransport,
  type JobIdentityPolicy,
  type NativeQuery,
  type ParsedBatch,
  type PlatformAdapter,
  type PlatformSearch,
  type SearchRequest,
  type SearchTransport,
  type SourceBatch,
} from '../adapter'
import { pageScript, type PageRules } from '../extraction'
import { batch, job, record, rows, text } from '../parsing'
import { LoginError, type QrProtocol, type QrTransport } from '../qr-protocol'
import { shixisengFont } from './shixiseng/font'

const cities = createCityLookup(cityCatalog)
const origin = 'https://www.shixiseng.com'
const accountOrigin = 'https://apigateway.shixiseng.com'
const envelope = z.object({ code: z.number(), msg: z.unknown().optional() })
const identity: JobIdentityPolicy = {
  id: 'shixiseng',
  domains: ['shixiseng.com'],
  canonicalJob(url) {
    const id = /^\/intern\/(inn_[a-z0-9]{1,64})\/?$/.exec(url.pathname)?.[1]
    return url.hostname === 'www.shixiseng.com' && id
      ? { url: `${origin}/intern/${id}`, externalId: id }
      : null
  },
}
function response(value: unknown): Record<string, unknown> {
  const parsed = envelope.safeParse(value)
  if (!parsed.success) throw new SourceError('parse_error', 'response_contract_changed')
  if ([101, 401].includes(parsed.data.code)) throw new SourceError('login_required')
  if ([403, 429].includes(parsed.data.code)) throw new SourceError('challenge')
  if (parsed.data.code !== 100) throw new SourceError('parse_error', 'response_contract_changed')
  return record(parsed.data.msg)
}
export function shixisengRequest(
  request: SearchRequest,
  query: NativeQuery,
  page: number,
): boolean | null {
  const url = new URL(request.url)
  if (
    url.origin !== origin ||
    url.pathname !== '/app/interns/search/v2' ||
    request.method !== 'GET'
  )
    return null
  const p = url.searchParams
  // The company's recommendations and campus search use other contracts.
  return (
    p.get('keyword') === query.keyword &&
    p.get('type') === 'intern' &&
    p.get('page') === String(page) &&
    p.get('city') === (query.city ? cities.find(query.city)?.code : '全国') &&
    [
      'area',
      'months',
      'days',
      'degree',
      'official',
      'enterprise',
      'publishTime',
      'sortType',
      'intern_type',
      'internExtend',
    ].every((k) => !p.get(k)) &&
    (!p.get('salary') || p.get('salary') === '-0')
  )
}
export function shixisengText(value: unknown, font: Record<string, string> = {}): string {
  const input = typeof value === 'number' && Number.isFinite(value) ? String(value) : text(value)
  const decoded = input
    .replace(/&#(x[\da-f]+|\d+);?/gi, (_match, code: string) => {
      const n = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code)
      return n <= 0x10ffff ? String.fromCodePoint(n) : ''
    })
    .replace(/[\ue000-\uf8ff]/g, (c) => font[c] ?? c)
  if (/[\ue000-\uf8ff]/.test(decoded)) throw new SourceError('parse_error', 'font_contract_changed')
  return decoded
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .trim()
}
function shixisengCityFilter(city: string): (location: string) => boolean {
  const target = city ? cities.find(city) : undefined
  if (city && !target) throw new SourceError('unsupported_city')
  const names = new Set(
    [target?.name, target?.platformName, ...(target?.aliases ?? [])].map((name) =>
      name?.replace(/市$/, ''),
    ),
  )
  return (location) =>
    !target ||
    location
      .split(/[、,，;；/／|｜\n]+/)
      .some((part) => names.has(part.split(/[-·]/, 1)[0].trim().replace(/市$/, '')))
}
export function shixisengResponse(
  value: unknown,
  page: number,
  city: string,
  font: Record<string, string> = {},
): ParsedBatch {
  const data = response(value),
    source = rows(data.data),
    acceptsCity = shixisengCityFilter(city)
  if (
    !Number.isSafeInteger(data.total) ||
    Number(data.total) < 0 ||
    !Number.isSafeInteger(data.pageNumber) ||
    Number(data.pageNumber) <= 0 ||
    source.length > Number(data.pageNumber)
  )
    throw new SourceError('parse_error', 'response_contract_changed')
  return batch(
    identity,
    page,
    source,
    (value) => {
      const r = record(value),
        id = text(r.uuid)
      if (!/^inn_[a-z0-9]{1,64}$/.test(id)) return null
      const decode = (v: unknown) => shixisengText(v, font)
      const low = decode(r.minsal),
        high = decode(r.maxsal)
      const salary =
        r.talkFace === '0' || r.talkFace === 0
          ? '薪资面议'
          : low && high
            ? `${low === high ? low : low + '-' + high}/天`
            : ''
      const tags = Array.isArray(r.i_tags) ? r.i_tags.map(decode).filter(Boolean) : []
      const day = decode(r.day),
        months = decode(r.month_num)
      return job(identity, {
        url: `${origin}/intern/${id}`,
        title: decode(r.name),
        company: decode(r.cname),
        city: decode(r.city),
        salary,
        education: decode(r.degree),
        employment: '实习',
        jd: [
          ...(day ? [`每周到岗：${day}天`] : []),
          ...(months ? [`实习时长：${months}个月`] : []),
          ...tags,
        ].join('\n'),
        detailRead: false,
      })
    },
    page * Number(data.pageNumber) < Number(data.total),
    {
      // The official search can return other cities even when the submitted city is correct.
      // Match the decoded location before storage; retain source identities for pagination.
      accept: (item) => acceptsCity(item.city),
    },
  )
}

// Fetch only the font referenced by the current page, in that page's Session.
// Its post table names supply the original characters; no guessed glyph mapping.
function fontScript(): string {
  return `(async()=>{
    let source='';
    for(const sheet of document.styleSheets){try{for(const rule of sheet.cssRules){if(rule instanceof CSSFontFaceRule && /myFont/.test(rule.style.fontFamily)){source=rule.style.src.match(/url\\(["']?([^"')]+)/)?.[1]||''}}}catch{}}
    if(!source)return {};
    const url=new URL(source,location.href);
    if(url.origin!=='https://www.shixiseng.com'||url.pathname!=='/interns/iconfonts/file')throw new Error('font_contract_changed');
    const response=await fetch(url.href,{credentials:'include',cache:'force-cache',signal:AbortSignal.timeout(10000)});
    if(!response.ok||Number(response.headers.get('content-length'))>262144)throw new Error('font_request_failed');
    const reader=response.body.getReader(),chunks=[];let size=0;
    try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>262144)throw new Error('font_response_too_large');chunks.push(next.value)}}finally{await reader.cancel()}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}
    return (${shixisengFont.toString()})(bytes.buffer);
  })()`
}
export class ShixisengSearch implements PlatformSearch {
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
    const fetch = (query: NativeQuery, action: () => Promise<void>) =>
      this.page.response(
        {
          request: (r: SearchRequest) => shixisengRequest(r, query, this.pageNumber),
          response: (value: unknown) => {
            response(value)
            return value
          },
        },
        action,
        signal,
      )
    let value: unknown
    if (!this.ready) {
      await this.page.load(`${origin}/interns?type=intern`, signal)
      value = await fetch({ ...this.query, city: '' }, async () => {
        await this.page.fill('.input-group input[type="text"]', this.query.keyword, signal)
        await this.page.click('.input-group .search-btn', null, signal)
      })
      if (city)
        value = await fetch(this.query, async () => {
          await this.page.click('.input-group .city', null, signal)
          const hot = await this.page.evaluate<boolean>(
            `Array.from(document.querySelectorAll('.sxs_city .hot_city .city-item')).some(e=>e.textContent.trim()===${JSON.stringify(city.platformName)})`,
            signal,
          )
          if (hot)
            await this.page.click('.sxs_city .hot_city .city-item', city.platformName, signal)
          else {
            await this.page.click(
              '.sxs_city .sxs_hovers>p',
              ['北京', '上海', '天津', '重庆'].includes(city.province)
                ? city.province + '市'
                : city.province,
              signal,
            )
            if (!['北京', '上海', '天津', '重庆'].includes(city.province))
              await this.page.click('.sxs_city .sxs_hoverss .city-item', city.platformName, signal)
          }
        })
    } else
      value = await fetch(this.query, () =>
        this.page.click('.el-pagination .btn-next:not([disabled])', null, signal),
      )
    await this.page.guard(signal)
    let font: Record<string, string> = {}
    if (/[\ue000-\uf8ff]|&#(?:x[\da-f]+|\d+)/i.test(JSON.stringify(value))) {
      try {
        font = await this.page.evaluate<Record<string, string>>(fontScript(), signal)
      } catch (error) {
        signal.throwIfAborted()
        throw new SourceError('parse_error', 'font_contract_changed', { cause: error })
      }
    }
    const result = shixisengResponse(value, this.pageNumber, this.query.city, font)
    this.ready = true
    this.pending = {
      ...result,
      submitted: { keyword: this.query.keyword, cityCode: city?.code ?? '' },
    }
    return this.pending
  }
  commit(value: SourceBatch) {
    if (value !== this.pending) throw new Error('Uncommitted source batch')
    this.pending = undefined
    this.pageNumber++
  }
}

export async function shixisengAccount(
  transport: Pick<AccountTransport, 'json'>,
): Promise<boolean> {
  const result = await transport.json(
    `${accountOrigin}/api/account/v3.0/baseinfo`,
    envelope.parse,
    { headers: { Origin: origin, Referer: origin + '/' } },
  )
  if ([101, 401].includes(result.code)) return false
  const account = response(result)
  if (!Object.keys(account).length) return false
  if (!text(account.uuid)) throw new SourceError('parse_error', 'account_contract_changed')
  return account.flag !== 'company'
}
function createQr(transport: QrTransport, method: QrLoginMethod = 'wechat'): QrProtocol {
  if (method !== 'wechat') throw new LoginError('protocol')
  let scene = '',
    polls = 0,
    confirmed = false
  return {
    async initialize() {
      const bytes = randomBytes(16)
      scene = 'xxxxxxx4xxyxxxxx'.replace(/[xy]/g, (c, i: number) =>
        (c === 'x' ? bytes[i] & 15 : (bytes[i] & 3) | 8).toString(16),
      )
      const query = new URLSearchParams({
        scene,
        pages: 'pages/login/pcloginpage/pcloginpage',
        stype: 'common',
      })
      const result = await transport.json(
        `${accountOrigin}/api/account/v3.0/mina/create/minacode/v2?${query}`,
        envelope.parse,
      )
      const pixels = text(result.msg)
      if (result.code !== 100 || !/^[a-z\d+/=]+$/i.test(pixels)) throw new LoginError('protocol')
      const mime = pixels.startsWith('/9j/') ? 'jpeg' : pixels.startsWith('iVBOR') ? 'png' : null
      if (!mime) throw new LoginError('protocol')
      return { image: `data:image/${mime};base64,${pixels}`, expiresInMs: 180000 }
    },
    async poll() {
      if (!scene) throw new LoginError('protocol')
      if (!confirmed) {
        if (polls >= 6) return 'expired'
        const result = await transport.json(
          `${accountOrigin}/api/account/v2.0/mina/polling?scene=${scene}`,
          envelope.parse,
          { data: {}, timeoutMs: 65000 },
        )
        polls++
        const state = record(result.msg)
        if (result.code === 100 && state.isLogin === true) confirmed = true
        else if (result.code === 500)
          return state.isScan === true ? 'scanned' : polls >= 6 ? 'expired' : 'waiting'
        else throw new LoginError([403, 429].includes(result.code) ? 'verification' : 'protocol')
      }
      try {
        if (!(await shixisengAccount(transport))) return 'scanned'
        const guide = await transport.json(
          `${accountOrigin}/api/account/v3.0/pc/user/guide`,
          envelope.parse,
        )
        const state = response(guide)
        if (state.is_complete !== true) return 'scanned'
        return 'authenticated'
      } catch (error) {
        if (error instanceof SourceError)
          throw new LoginError(error.state === 'challenge' ? 'verification' : 'protocol')
        throw error
      }
    },
  }
}
const hint = {
  'zh-CN': '使用微信扫码并确认登录；如需绑定或验证，请在官方流程中完成。',
  'en-US':
    'Scan and confirm using WeChat. Complete any account linking or verification in the official flow.',
}
const rules: PageRules = {
  loginSelector: '.login-dialog-wrap--is-show',
  loginUrl: '://www\\.shixiseng\\.com/user/login',
  loginUrlNeedsText: false,
  authenticatedSelector: '.logined',
  descriptionSelector: '.job_part',
  statusSelector: '.resume_apply',
  tagsSelector: '.job_msg>span,.job_good_list>span',
  fields: {
    title: '.new_job_name>span',
    company: '.job_com_name a,.com-name',
    city: '.job_position',
    salary: '.job_money',
    experience: '.job-experience',
    education: '.job_academic',
  },
  foldedSelector: '.job_detail .show-more',
  excludedSelector: '.content_right,.recommend,.footer-login,footer',
}
export const shixisengAdapter: PlatformAdapter = {
  cities,
  ...identity,
  accountCheckUrl: `${origin}/personal-center`,
  contractVersion: 2,
  sessionCheck: 'batch',
  remoteFilters: ['keyword', 'city'],
  checkSession: async (transport) =>
    (await shixisengAccount(transport)) ? 'authenticated' : 'login_required',
  createSearch: (page, query) => new ShixisengSearch(page, query),
  pageScript: (detail) =>
    !detail
      ? pageScript(rules, false)
      : `(()=>{
    const state=${pageScript(rules, true)};
    if(state.login||state.challenge)return state;
    const offline=Array.from(document.querySelectorAll('.resume_apply')).some(status=>{
      const rect=status.getBoundingClientRect(),style=getComputedStyle(status);
      return !status.closest('.job_part,.content_right,.recommend,footer')&&rect.width>0&&rect.height>0&&style.visibility!=='hidden'&&style.display!=='none'&&/^当前职位已下线$/.test(status.textContent.trim());
    });
    if(offline){state.offline=true;state.detail={};return state}
    for(const [key,value] of Object.entries(state.detail))if(typeof value==='string'&&/[\\ue000-\\uf8ff]/.test(value)){state.detail[key]='';state.detail.missing={...state.detail.missing,[key]:'parse_error'};if(key==='jd')state.detail.detailRead=false}
    if(state.detail.jd){const terms=Array.from(document.querySelectorAll('.job_msg .job_week,.job_msg .job_time')).map(e=>e.textContent.trim()).filter(v=>v&&!/[\\ue000-\\uf8ff]/.test(v));state.detail.jd=[...terms,state.detail.jd].join('\\n')}
    return state;
  })()`,
  qr: {
    scanHint: hint,
    methods: [{ id: 'wechat', label: { 'zh-CN': '微信', 'en-US': 'WeChat' }, scanHint: hint }],
    create: createQr,
    headers: () => ({ Origin: origin, Referer: origin + '/' }),
  },
}
