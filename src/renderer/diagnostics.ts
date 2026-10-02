import {
  createErrorInput,
  diagnosticReference,
  type DiagnosticReference,
} from '../shared/diagnostics'
const localReferences = new WeakMap<object, DiagnosticReference>()
export function rendererDiagnosticReference(error: unknown): DiagnosticReference | undefined {
  return (
    diagnosticReference(error) ??
    (error && typeof error === 'object' ? localReferences.get(error) : undefined)
  )
}
export function reportRendererFault(operation: string, error: unknown): DiagnosticReference {
  const previous = diagnosticReference(error)
  if (previous) return previous
  const input = createErrorInput('renderer', operation, error)
  const reference = { eventId: input.eventId, traceId: input.traceId, spanId: input.spanId }
  if (error && typeof error === 'object') localReferences.set(error, reference)
  try {
    const sending = window.diagnosticsApi?.report(input)
    if (sending)
      void sending.catch(() => console.error(JSON.stringify({ ...input, transportDegraded: true })))
    else console.error(JSON.stringify({ ...input, transportDegraded: true }))
  } catch {
    console.error(JSON.stringify({ ...input, transportDegraded: true }))
  }
  return reference
}
