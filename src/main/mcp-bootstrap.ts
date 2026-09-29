import fs from 'node:fs'
import { initializeFaultLogger, logFault } from './diagnostics'

const root = process.env.JOBTRAIL_MCP_ROOT ?? process.cwd()
initializeFaultLogger(
  'mcp',
  process.env.JOBTRAIL_MCP_VERSION ?? 'unknown',
  fs.existsSync(`${root}/.jobtrail-root`) || import.meta.url.includes('app.asar'),
  root,
)
process.on('uncaughtExceptionMonitor', (error) => logFault('process.uncaught', error))

void import('./mcp-node').catch((error: unknown) => {
  logFault('mcp.bootstrap', error)
  process.exit(1)
})
