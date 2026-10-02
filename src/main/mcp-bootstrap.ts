import fs from 'node:fs'
import { initializeDiagnostics, captureError } from './diagnostics'

const root = process.env.JOBTRAIL_MCP_ROOT ?? process.cwd()
initializeDiagnostics(
  'mcp',
  process.env.JOBTRAIL_MCP_VERSION ?? 'unknown',
  fs.existsSync(`${root}/.jobtrail-root`) || import.meta.url.includes('app.asar'),
  root,
)
process.on('uncaughtExceptionMonitor', (error) =>
  captureError(error, { operation: 'process.uncaught', level: 'fatal' }),
)

void import('./mcp-node').catch((error: unknown) => {
  captureError(error, { operation: 'mcp.bootstrap' })
  process.exit(1)
})
