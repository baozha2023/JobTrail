import cityCatalog from '../../../shared/discovery-cities/nowcoder.json'
import { createCityLookup } from '../../../shared/discovery-city-catalog'
import type { PlatformAdapter } from '../adapter'
import { NowcoderSearch } from './nowcoder/search'
import { nowcoderPageScript } from './nowcoder/page'
import { nowcoderAccount, nowcoderQr } from './nowcoder/protocol'
import { nowcoderIdentity } from './nowcoder/parsing'

const hint = {
  'zh-CN': '使用牛客 APP 扫码并确认登录。',
  'en-US': 'Scan and confirm using the Nowcoder app.',
}
export const nowcoderAdapter: PlatformAdapter = {
  ...nowcoderIdentity,
  cities: createCityLookup(cityCatalog),
  accountCheckUrl: 'https://www.nowcoder.com/jobs/school/jobs',
  contractVersion: 1,
  sessionCheck: 'batch',
  remoteFilters: ['keyword', 'city'],
  createSearch: (page, query) => new NowcoderSearch(page, query),
  pageScript: nowcoderPageScript,
  checkSession: nowcoderAccount,
  qr: {
    scanHint: hint,
    methods: [
      { id: 'app', label: { 'zh-CN': '牛客 APP', 'en-US': 'Nowcoder app' }, scanHint: hint },
    ],
    create: nowcoderQr,
    headers: () => ({ Origin: 'https://www.nowcoder.com', Referer: 'https://www.nowcoder.com/' }),
  },
}
