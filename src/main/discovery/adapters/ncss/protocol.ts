import type { AccountTransport, AccountSessionState } from '../../adapter'
import { LoginError, type QrProtocol, type QrTransport } from '../../qr-protocol'
import type { QrLoginMethod } from '../../../../shared/job-discovery'
import type { PageSnapshot } from '../../extraction'
import { wait } from '../../async-control'
import { ncssPageScript } from './page'
import { ncssOrigin } from './parsing'

const entry = `${ncssOrigin}/student/signin.html`
export async function ncssAccount(transport: AccountTransport): Promise<AccountSessionState> {
  const page = await transport.page(`${ncssOrigin}/student/jobs/index.html`, ncssPageScript(false))
  return page.challenge
    ? 'challenge'
    : page.authenticated
      ? 'authenticated'
      : page.login
        ? 'login_required'
        : 'unknown'
}
export function ncssQr(transport: QrTransport, method: QrLoginMethod = 'wechat'): QrProtocol {
  if (method !== 'wechat') throw new LoginError('protocol')
  const page = transport.page()
  let state = ''
  let callbackSeen = false
  let callbackAt: number | null = null
  const inspectCallbacks = () => {
    for (const value of page.history()) {
      const url = new URL(value)
      if (url.hostname === 'account.chsi.com.cn' && url.searchParams.has('code')) {
        if (
          !state ||
          url.pathname !== '/passport/login' ||
          url.searchParams.getAll('code').length !== 1 ||
          !url.searchParams.get('code') ||
          url.searchParams.get('client_name') !== 'wechat' ||
          url.searchParams.getAll('state').length !== 1 ||
          url.searchParams.get('state') !== state
        )
          throw new LoginError('protocol')
        callbackSeen = true
        callbackAt ??= Date.now()
      }
    }
  }
  const snapshot = async () => page.read<PageSnapshot>(ncssPageScript(false))
  return {
    async initialize() {
      await page.load(entry)
      if ((await snapshot()).authenticated) return { state: 'authenticated' }
      const link = await page.read<string>(
        `document.querySelector('a[href^="https://open.weixin.qq.com/connect/qrconnect?"]')?.href||''`,
      )
      if (!link) return transport.verification(entry)
      const url = new URL(link),
        callback = new URL(url.searchParams.get('redirect_uri') ?? '')
      if (
        url.origin !== 'https://open.weixin.qq.com' ||
        url.pathname !== '/connect/qrconnect' ||
        callback.href !== 'https://account.chsi.com.cn/passport/login?client_name=wechat' ||
        url.searchParams.getAll('state').length !== 1
      )
        throw new LoginError('protocol')
      state = url.searchParams.get('state') ?? ''
      if (!/^[A-Za-z0-9_-]{6,128}$/.test(state)) throw new LoginError('protocol')
      // The official page must own both initialization and callback. Splitting
      // them into HTTP requests was rejected by CHSI in the real capability demo.
      await page.read(
        `document.querySelector('a[href^="https://open.weixin.qq.com/connect/qrconnect?"]').click()`,
      )
      for (let i = 0; i < 80; i++) {
        try {
          const image = await page.read<string>(
            `location.hostname==='open.weixin.qq.com'?document.querySelector('img.js_qrcode_img')?.src||'':''`,
          )
          if (image) {
            const u = new URL(image)
            if (
              u.origin !== 'https://open.weixin.qq.com' ||
              !/^\/connect\/qrcode\/[A-Za-z0-9_-]{8,128}$/.test(u.pathname) ||
              u.search ||
              u.hash
            )
              throw new LoginError('protocol')
            return { image: u.href, expiresInMs: 180000 }
          }
        } catch (error) {
          if (!/Execution context was destroyed/.test(String(error))) throw error
        }
        await wait(200, AbortSignal.timeout(1000))
      }
      throw new LoginError('protocol')
    },
    async poll() {
      try {
        inspectCallbacks()
        const account = await snapshot()
        if (account.authenticated) {
          if (!callbackSeen) throw new LoginError('protocol')
          return 'authenticated'
        }
        if (
          account.challenge ||
          // Give the official callback time to navigate through SSO before
          // handing a remaining account-linking/student-role page to the user.
          (callbackAt !== null && account.login && Date.now() - callbackAt >= 6000)
        )
          return transport.verification(account.url)
        const result = await page.read<{ scanned: boolean; expired: boolean }>(
          `(()=>{const visible=s=>[...document.querySelectorAll(s)].some(e=>e.getBoundingClientRect().width>0&&getComputedStyle(e).display!=='none');return {scanned:visible('.js_wx_after_scan'),expired:window.wx_errcode===402||window.wx_errcode===500}})()`,
        )
        return result.expired ? 'expired' : result.scanned ? 'scanned' : 'waiting'
      } catch (error) {
        // The official page owns navigation through SSO. A context replacement
        // is transient; account evidence is checked again on the next poll.
        if (/Execution context was destroyed/.test(String(error))) return 'waiting'
        throw error
      }
    },
  }
}
