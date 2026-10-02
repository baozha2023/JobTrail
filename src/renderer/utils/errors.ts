import type { AppErrorCode } from '../../shared/types'
import { ERROR_CODES, knownErrorCode } from '../../shared/error-codes'
import { errorField } from '../../shared/diagnostics'
import { rendererDiagnosticReference } from '../diagnostics'
type Translator = (key: string) => string
export function errorCode(error: unknown): AppErrorCode | null {
  const code = errorField(error, 'code')
  return knownErrorCode(code) && ERROR_CODES[code].ui ? (code as AppErrorCode) : null
}
export function getErrorMessage(error: unknown, translate: Translator): string {
  const code = errorCode(error)
  const text = translate(code ? ERROR_CODES[code].translationKey : 'error.generic')
  const diagnostic = rendererDiagnosticReference(error)
  return diagnostic ? `${text} [${code ?? 'INTERNAL_ERROR'} · ${diagnostic.eventId}]` : text
}
