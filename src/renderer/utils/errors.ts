import type { AppErrorCode } from '../../shared/types'

type Translator = (key: string) => string

export function errorCode(error: unknown): AppErrorCode | null {
  if (typeof error !== 'object' || error === null) return null
  const code = (error as { code?: unknown }).code
  if (typeof code !== 'string') return null
  const known: AppErrorCode[] = ['VALIDATION_ERROR', 'NOT_FOUND', 'BUILTIN_DATA', 'STATUS_IN_USE', 'LAST_STATUS', 'RESUME_IN_USE', 'COMPANY_IN_USE', 'INDUSTRY_IN_USE', 'FILE_IMPORT_FAILED', 'FILE_OPEN_FAILED', 'DATABASE_ERROR', 'INTERNAL_ERROR']
  return known.includes(code as AppErrorCode) ? code as AppErrorCode : null
}

export function getErrorMessage(error: unknown, translate: Translator): string {
  const code = errorCode(error)
  if (code) return translate(`error.${code}`)
  if (error instanceof Error) return error.message
  return translate('error.generic')
}

