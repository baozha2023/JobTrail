// @vitest-environment jsdom
import { newDiagnosticContext } from '../src/shared/diagnostics'

import { describe, expect, it, vi } from 'vitest'
import { reportRendererFault } from '../src/renderer/diagnostics'

describe('renderer diagnostics', () => {
  it('sends only sanitized faults and ignores IPC responses already handled by Main', () => {
    const report = vi.fn().mockResolvedValue({ status: 'written' })
    window.diagnosticsApi = { report }
    reportRendererFault('vue.component', new Error('password=secret'))
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'renderer',
        operation: 'vue.component',
        code: 'INTERNAL_ERROR',
      }),
    )
    expect(JSON.stringify(report.mock.calls)).not.toContain('secret')
    const ipcError = {
      name: 'IpcClientError',
      code: 'INTERNAL_ERROR',
      message: 'safe UI message',
      diagnostic: { ...newDiagnosticContext(), eventId: crypto.randomUUID() },
    }
    reportRendererFault('update.check-ui', ipcError)
    expect(report).toHaveBeenCalledTimes(1)
  })
})
