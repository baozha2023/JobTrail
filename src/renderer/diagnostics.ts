import { faultInput } from '../shared/diagnostics'

export function reportRendererFault(operation: string, error: unknown): void {
  try {
    if (error && typeof error === 'object' && 'name' in error && error.name === 'IpcClientError')
      return
    const input = faultInput('renderer', operation, error)
    if (input) window.diagnosticsApi?.report(input)
  } catch {
    // A diagnostic failure must not recurse through the global error handler.
  }
}
