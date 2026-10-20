import catalog from '../../../shared/discovery-cities/ncss.json'
import { createCityLookup } from '../../../shared/discovery-city-catalog'
import type { PlatformAdapter } from '../adapter'
import { ncssIdentity, ncssOrigin } from './ncss/parsing'
import { NcssSearch } from './ncss/search'
import { ncssPageScript, ncssVerification } from './ncss/page'
import { ncssAccount, ncssQr } from './ncss/protocol'

const hint = {
  'zh-CN': '使用微信扫描学信网官方二维码并确认登录；需要绑定学信网账号或验证时，请在官方窗口完成。',
  'en-US':
    'Scan the official CHSI QR code with WeChat. Complete account linking or verification in the official window when requested.',
}
export const ncssAdapter: PlatformAdapter = {
  ...ncssIdentity,
  cities: createCityLookup(catalog),
  accountCheckUrl: `${ncssOrigin}/student/jobs/index.html`,
  contractVersion: 1,
  sessionCheck: 'batch',
  remoteFilters: ['keyword', 'city'],
  createSearch: (page, query) => new NcssSearch(page, query),
  pageScript: ncssPageScript,
  checkSession: ncssAccount,
  verification: ncssVerification,
  qr: {
    scanHint: hint,
    methods: [{ id: 'wechat', label: { 'zh-CN': '微信', 'en-US': 'WeChat' }, scanHint: hint }],
    create: ncssQr,
    allowsImageUrl: (value) => {
      try {
        const url = new URL(value)
        return (
          url.origin === 'https://open.weixin.qq.com' &&
          !url.username &&
          !url.password &&
          /^\/connect\/qrcode\/[A-Za-z0-9_-]{8,128}$/.test(url.pathname) &&
          !url.search &&
          !url.hash
        )
      } catch {
        return false
      }
    },
  },
}
