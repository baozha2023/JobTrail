import { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import type { ConfigService } from '../config'
import { MCP_TOOLS } from '../mcp-contracts'
import type { Services } from '../service-container'
import { errorShape } from '../services/errors'
import type { UnitOfWork } from '../services/unit-of-work'
import { McpMutationCoordinator } from './mutation-coordinator'
import { errorResult, successResult } from './results'

export interface McpServerDependencies {
  version: string
  unitOfWork: UnitOfWork
  services: Services
  config: ConfigService
}

export function createJobTrailMcpServer(dependencies: McpServerDependencies): McpServer {
  const coordinator = new McpMutationCoordinator(
    dependencies.unitOfWork,
    dependencies.services,
    dependencies.config,
  )
  const server = new McpServer(
    { name: 'jobtrail', version: dependencies.version },
    {
      instructions:
        'Use read tools freely. Write tools may require an explicit user confirmation after showing a JobTrail change preview. Never claim a write succeeded unless the tool returns the changed record.',
      inputRequired: { legacyShim: true, maxRounds: 8, roundTimeoutMs: 600_000 },
      requestState: { verify: coordinator.verifyRequestState },
    },
  )

  for (const descriptor of MCP_TOOLS) {
    const inputSchema = descriptor.inputSchema as z.ZodType<Record<string, unknown>>
    const outputSchema = descriptor.outputSchema as z.ZodType<Record<string, unknown>>
    server.registerTool(
      descriptor.name,
      {
        title: descriptor.title,
        description: descriptor.description,
        inputSchema,
        outputSchema,
        annotations: {
          title: descriptor.title,
          readOnlyHint: descriptor.readOnly,
          destructiveHint: descriptor.destructive,
          idempotentHint: descriptor.idempotent,
          openWorldHint: false,
        },
      },
      async (args, ctx) => {
        try {
          const config = dependencies.config.reload()
          if (!config.mcp.enabled) {
            return errorResult('MCP_DISABLED', 'JobTrail MCP is disabled in application settings.')
          }
          if (descriptor.readOnly)
            return successResult(descriptor.execute(dependencies.services, args))

          if (config.mcp.requireWriteConfirmation) {
            const version = server.server.getNegotiatedProtocolVersion()
            const capabilities = server.server.getClientCapabilities() as
              | { elicitation?: unknown }
              | undefined
            if (version && !version.startsWith('2026-') && !capabilities?.elicitation) {
              return errorResult(
                'CONFIRMATION_UNSUPPORTED',
                'This MCP host does not support the confirmation required for JobTrail writes.',
              )
            }
          }
          return await coordinator.handle(
            descriptor,
            args,
            ctx,
            config.mcp.requireWriteConfirmation,
          )
        } catch (error) {
          const normalized = errorShape(error)
          if (normalized.code === 'INTERNAL_ERROR') console.error('JobTrail MCP tool failed', error)
          const message =
            normalized.code === 'INTERNAL_ERROR'
              ? 'JobTrail MCP encountered an internal error.'
              : normalized.message
          return errorResult(normalized.code, message, normalized.details)
        }
      },
    )
  }

  return server
}
