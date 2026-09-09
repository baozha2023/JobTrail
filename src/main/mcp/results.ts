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
): CallToolResult {
  const structuredContent = {
    ok: false,
    error: { code, message, ...(details ? { details } : {}) },
  }
  return {
    content: [{ type: 'text', text: `${code}: ${message}` }],
    structuredContent,
    isError: true,
  }
}
