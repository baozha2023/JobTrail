import { initializeFaultLogger, logFault } from '../diagnostics'

initializeFaultLogger(
  'agent',
  process.env.JOBTRAIL_LOG_VERSION ?? 'unknown',
  process.env.JOBTRAIL_LOG_PACKAGED === '1',
  process.env.JOBTRAIL_LOG_ROOT ?? process.cwd(),
)
process.on('uncaughtExceptionMonitor', (error) => logFault('process.uncaught', error))
process.on('unhandledRejection', (error) => {
  logFault('process.unhandled-rejection', error)
  process.exit(1)
})

// pdf-parse evaluates PDF.js during module loading. Initialize diagnostics
// before loading native modules, then provide geometry globals for the worker.
void import('@napi-rs/canvas')
  .then(({ DOMMatrix, ImageData, Path2D }) => {
    Object.assign(globalThis, { DOMMatrix, ImageData, Path2D })
    return import('./worker')
  })
  .catch((error: unknown) => {
    logFault('agent.bootstrap', error)
    process.exit(1)
  })
