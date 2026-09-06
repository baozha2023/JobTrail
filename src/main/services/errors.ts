import type { AppErrorCode, AppErrorShape } from '../../shared/types'

export class AppServiceError extends Error {
  readonly name = 'AppServiceError'
  constructor(readonly code: AppErrorCode, message: string, readonly details?: Record<string, unknown>) {
    super(message)
  }
}

export function assertPositiveId(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new AppServiceError('VALIDATION_ERROR', `${field}无效`)
}

export function assertFiniteInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value)) throw new AppServiceError('VALIDATION_ERROR', `${field}无效`)
}

export function nullableText(value: string | null | undefined): string | null {
  return value === null || value === undefined || value.trim() === '' ? null : value.trim()
}

export function uniqueError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('UNIQUE')
}

export function toAppError(error: unknown): AppServiceError {
  if (error instanceof AppServiceError) return error
  if (error instanceof Error) {
    if (/SQLITE|database/i.test(error.message)) return new AppServiceError('DATABASE_ERROR', '数据库操作失败')
    if (/ENOENT|EACCES|EPERM|EISDIR/i.test(error.message)) return new AppServiceError('FILE_IMPORT_FAILED', '文件操作失败')
    return new AppServiceError('INTERNAL_ERROR', error.message)
  }
  return new AppServiceError('INTERNAL_ERROR', '发生未知错误')
}

export function errorShape(error: unknown): AppErrorShape {
  const appError = toAppError(error)
  return { code: appError.code, message: appError.message, ...(appError.details ? { details: appError.details } : {}) }
}
