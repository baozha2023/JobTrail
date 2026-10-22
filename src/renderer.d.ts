import type { ZhijiApi, VelopackApi, WindowControlsApi } from './shared/types'
import type { DiagnosticInput, DiagnosticReceipt } from './shared/diagnostics'
import type { ExamPrintApi } from './shared/exams'

declare global {
  interface Window {
    examPrintApi: ExamPrintApi
    zhijiApi: ZhijiApi
    velopackApi: VelopackApi
    windowControlsApi: WindowControlsApi
    diagnosticsApi: { report(input: DiagnosticInput): Promise<DiagnosticReceipt> }
  }
}

export {}
