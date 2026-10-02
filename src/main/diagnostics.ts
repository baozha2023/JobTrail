import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import {
  createErrorInput,
  DIAGNOSTIC_VERSION,
  newDiagnosticContext,
  diagnosticReference,
  validateDiagnosticEvent,
  validateDiagnosticInput,
  MAX_EVENT_BYTES,
  errorField,
  isDiagnosticCancellation,
  type DiagnosticContext,
  type DiagnosticInput,
  type DiagnosticEvent,
  type DiagnosticProcess,
  type DiagnosticReference,
  type DiagnosticAttributes,
  type DiagnosticReceipt,
} from '../shared/diagnostics'
import { DiagnosticWriter, type WriterOptions } from './diagnostics/writer'

export interface OperationContext extends Partial<DiagnosticContext> {
  operation: string
  source?: DiagnosticProcess
  level?: DiagnosticInput['level']
}
const contexts = new AsyncLocalStorage<DiagnosticContext>()
const references = new WeakMap<object, Map<string, DiagnosticReference>>()
export function currentDiagnosticContext(): DiagnosticContext | undefined {
  return contexts.getStore()
}
export function withDiagnosticContext<T>(context: DiagnosticContext, callback: () => T): T {
  return contexts.run(context, callback)
}
export function findDiagnosticReference(error: unknown): DiagnosticReference | undefined {
  const transported = diagnosticReference(error)
  if (transported) return transported
  if (!error || typeof error !== 'object') return undefined
  const map = references.get(error),
    context = contexts.getStore()
  return context ? map?.get(context.traceId) : undefined
}
export class Diagnostics {
  readonly writer: DiagnosticWriter
  private sequence = 0
  constructor(
    readonly source: DiagnosticProcess,
    readonly version: string,
    packaged: boolean,
    root: string,
    options: WriterOptions = {},
  ) {
    this.writer = new DiagnosticWriter(source, root, packaged, options)
  }
  accept(input: DiagnosticInput, pid = process.pid): DiagnosticReceipt {
    const parsed = validateDiagnosticInput(input)
    if (!parsed) {
      this.writer.health.dropped++
      return { eventId: input.eventId, status: 'unavailable' }
    }
    const { source, ...data } = parsed
    const event: DiagnosticEvent = {
      ...data,
      process: source,
      pid,
      appVersion: this.version,
      instanceId: this.writer.instanceId,
      sequence: ++this.sequence,
    }
    return this.writer.accept(event)
  }
  close(): void {
    this.writer.close()
  }
}
let current: Diagnostics | undefined
const early: DiagnosticInput[] = []
let earlyDropped = 0
let registeredExit = false
export function initializeDiagnostics(
  source: DiagnosticProcess,
  version: string,
  packaged: boolean,
  root: string,
): Diagnostics {
  current?.close()
  current = new Diagnostics(source, version, packaged, root)
  if (!registeredExit) {
    process.once('exit', () => current?.close())
    registeredExit = true
  }
  for (const input of early.splice(0)) current.accept(input)
  const health = current.writer.health
  recordEvent({
    operation: 'diagnostics.initialize',
    kind: 'maintenance',
    attributes: {
      count: health.deletedFiles,
      failedCount: health.maintenanceFailures,
      skippedCount: health.skippedFiles + earlyDropped,
    },
  })
  return current
}
function emit(input: DiagnosticInput): DiagnosticReceipt {
  if (current) return current.accept(input)
  if (early.length < 256) early.push(input)
  else earlyDropped++
  try {
    process.stderr.write(JSON.stringify({ ...input, appVersion: 'unknown' }) + '\n')
  } catch {
    earlyDropped++
  }
  return { eventId: input.eventId, status: 'buffered' }
}
export function captureError(error: unknown, options: OperationContext): DiagnosticReference {
  const context =
    options.traceId && options.spanId
      ? { traceId: options.traceId, spanId: options.spanId, parentSpanId: options.parentSpanId }
      : (contexts.getStore() ?? newDiagnosticContext())
  const existing =
    diagnosticReference(error) ??
    (error && typeof error === 'object' ? references.get(error)?.get(context.traceId) : undefined)
  if (existing) return existing
  const input = createErrorInput(
    options.source ?? current?.source ?? 'main',
    options.operation,
    error,
    context,
  )
  if (options.level) input.level = options.level
  const reference: DiagnosticReference = { eventId: input.eventId, ...context }
  if (error && typeof error === 'object') {
    const map = references.get(error) ?? new Map<string, DiagnosticReference>()
    map.set(context.traceId, reference)
    if (map.size > 8) map.delete(map.keys().next().value!)
    references.set(error, map)
  }
  emit(input)
  return reference
}
export function recordEvent(
  event: {
    operation: string
    source?: DiagnosticProcess
    kind?: DiagnosticInput['kind']
    outcome?: DiagnosticInput['outcome']
    attributes?: DiagnosticAttributes
  },
  context = contexts.getStore() ?? newDiagnosticContext(),
): DiagnosticReference {
  const input: DiagnosticInput = {
    schemaVersion: DIAGNOSTIC_VERSION,
    timestamp: new Date().toISOString(),
    eventId: randomUUID(),
    ...context,
    source: event.source ?? current?.source ?? 'main',
    operation: event.operation,
    kind: event.kind ?? 'operation',
    level: 'info',
    ...(event.outcome ? { outcome: event.outcome } : {}),
    ...(event.attributes ? { attributes: event.attributes } : {}),
  }
  emit(input)
  return { eventId: input.eventId, ...context }
}
export async function runOperation<T>(
  options: OperationContext,
  operation: () => T | Promise<T>,
): Promise<T> {
  const parent =
    options.traceId && options.spanId ? (options as DiagnosticContext) : contexts.getStore()
  const context = newDiagnosticContext(parent)
  return contexts.run(context, async () => {
    const start = performance.now()
    recordEvent({ operation: options.operation, outcome: 'started' })
    try {
      const result = await operation()
      recordEvent({
        operation: options.operation,
        outcome:
          result === 'cancelled'
            ? 'cancelled'
            : errorField(result, 'isError') === true
              ? 'failed'
              : 'succeeded',
        attributes: { durationMs: performance.now() - start },
      })
      return result
    } catch (error) {
      const reference = captureError(error, { ...options, ...context })
      recordEvent({
        operation: options.operation,
        outcome: isDiagnosticCancellation(error) ? 'cancelled' : 'failed',
        attributes: { durationMs: performance.now() - start, relatedEventId: reference.eventId },
      })
      throw error
    }
  })
}
export function acceptDiagnosticInput(input: DiagnosticInput, pid: number): DiagnosticReceipt {
  return current?.accept(input, pid) ?? emit(input)
}
export function flushDiagnostics(): void {
  current?.writer.flush()
}
export function getDiagnosticsHealth() {
  return current
    ? { ...current.writer.health }
    : {
        degraded: true,
        writeFailures: 0,
        transportFailures: 0,
        dropped: earlyDropped,
        aggregated: 0,
        deletedFiles: 0,
        maintenanceFailures: 0,
        skippedFiles: 0,
        overBudget: false,
      }
}
export function maintenanceDiagnostics(): void {
  current?.writer.maintain()
}
export function diagnosticRoot(): string | undefined {
  return current?.writer.root
}
export function forwardDiagnosticStderr(
  stream:
    | { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown }
    | null
    | undefined,
  write = (line: string) => {
    process.stderr.write(line)
  },
): void {
  let pending = '',
    discarding = false
  const decoder = new StringDecoder('utf8')
  stream?.on('data', (chunk) => {
    const text = typeof chunk === 'string' ? chunk : decoder.write(chunk)
    for (const piece of text.split(/(?<=\n)/)) {
      if (!discarding) pending += piece
      if (Buffer.byteLength(pending) > MAX_EVENT_BYTES) {
        pending = ''
        discarding = true
      }
      if (!piece.endsWith('\n')) continue
      if (!discarding)
        try {
          const record = validateDiagnosticEvent(JSON.parse(pending))
          if (record) {
            // Packaged children emit stderr only when their file sink has failed.
            // Preserve the original event/reference in the parent's independent sink.
            if (current?.writer.packaged) {
              current.writer.health.transportFailures++
              current.writer.health.degraded = true
              current.writer.accept(record)
            }
            write(JSON.stringify(record) + '\n')
          } else
            captureError(
              { code: 'DIAGNOSTICS_TRANSPORT_FAILED', message: 'Invalid child diagnostic record' },
              { operation: 'diagnostics.child-transport' },
            )
        } catch {
          captureError(
            {
              code: 'DIAGNOSTICS_TRANSPORT_FAILED',
              message: 'Unstructured child diagnostic output',
            },
            { operation: 'diagnostics.child-transport' },
          )
        }
      else
        captureError(
          { code: 'DIAGNOSTICS_OVERFLOW', message: 'Child diagnostic record exceeds size limit' },
          { operation: 'diagnostics.child-transport' },
        )
      pending = ''
      discarding = false
    }
  })
}

export function closeDiagnostics(): void {
  current?.close()
  current = undefined
}
