import { initializeDiagnostics, captureError } from '../diagnostics'

initializeDiagnostics(
  'agent',
  process.env.JOBTRAIL_LOG_VERSION ?? 'unknown',
  process.env.JOBTRAIL_LOG_PACKAGED === '1',
  process.env.JOBTRAIL_LOG_ROOT ?? process.cwd(),
)
process.on('uncaughtExceptionMonitor', (error) =>
  captureError(error, { operation: 'process.uncaught', level: 'fatal' }),
)
process.on('unhandledRejection', (error) => {
  captureError(error, { operation: 'process.unhandled-rejection', level: 'fatal' })
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
    captureError(error, { operation: 'agent.bootstrap' })
    process.exit(1)
  })
