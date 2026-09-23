import type { AppErrorCode, AppErrorShape, PageQuery } from '../../shared/types'

export class AppServiceError extends Error {
  readonly name = 'AppServiceError'
  constructor(
    readonly code: AppErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
  }
}

export function assertPositiveId(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new AppServiceError('VALIDATION_ERROR', `${field}无效`)
}

export function assertFiniteInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value)) throw new AppServiceError('VALIDATION_ERROR', `${field}无效`)
}

export function assertPageQuery(query: PageQuery): void {
  assertPositiveId(query.page, '页码')
  assertPositiveId(query.pageSize, '每页数量')
  if (query.pageSize > 100) throw new AppServiceError('VALIDATION_ERROR', '每页数量不能超过 100')
  if (!Number.isSafeInteger((query.page - 1) * query.pageSize))
    throw new AppServiceError('VALIDATION_ERROR', '分页偏移量无效')
}

export function assertNonEmptyUpdate(input: object, field: string): void {
  if (!Object.values(input).some((value) => value !== undefined)) {
    throw new AppServiceError('VALIDATION_ERROR', `${field}没有可更新字段`)
  }
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
    if (/SQLITE|database/i.test(error.message))
      return new AppServiceError('DATABASE_ERROR', '数据库操作失败')
    if (/ENOENT|EACCES|EPERM|EISDIR/i.test(error.message))
      return new AppServiceError('FILE_IMPORT_FAILED', '文件操作失败')
    return new AppServiceError('INTERNAL_ERROR', error.message)
  }
  return new AppServiceError('INTERNAL_ERROR', '发生未知错误')
}

export function errorShape(error: unknown): AppErrorShape {
  const appError = toAppError(error)
  return {
    code: appError.code,
    message: appError.message,
    ...(appError.details ? { details: appError.details } : {}),
  }
}
