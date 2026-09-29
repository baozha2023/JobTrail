// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { reportRendererFault } from '../src/renderer/diagnostics'

describe('renderer diagnostics', () => {
  it('sends only sanitized faults and ignores IPC responses already handled by Main', () => {
    const report = vi.fn()
    window.diagnosticsApi = { report }
    reportRendererFault('vue.component', new Error('password=secret'))
    expect(report).toHaveBeenCalledWith({
      source: 'renderer',
      operation: 'vue.component',
      code: 'INTERNAL_ERROR',
    })
    expect(JSON.stringify(report.mock.calls)).not.toContain('secret')
    const ipcError = new Error('safe UI message')
    ipcError.name = 'IpcClientError'
    reportRendererFault('update.check-ui', ipcError)
    expect(report).toHaveBeenCalledTimes(1)
  })
})
