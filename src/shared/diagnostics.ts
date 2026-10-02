import { ERROR_CODES, knownErrorCode, type DiagnosticErrorCode } from './error-codes'

export const DIAGNOSTIC_VERSION = 1
export const MAX_EVENT_BYTES = 32 * 1024
export type DiagnosticProcess = 'main' | 'renderer' | 'preload' | 'agent' | 'mcp'
export type DiagnosticLevel = 'info' | 'warn' | 'error' | 'fatal'
export interface DiagnosticContext {
  traceId: string
  spanId: string
  parentSpanId?: string
}
export interface DiagnosticReference extends DiagnosticContext {
  eventId: string
}
export interface DiagnosticError {
  name: string
  message: string
  originalCode?: string
  httpStatus?: number
  stack?: string[]
  cause?: DiagnosticError
  errors?: DiagnosticError[]
  truncated?: boolean
  unreadable?: boolean
  redacted?: boolean
}
export interface DiagnosticAttributes {
  durationMs?: number
  count?: number
  failedCount?: number
  skippedCount?: number
  attempt?: number
  exitCode?: number
  databaseVersion?: number
  configVersion?: number
  firstSeenAt?: number
  lastSeenAt?: number
  relatedEventId?: string
}
export interface DiagnosticInput extends DiagnosticReference {
  schemaVersion: typeof DIAGNOSTIC_VERSION
  timestamp: string
  source: DiagnosticProcess
  operation: string
  kind: 'error' | 'operation' | 'maintenance'
  level: DiagnosticLevel
  code?: DiagnosticErrorCode
  outcome?: 'started' | 'succeeded' | 'failed' | 'cancelled'
  error?: DiagnosticError
  attributes?: DiagnosticAttributes
}
export interface DiagnosticEvent extends Omit<DiagnosticInput, 'source'> {
  process: DiagnosticProcess
  pid: number
  instanceId: string
  sequence: number
  appVersion: string
}
export interface DiagnosticsHealth {
  degraded: boolean
  writeFailures: number
  transportFailures: number
  dropped: number
  aggregated: number
  deletedFiles: number
  maintenanceFailures: number
  skippedFiles: number
  overBudget: boolean
}
export type DiagnosticReceipt = {
  eventId: string
  status: 'written' | 'buffered' | 'fallback' | 'unavailable' | 'duplicate'
}

const nativeStackGetter = Object.getOwnPropertyDescriptor(new Error(), 'stack')?.get

