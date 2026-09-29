export type FaultProcess = 'main' | 'renderer' | 'preload' | 'agent' | 'mcp'

export interface FaultInput {
  source: FaultProcess
  operation: string
  code: string
  httpStatus?: number
  systemCode?: string
  stack?: string[]
}

export interface FaultRecord extends Omit<FaultInput, 'source'> {
  timestamp: string
  process: FaultProcess
  pid: number
  appVersion: string
}

const expectedCodes = new Set([
  'VALIDATION_ERROR',
  'BACKUP_SOURCE_INVALID',
  'BACKUP_INVALID',
  'BACKUP_VERSION_UNSUPPORTED',
  'NOT_FOUND',
  'BUILTIN_DATA',
  'STATUS_IN_USE',
  'LAST_STATUS',
  'RESUME_IN_USE',
  'COMPANY_IN_USE',
  'INDUSTRY_IN_USE',
  'CATALOG_CONFLICT',
  'CATALOG_VERSION_ROLLBACK',
  'CATALOG_APP_UPDATE_REQUIRED',
  'CATALOG_UPDATE_IN_PROGRESS',
  'WEB_INVALID_URL',
  'WEB_BLOCKED',
  'WEB_CANCELLED',
  'WEB_UNSUPPORTED',
  'WEB_TOO_LARGE',
  'WEB_INVALID_CURSOR',
  'WEB_CURSOR_EXPIRED',
  'AGENT_CANCELLED',
  'MCP_DISABLED',
  'CONFIRMATION_REQUIRED',
  'CONFIRMATION_UNSUPPORTED',
])

const faultCodes = new Set([
  'BACKUP_FAILED',
  'FILE_IMPORT_FAILED',
  'FILE_OPEN_FAILED',
  'DATABASE_ERROR',
  'CATALOG_DOWNLOAD_FAILED',
  'CATALOG_ASSET_MISSING',
  'CATALOG_TOO_LARGE',
  'CATALOG_HASH_MISMATCH',
  'CATALOG_INVALID',
  'WEB_TIMEOUT',
  'WEB_UNAVAILABLE',
  'WEB_PARSE_FAILED',
  'INTERNAL_ERROR',
  'CONFIG_INVALID',
  'CONFIG_VERSION_UNSUPPORTED',
  'DATABASE_VERSION_UNSUPPORTED',
  'AGENT_WORKER_UNAVAILABLE',
  'AGENT_WORKER_EXITED',
  'AGENT_WORKER_START_FAILED',
  'SYSTEM_ERROR',
  'PROCESS_EXITED',
  'PROCESS_ERROR',
  'UPDATE_VERIFY_FAILED',
])

const forwardedOperations = new Set([
  'agent.bootstrap',
  'agent.initialize',
  'agent.run',
  'agent.pdf-text',
  'agent.pdf-render',
  'agent.doc-text',
  'agent.docx-visuals',
  'agent.attachment-read',
  'agent.attachment-cleanup',
  'agent.conversation-cleanup',
  'agent.conversation-recover',
  'agent.cancel-checkpoint',
  'mcp.bootstrap',
  'mcp.initialize',
  'mcp.transport-close',
  'mcp.web-close',
  'mcp.database-close',
  'mcp.lease-cleanup',
  'mcp.protocol',
  'mcp.tool',
  'mcp.connect',
  'mcp.connect-cleanup',
  'process.uncaught',
  'process.unhandled-rejection',
  'database.post-commit',
  'file.recycle-cleanup',
  'web.cache-update',
])

const systemCodes = new Set([
  'EACCES',
  'EADDRINUSE',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EEXIST',
  'EHOSTUNREACH',
  'EIO',
  'EISDIR',
  'EMFILE',
  'ENETUNREACH',
  'ENOENT',
  'ENOSPC',
  'ENOTDIR',
  'EPERM',
  'EPIPE',
  'ETIMEDOUT',
])

export function isExpectedFault(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = (error as { code?: unknown }).code
  if (typeof code === 'string' && expectedCodes.has(code)) return true
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'CanceledError')
}

export function safeStack(stack: unknown): string[] | undefined {
  if (typeof stack !== 'string' || stack.length > 16_384) return undefined
  const frames: string[] = []
  for (const line of stack.split('\n').slice(1, 12)) {
    if (line.length > 500) continue
    const match = line
      .replaceAll('\\', '/')
      .match(
        /(?:^|[/ (])((?:src|out)\/(?:main|preload|renderer)\/[A-Za-z0-9_./-]+\.(?:ts|js|vue)):(\d{1,7}):(\d{1,5})(?:\)|$)/,
      )
    if (!match || match[1].length > 120 || match[1].includes('..')) continue
    frames.push(`${match[1]}:${match[2]}:${match[3]}`)
    if (frames.length === 5) break
  }
  return frames.length ? frames : undefined
}

