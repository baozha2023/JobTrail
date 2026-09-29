import type { ZhijiApi, VelopackApi, WindowControlsApi } from './shared/types'
import type { FaultInput } from './shared/diagnostics'

declare global {
  interface Window {
    zhijiApi: ZhijiApi
    velopackApi: VelopackApi
    windowControlsApi: WindowControlsApi
    diagnosticsApi: { report(input: FaultInput): void }
  }
}

export {}