// Read data descriptors only: inspecting an exception must never execute application getters.
export function errorField(value: unknown, key: string): unknown {
  try {
    let object = value
    for (let depth = 0; object && typeof object === 'object' && depth < 8; depth++) {
      const descriptor = Object.getOwnPropertyDescriptor(object, key)
      if (descriptor) {
        if ('value' in descriptor) return descriptor.value
        // V8 stores Error.stack behind a shared native accessor, including assigned stacks.
        if (key === 'stack' && nativeStackGetter && descriptor.get === nativeStackGetter)
          return nativeStackGetter.call(value)
        return undefined
      }
      object = Object.getPrototypeOf(object)
    }
  } catch {
    /* Proxies may reject introspection; normalization supplies an unreadable marker. */
  }
  return undefined
}
const encoder = new TextEncoder()
export function byteLength(value: string): number {
  return encoder.encode(value).length
}
export function boundedText(value: string, maximum: number): string {
  if (byteLength(value) <= maximum) return value
  let end = Math.min(value.length, maximum)
  while (end > 0 && byteLength(value.slice(0, end)) > maximum) end = Math.floor(end * 0.9)
  return value.slice(0, end) + '…'
}
const secrets = new Set<string>()
export function registerDiagnosticSecrets(values: readonly string[]): void {
  for (const value of values) if (value.length >= 4) secrets.add(value)
  while (secrets.size > 128) secrets.delete(secrets.values().next().value!)
}
export function redactDiagnosticText(text: string): string {
  let result = text
  for (const secret of secrets) result = result.split(secret).join('[REDACTED]')
  return result
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;"']+/gi, '[AUTH REDACTED]')
    .replace(
      /\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*[:=]\s*[^\r\n]+/gi,
      '[HEADER REDACTED]',
    )
    .replace(
      /(["']?\b(?:api[_-]?key|token|password|secret|access[_-]?token|refresh[_-]?token)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi,
      '$1[REDACTED]',
    )
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[KEY REDACTED]')
    .replace(/https?:\/\/[^\s)"'<>]+/gi, (url) => {
      try {
        const parsed = new URL(url)
        return `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search ? '?[REDACTED]' : ''}`
      } catch {
        return '[URL REDACTED]'
      }
    })
    .replace(/(?<![A-Za-z0-9])(?:[A-Za-z]:[\\/]|\\\\)[^\r\n"'<>|)]+/g, (file) => {
      const normalized = file.replaceAll('\\', '/')
      const relative = /(?:^|\/)((?:src|out|node_modules)\/.*)$/.exec(normalized)
      return relative ? relative[1] : '[PATH]'
    })
    .replace(/(?<![:\w])\/(?:Users|home|tmp|var|private|opt|mnt|workspace)\/[^\s)"'<>]+/g, '[PATH]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
}

export function normalizeDiagnosticError(
  value: unknown,
  depth = 0,
  seen = new Set<object>(),
  budget = { remaining: 64 },
): DiagnosticError {
  if (--budget.remaining < 0)
    return { name: 'Error', message: '[Exception size limit]', truncated: true }
  if (depth >= 5) return { name: 'Error', message: '[Cause depth exceeded]', truncated: true }
  if (value && typeof value === 'object') {
    if (seen.has(value)) return { name: 'Error', message: '[Circular cause]', truncated: true }
    seen.add(value)
  }
  const rawName = errorField(value, 'name')
  const name = typeof rawName === 'string' ? rawName : 'Error'
  const rawMessage = typeof value === 'string' ? value : errorField(value, 'message')
  let message = typeof rawMessage === 'string' ? rawMessage : '[Exception details unavailable]'
  // Parser/validator messages can embed complete user input. Keep the failure category instead.
  if (name === 'ZodError') message = 'Input validation failed'
  if (name === 'SyntaxError' && /JSON|Unexpected token|Unexpected non-whitespace/.test(message))
    message = 'Invalid JSON input'
  const clean = redactDiagnosticText(message)
  const result: DiagnosticError = {
    name: boundedText(redactDiagnosticText(name), 128),
    message: boundedText(clean, 4093),
    ...(typeof rawMessage !== 'string' ? { unreadable: true } : {}),
    ...(clean !== message || message !== rawMessage ? { redacted: true } : {}),
    ...(byteLength(clean) > 4093 ? { truncated: true } : {}),
  }
  const code = errorField(value, 'code')
  if (typeof code === 'string' || typeof code === 'number')
    result.originalCode = boundedText(redactDiagnosticText(String(code)), 128)
  const status = errorField(value, 'status') ?? errorField(value, 'statusCode')
  const httpStatus =
    typeof status === 'number'
      ? status
      : Number(
          /(?:http\s+(?:status|error)|status(?:\s+code)?)\s*[:=]?\s*([1-5]\d\d)/i.exec(
            message,
          )?.[1],
        )
  if (Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599)
    result.httpStatus = httpStatus
  const stack = errorField(value, 'stack')
  if (typeof stack === 'string') {
    const frames = stack
      .split('\n')
      .slice(1)
      .filter((line) => /^\s*at\s/.test(line))
    result.stack = frames
      .slice(0, 20)
      .map((line) => boundedText(redactDiagnosticText(line.trim()), 512))
    if (frames.length > 20) result.truncated = true
  }
  const cause = errorField(value, 'cause')
  if (cause !== undefined) result.cause = normalizeDiagnosticError(cause, depth + 1, seen, budget)
  const errors = errorField(value, 'errors')
  if (Array.isArray(errors)) {
    const length = errorField(errors, 'length') as number
    result.errors = Array.from({ length: Math.min(length, 10) }, (_, index) =>
      normalizeDiagnosticError(errorField(errors, String(index)), depth + 1, seen, budget),
    )
    if (length > 10) result.truncated = true
  }
  return result
}
export function newDiagnosticContext(parent?: DiagnosticContext): DiagnosticContext {
  return {
    traceId: parent?.traceId ?? crypto.randomUUID(),
    spanId: crypto.randomUUID(),
    ...(parent ? { parentSpanId: parent.spanId } : {}),
  }
}
export function validDiagnosticContext(value: unknown): value is DiagnosticContext {
  return (
    isRecord(value) &&
    validId(errorField(value, 'traceId')) &&
    validId(errorField(value, 'spanId')) &&
    (errorField(value, 'parentSpanId') === undefined || validId(errorField(value, 'parentSpanId')))
  )
}
export function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
}
export function diagnosticReference(value: unknown): DiagnosticReference | undefined {
  const candidate = errorField(value, 'diagnostic')
  const eventId = errorField(candidate, 'eventId')
  if (!validDiagnosticContext(candidate) || !validId(eventId)) return undefined
  const parentSpanId = errorField(candidate, 'parentSpanId')
  return {
    eventId,
    traceId: errorField(candidate, 'traceId') as string,
    spanId: errorField(candidate, 'spanId') as string,
    ...(typeof parentSpanId === 'string' ? { parentSpanId } : {}),
  }
}
export function isDiagnosticCancellation(error: unknown): boolean {
  const name = errorField(error, 'name')
  const code = errorField(error, 'code')
  return (
    name === 'AbortError' ||
    name === 'CanceledError' ||
    (knownErrorCode(code) && ERROR_CODES[code].level === 'info')
  )
}
export function createErrorInput(
  source: DiagnosticProcess,
  operation: string,
  error: unknown,
  context = newDiagnosticContext(),
): DiagnosticInput {
  const rawCode = errorField(error, 'code')
  const name = errorField(error, 'name')
  const code = knownErrorCode(rawCode)
    ? rawCode
    : name === 'DatabaseVersionError'
      ? 'DATABASE_VERSION_UNSUPPORTED'
      : typeof rawCode === 'string' && /^SQLITE_/.test(rawCode)
        ? 'DATABASE_ERROR'
        : typeof rawCode === 'string' && /^E[A-Z]{2,30}$/.test(rawCode)
          ? 'SYSTEM_ERROR'
          : 'INTERNAL_ERROR'
  const cancelled = isDiagnosticCancellation(error)
  return boundInput({
    schemaVersion: DIAGNOSTIC_VERSION,
    timestamp: new Date().toISOString(),
    eventId: crypto.randomUUID(),
    ...context,
    source,
    operation,
    kind: cancelled ? 'operation' : 'error',
    code,
    level: cancelled ? 'info' : ERROR_CODES[code].level,
    ...(cancelled ? { outcome: 'cancelled' } : {}),
    error: normalizeDiagnosticError(error),
  })
}
export function boundInput(input: DiagnosticInput): DiagnosticInput {
  if (byteLength(JSON.stringify(input)) <= MAX_EVENT_BYTES - 1024) return input
  return {
    ...input,
    error: input.error
      ? {
          name: input.error.name,
          message: boundedText(input.error.message, 4093),
          originalCode: input.error.originalCode,
          httpStatus: input.error.httpStatus,
          truncated: true,
          redacted: input.error.redacted,
        }
      : undefined,
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}
function validError(value: unknown, depth = 0): value is DiagnosticError {
  if (
    depth > 5 ||
    !isRecord(value) ||
    !exactKeys(value, [
      'name',
      'message',
      'originalCode',
      'httpStatus',
      'stack',
      'cause',
      'errors',
      'truncated',
      'unreadable',
      'redacted',
    ])
  )
    return false
  if (
    typeof value.name !== 'string' ||
    byteLength(value.name) > 131 ||
    typeof value.message !== 'string' ||
    byteLength(value.message) > 4096
  )
    return false
  if (
    value.originalCode !== undefined &&
    (typeof value.originalCode !== 'string' || byteLength(value.originalCode) > 131)
  )
    return false
  if (
    value.httpStatus !== undefined &&
    (!Number.isInteger(value.httpStatus) ||
      Number(value.httpStatus) < 100 ||
      Number(value.httpStatus) > 599)
  )
    return false
  if (
    value.stack !== undefined &&
    (!Array.isArray(value.stack) ||
      value.stack.length > 20 ||
      !value.stack.every((frame) => typeof frame === 'string' && byteLength(frame) <= 515))
  )
    return false
  if (
    ['truncated', 'unreadable', 'redacted'].some(
      (key) => value[key] !== undefined && typeof value[key] !== 'boolean',
    )
  )
    return false
  return (
    (value.cause === undefined || validError(value.cause, depth + 1)) &&
    (value.errors === undefined ||
      (Array.isArray(value.errors) &&
        value.errors.length <= 10 &&
        value.errors.every((item) => validError(item, depth + 1))))
  )
}
export function validateDiagnosticInput(value: unknown): DiagnosticInput | null {
  try {
    if (
      !isRecord(value) ||
      byteLength(JSON.stringify(value)) > MAX_EVENT_BYTES ||
      !exactKeys(value, [
        'schemaVersion',
        'timestamp',
        'source',
        'operation',
        'kind',
        'level',
        'code',
        'outcome',
        'error',
        'attributes',
        'eventId',
        'traceId',
        'spanId',
        'parentSpanId',
      ])
    )
      return null
    if (
      value.schemaVersion !== DIAGNOSTIC_VERSION ||
      !validDiagnosticContext(value) ||
      !validId(value.eventId)
    )
      return null
    if (
      typeof value.timestamp !== 'string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.timestamp) ||
      !Number.isFinite(Date.parse(value.timestamp))
    )
      return null
    if (
      !['main', 'renderer', 'preload', 'agent', 'mcp'].includes(String(value.source)) ||
      typeof value.operation !== 'string' ||
      !/^[a-z][a-z0-9.-]{0,95}$/.test(value.operation)
    )
      return null
    if (
      !['error', 'operation', 'maintenance'].includes(String(value.kind)) ||
      !['info', 'warn', 'error', 'fatal'].includes(String(value.level))
    )
      return null
    if (value.code !== undefined && !knownErrorCode(value.code)) return null
    if (
      value.outcome !== undefined &&
      !['started', 'succeeded', 'failed', 'cancelled'].includes(String(value.outcome))
    )
      return null
    if (value.error !== undefined && !validError(value.error)) return null
    if (value.attributes !== undefined) {
      if (
        !isRecord(value.attributes) ||
        !exactKeys(value.attributes, [
          'durationMs',
          'count',
          'failedCount',
          'skippedCount',
          'attempt',
          'exitCode',
          'databaseVersion',
          'configVersion',
          'relatedEventId',
          'firstSeenAt',
          'lastSeenAt',
        ])
      )
        return null
      for (const [key, item] of Object.entries(value.attributes))
        if (
          key === 'relatedEventId'
            ? !validId(item)
            : typeof item !== 'number' || !Number.isFinite(item)
        )
          return null
    }
    // Incoming serialized data is sanitized again; never trust a producer's redaction claim.
    const clean = JSON.parse(JSON.stringify(value)) as DiagnosticInput
    if (clean.error) sanitizeError(clean.error)
    return boundInput(clean)
  } catch {
    return null
  }
}
export function validateDiagnosticEvent(value: unknown): DiagnosticEvent | null {
  if (!isRecord(value)) return null
  const { process, pid, instanceId, sequence, appVersion, ...input } = value
  if (
    !Number.isSafeInteger(pid) ||
    Number(pid) <= 0 ||
    !Number.isSafeInteger(sequence) ||
    Number(sequence) < 1 ||
    !validId(instanceId) ||
    typeof appVersion !== 'string' ||
    !/^(?:unknown|\d+\.\d+\.\d+(?:-[\w.-]+)?)$/.test(appVersion)
  )
    return null
  const parsed = validateDiagnosticInput({ ...input, source: process })
  if (!parsed) return null
  const { source, ...rest } = parsed
  return {
    ...rest,
    process: source,
    pid: pid as number,
    instanceId,
    sequence: sequence as number,
    appVersion,
  }
}

function sanitizeError(error: DiagnosticError): void {
  const message = redactDiagnosticText(error.message)
  if (message !== error.message) error.redacted = true
  if (byteLength(message) > 4093) error.truncated = true
  error.message = boundedText(message, 4093)
  error.name = boundedText(redactDiagnosticText(error.name), 128)
  if (error.originalCode)
    error.originalCode = boundedText(redactDiagnosticText(error.originalCode), 128)
  if (error.stack)
    error.stack = error.stack.map((frame) => boundedText(redactDiagnosticText(frame), 512))
  if (error.cause) sanitizeError(error.cause)
  for (const item of error.errors ?? []) sanitizeError(item)
}