export function faultInput(
  source: FaultProcess,
  operation: string,
  error: unknown,
): FaultInput | null {
  if (isExpectedFault(error)) return null
  const candidate =
    error && typeof error === 'object'
      ? (error as {
          code?: unknown
          status?: unknown
          statusCode?: unknown
          message?: unknown
          stack?: unknown
        })
      : {}
  const appCode =
    typeof candidate.code === 'string' && faultCodes.has(candidate.code)
      ? candidate.code
      : error instanceof Error && error.name === 'DatabaseVersionError'
        ? 'DATABASE_VERSION_UNSUPPORTED'
        : 'INTERNAL_ERROR'
  const systemCode =
    typeof candidate.code === 'string' && systemCodes.has(candidate.code)
      ? candidate.code
      : undefined
  const message = typeof candidate.message === 'string' ? candidate.message.slice(0, 2048) : ''
  const status =
    Number(candidate.status ?? candidate.statusCode) ||
    Number(
      /(?:http\s+(?:status|error)|status(?:\s+code)?)\s*[:=]?\s*([1-5]\d\d)/i.exec(message)?.[1],
    )
  const httpStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined
  const stack = safeStack(candidate.stack)
  return {
    source,
    operation,
    code: systemCode ? 'SYSTEM_ERROR' : appCode,
    ...(httpStatus ? { httpStatus } : {}),
    ...(systemCode ? { systemCode } : {}),
    ...(stack ? { stack } : {}),
  }
}

export function validateFaultInput(value: unknown): FaultInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  if (
    Object.keys(input).some(
      (key) => !['source', 'operation', 'code', 'httpStatus', 'systemCode', 'stack'].includes(key),
    )
  )
    return null
  if (input.source !== 'renderer' && input.source !== 'preload') return null
  if (typeof input.operation !== 'string' || !/^[a-z][a-z0-9.-]{0,63}$/.test(input.operation))
    return null
  if (typeof input.code !== 'string' || !faultCodes.has(input.code)) return null
  if (
    input.httpStatus !== undefined &&
    (!Number.isInteger(input.httpStatus) ||
      (input.httpStatus as number) < 100 ||
      (input.httpStatus as number) > 599)
  )
    return null
  if (
    input.systemCode !== undefined &&
    (typeof input.systemCode !== 'string' || !systemCodes.has(input.systemCode))
  )
    return null
  if (
    input.stack !== undefined &&
    (!Array.isArray(input.stack) ||
      input.stack.length > 5 ||
      input.stack.some(
        (frame) =>
          typeof frame !== 'string' ||
          frame.length > 180 ||
          !/^(?:src|out)\/(?:main|preload|renderer)\/[A-Za-z0-9_./-]+\.(?:ts|js|vue):\d{1,7}:\d{1,5}$/.test(
            frame,
          ) ||
          frame.includes('..'),
      ))
  )
    return null
  return input as unknown as FaultInput
}

export function faultRecord(
  input: FaultInput,
  pid: number,
  appVersion: string,
  now = new Date(),
): FaultRecord {
  return {
    timestamp: now.toISOString(),
    process: input.source,
    pid,
    appVersion: /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.-]{1,20})?$/.test(appVersion)
      ? appVersion
      : 'unknown',
    operation: /^[a-z][a-z0-9.-]{0,63}$/.test(input.operation)
      ? input.operation
      : 'process.unknown',
    code:
      faultCodes.has(input.code) || expectedCodes.has(input.code) ? input.code : 'INTERNAL_ERROR',
    ...(input.httpStatus ? { httpStatus: input.httpStatus } : {}),
    ...(input.systemCode ? { systemCode: input.systemCode } : {}),
    ...(input.stack?.length ? { stack: input.stack } : {}),
  }
}

export function validateForwardedFaultRecord(value: unknown): FaultRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).some(
      (key) =>
        ![
          'timestamp',
          'process',
          'pid',
          'appVersion',
          'operation',
          'code',
          'httpStatus',
          'systemCode',
          'stack',
        ].includes(key),
    )
  )
    return null
  if (record.process !== 'agent' && record.process !== 'mcp') return null
  if (typeof record.operation !== 'string' || !forwardedOperations.has(record.operation))
    return null
  if (
    typeof record.timestamp !== 'string' ||
    record.timestamp.length !== 24 ||
    !Number.isFinite(Date.parse(record.timestamp)) ||
    new Date(record.timestamp).toISOString() !== record.timestamp
  )
    return null
  if (!Number.isSafeInteger(record.pid) || (record.pid as number) <= 0) return null
  if (
    record.appVersion !== 'unknown' &&
    (typeof record.appVersion !== 'string' ||
      !/^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.-]{1,20})?$/.test(record.appVersion))
  )
    return null
  const fields = validateFaultInput({
    source: 'preload',
    operation: record.operation,
    code: record.code,
    ...(record.httpStatus === undefined ? {} : { httpStatus: record.httpStatus }),
    ...(record.systemCode === undefined ? {} : { systemCode: record.systemCode }),
    ...(record.stack === undefined ? {} : { stack: record.stack }),
  })
  if (!fields) return null
  return {
    timestamp: record.timestamp,
    process: record.process,
    pid: record.pid as number,
    appVersion: record.appVersion as string,
    operation: fields.operation,
    code: fields.code,
    ...(fields.httpStatus ? { httpStatus: fields.httpStatus } : {}),
    ...(fields.systemCode ? { systemCode: fields.systemCode } : {}),
    ...(fields.stack ? { stack: fields.stack } : {}),
  }
}
