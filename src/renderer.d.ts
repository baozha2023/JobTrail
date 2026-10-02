import type { ZhijiApi, VelopackApi, WindowControlsApi } from './shared/types'
import type { DiagnosticInput, DiagnosticReceipt } from './shared/diagnostics'

declare global {
  interface Window {
    zhijiApi: ZhijiApi
    velopackApi: VelopackApi
    windowControlsApi: WindowControlsApi
    diagnosticsApi: { report(input: DiagnosticInput): Promise<DiagnosticReceipt> }
  }
}

export {}
