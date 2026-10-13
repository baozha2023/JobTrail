import { createHash, randomInt } from 'node:crypto'
import { z } from 'zod'
import type { QrLoginMethod } from '../../../../shared/job-discovery'
import { SourceError, type AccountTransport } from '../../adapter'
import {
  LoginError,
  type QrProtocol,
  type QrRequestOptions,
  type QrTransport,
} from '../../qr-protocol'
import { record, text } from '../../parsing'

export const origin = 'https://www.yupao.com'
export const api = 'https://yupao-prod.yupaowang.com'
const passport = 'https://passport-prod.yupao.com'
const envelope = z.object({ code: z.number(), data: z.unknown().optional() })
type Body = Record<string, string | null>

// The public PC client's request signature, not an account credential.
export function yupaoOptions(
  data: Body,
  token = '',
  timestamp = String(Date.now()),
  nonce = String(randomInt(1_000_000)),
): QrRequestOptions {
  const values: Body = { ...data, timestamp, nonce }
  const input =
    Object.keys(values)
      .sort()
      .map((key) => `${key}=${values[key]}&`)
      .join('') + '*js1(Uc_m12j%hsn#1o%cn1'
  return {
    data,
    jsonBody: true,
    headers: {
      Origin: origin,
      Referer: `${origin}/`,
      reqsource: 'YPZP',
      business: 'YPZP',
      packageversion: '9.36.0',
      packagename: 'yp.pc',
      runtime: 'PC',
      hybird: 'NO',
      signVersion: '1',
      'request-source': 'java',
      timestamp,
      nonce,
      sign: createHash('sha256').update(input).digest('hex'),
      ...(token ? { token } : {}),
    },
  }
}
export function yupaoData(value: unknown): unknown {
  const result = envelope.safeParse(value)
  if (!result.success) throw new SourceError('parse_error', 'response_contract_changed')
  if ([401, 10160001].includes(result.data.code)) throw new SourceError('login_required')
  if ([403, 429].includes(result.data.code)) throw new SourceError('challenge')
  if (result.data.code !== 0) throw new SourceError('parse_error', 'response_contract_changed')
  return result.data.data
}

function qrData(value: unknown): unknown {
  try {
    return yupaoData(value)
  } catch (error) {
    return qrError(error)
  }
}
function qrError(error: unknown): never {
  if (error instanceof SourceError)
    throw new LoginError(error.state === 'parse_error' ? 'protocol' : 'verification', {
      cause: error,
    })
  throw error
}

function cookieToken(value: string | null): string {
  if (!value) return ''
  // The website cookie helper JSON-encodes strings; the SSO server writes raw strings.
  if (value.startsWith('"')) {
    try {
      return text(JSON.parse(value))
    } catch {
      return ''
    }
  }
  return value
}
async function account(transport: Pick<QrTransport, 'json'>, token: string): Promise<boolean> {
  const value = await transport.json(
    `${api}/account/v1/userBase/getLoginUserInfo`,
    envelope.parse,
    yupaoOptions({ token }, token),
  )
  if ([401, 10160001].includes(value.code)) return false
  const user = record(yupaoData(value)),
    id = user.userId
  if (
    !((typeof id === 'number' && Number.isSafeInteger(id) && id > 0) || /^[1-9]\d*$/.test(text(id)))
  )
    throw new SourceError('parse_error', 'account_contract_changed')
  // The official site's current recruiter/jobseeker role can change independently
  // of authentication. Only the positive account identity establishes a login;
  // search access and any real verification are checked by the search workflow.
  return true
}
export async function yupaoAccount(transport: AccountTransport): Promise<boolean> {
  const token = cookieToken(await transport.cookie(origin, 'TOKEN'))
  return !!token && account(transport, token)
}

// The observed SSO service has one destination and one opaque ticket. Never
// forward credentials to arbitrary URLs supplied in an otherwise valid response.
export function yupaoSso(value: unknown): { url: string; data: Body }[] {
  if (!Array.isArray(value) || !value.length || value.length > 4) throw new LoginError('protocol')
  return value.map((entry) => {
    let url: URL
    try {
      url = new URL(text(record(entry).url))
    } catch {
      throw new LoginError('protocol')
    }
    if (
      url.origin !== passport ||
      url.username ||
      url.password ||
      url.hash ||
      url.pathname !== '/account/v1/login/setCookie' ||
      [...url.searchParams.keys()].join(',') !== 'ticket' ||
      !url.searchParams.get('ticket') ||
      url.href.length > 10240
    )
      throw new LoginError('protocol')
    return { url: url.href, data: { ticket: url.searchParams.get('ticket')! } }
  })
}
async function establish(transport: QrTransport, token: string): Promise<void> {
  const result = qrData(
    await transport.json(`${api}/account/v1/login/sso`, envelope.parse, yupaoOptions({}, token)),
  )
  const targets = yupaoSso(result)
  for (const target of targets)
    qrData(await transport.json(target.url, envelope.parse, yupaoOptions(target.data, token)))
  const saved = cookieToken(await transport.cookie(origin, 'TOKEN'))
  // A successful ticket exchange and a positive account response are both required.
  if (!saved || saved !== token || !(await account(transport, saved).catch(qrError)))
    throw new LoginError('protocol')
}

export function yupaoQr(transport: QrTransport, method: QrLoginMethod = 'wechat'): QrProtocol {
  if (!['wechat', 'app'].includes(method)) throw new LoginError('protocol')
  let key = '',
    scanned = false,
    image = ''
  const request = (path: string, data: Body) =>
    transport.json(`${api}${path}`, envelope.parse, yupaoOptions(data))
  return {
    async initialize() {
      scanned = false
      const result = await request(
        method === 'wechat' ? '/account/v1/login/mini/sunCode' : '/account/v1/login/app/qrCode',
        method === 'wechat'
          ? { adChannel: 'yupao_pc15a9b450', landUrl: `${origin}/web/login/`, ext: null }
          : {},
      )
      const data = record(qrData(result))
      key = text(method === 'wechat' ? data.sunCode : data.qrCode)
      image = text(method === 'wechat' ? data.sunCodeImg : data.qrCodeImg)
      // APP expiry (120s) is specified by the official PC client; mini code uses its response.
      const seconds = method === 'wechat' ? Number(data.expireTime) : 120
      if (!key || !image || !Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 1800)
        throw new LoginError('protocol')
      return { image, expiresInMs: seconds * 1000 }
    },
    async poll() {
      if (!key) throw new LoginError('protocol')
      if (method === 'app' && !scanned) {
        const result = await request('/account/v1/login/qrCode/userinfo', { qrCode: key })
        if ([10010013, 10010017].includes(result.code)) return 'expired'
        // The APP user-info endpoint reports an unscanned QR as 10010016.
        if ([10010016, 10010018].includes(result.code)) return 'waiting'
        const user = record(qrData(result))
        if (!Object.keys(user).length) return 'waiting'
        scanned = true
        transport.scanned()
        // The official APP flow starts a separate confirmation timeout after scanning.
        return { state: 'scanned', image, expiresInMs: 120000 }
      }
      const result = await request(
        method === 'wechat'
          ? '/account/v1/login/miniSunCodeLogin'
          : '/account/v1/login/appQrCodeLogin',
        method === 'wechat' ? { sunCode: key } : { qrCode: key },
      )
      if ([10010013, 10010017].includes(result.code)) return 'expired'
      if (result.code === 10010018) return scanned ? 'scanned' : 'waiting'
      const token = text(record(qrData(result)).token)
      if (!token) return scanned ? 'scanned' : 'waiting'
      await establish(transport, token)
      return 'authenticated'
    },
  }
}
