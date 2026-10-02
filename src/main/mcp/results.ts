import { captureError } from '../diagnostics'
import type { DiagnosticReference } from '../../shared/diagnostics'
import type { CallToolResult } from '@modelcontextprotocol/server'
import type { McpErrorCode } from '../../shared/types'

export function successResult(structuredContent: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
  }
}

export function errorResult(
  code: McpErrorCode,
  message: string,
  details?: Record<string, unknown>,
  diagnostic?: DiagnosticReference,
): CallToolResult {
  const structuredContent = {
    ok: false,
    error: {
      code,
      message,
      diagnostic: diagnostic ?? captureError({ code, message }, { operation: 'mcp.tool' }),
      ...(details ? { details } : {}),
    },
  }
  return {
    content: [{ type: 'text', text: `${code}: ${message}` }],
    structuredContent,
    isError: true,
  }
}
