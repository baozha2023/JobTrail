import type { QrLoginMethod } from '../../../../shared/job-discovery'
import { SourceError, type AccountSessionState, type AccountTransport } from '../../adapter'
import { LoginError, type QrProtocol, type QrTransport } from '../../qr-protocol'
import { record, text } from '../../parsing'
import { nowcoderEnvelope, nowcoderOrigin } from './parsing'
import { nowcoderPageScript } from './page'

export async function nowcoderAccount(transport: AccountTransport): Promise<AccountSessionState> {
  const result = await transport.json(
    `${nowcoderOrigin}/profile/user-info-v2`,
    nowcoderEnvelope.parse,
  )
  if ([999, 401].includes(result.code)) return 'login_required'
  if ([403, 429, 1125].includes(result.code)) return 'challenge'
  if (result.code !== 0) throw new SourceError('parse_error', 'account_contract_changed')
  // An anonymous search response cannot authenticate an account. The website's
  // visible signed-in avatar supplies independent positive page evidence.
  const page = await transport.page(`${nowcoderOrigin}/jobs/school/jobs`, nowcoderPageScript(false))
  return page.challenge
    ? 'challenge'
    : page.login
      ? 'login_required'
      : page.authenticated
        ? 'authenticated'
        : 'unknown'
}
export function nowcoderQr(transport: QrTransport, method: QrLoginMethod = 'app'): QrProtocol {
  if (method !== 'app') throw new LoginError('protocol')
  let code = ''
  return {
    async initialize() {
      const result = await transport.json(`${nowcoderOrigin}/scan/code`, nowcoderEnvelope.parse)
      const data = record(result.data)
      code = text(data.code)
      if ([403, 429, 1125].includes(result.code)) throw new LoginError('verification')
      if (
        result.code !== 0 ||
        !code ||
        code.length > 1024 ||
        !Number.isSafeInteger(data.expireSecs) ||
        Number(data.expireSecs) <= 0 ||
        Number(data.expireSecs) > 600
      )
        throw new LoginError('protocol')
      return {
        image: `${nowcoderOrigin}/qrcode/to-pc-code?${new URLSearchParams({ code })}`,
        expiresInMs: Number(data.expireSecs) * 1000,
      }
    },
    async poll() {
      if (!code) throw new LoginError('protocol')
      const result = await transport.json(
        `${nowcoderOrigin}/scan/updateInfo?${new URLSearchParams({ code })}`,
        nowcoderEnvelope.parse,
      )
      if ([403, 429, 1125].includes(result.code)) throw new LoginError('verification')
      if (result.code === 2) return 'expired'
      if (result.code === 1) return 'waiting'
      if (result.code !== 0) throw new LoginError('protocol')
      const account = await transport.json(
        `${nowcoderOrigin}/profile/user-info-v2`,
        nowcoderEnvelope.parse,
      )
      if ([403, 429, 1125].includes(account.code)) throw new LoginError('verification')
      if ([999, 401].includes(account.code)) return 'scanned'
      if (account.code !== 0 || !Object.keys(record(account.data)).length)
        throw new LoginError('protocol')
      return 'authenticated'
    },
  }
}
