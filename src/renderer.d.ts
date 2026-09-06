import type { ZhijiApi, VelopackApi, WindowControlsApi } from './shared/types'

declare global {
  interface Window {
    zhijiApi: ZhijiApi
    velopackApi: VelopackApi
    windowControlsApi: WindowControlsApi
  }
}

export {}
