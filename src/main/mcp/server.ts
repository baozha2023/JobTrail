import { validDiagnosticContext, newDiagnosticContext } from '../../shared/diagnostics'
import { featureErrors } from '../../shared/feature-errors'
import { McpServer, type StandardSchemaWithJSON } from '@modelcontextprotocol/server'
import { captureError, withDiagnosticContext, runOperation } from '../diagnostics'
import { z } from 'zod'
import type { ConfigService } from '../config'
import { MCP_TOOLS } from '../mcp-contracts'
import type { Services } from '../service-container'
import { errorShape } from '../services/errors'
import type { UnitOfWork } from '../services/unit-of-work'
import { McpMutationCoordinator } from './mutation-coordinator'
import { errorResult, successResult } from './results'

function observedSchema(
  schema: z.ZodType<Record<string, unknown>>,
  operation: string,
  input: boolean,
): StandardSchemaWithJSON<unknown, Record<string, unknown>> {
  return {
    '~standard': {
      ...schema['~standard'],
      async validate(value) {
        const result = await schema.safeParseAsync(value)
        if (result.success) return { value: result.data }
        const code = input ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR'
        const diagnostic = captureError(
          {
            code,
            message: input ? 'MCP input validation failed' : 'MCP output validation failed',
            cause: result.error,
          },
          { operation },
        )
        // SDK-generated isError results must not echo input values or bypass diagnostics.
        return { issues: [{ message: `${code} [${diagnostic.eventId}]` }] }
      },
    },
  }
}

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
        'Use local read tools freely. Web reads may execute allowlisted same-origin JSON POST queries whose server-side effects cannot be proven absent. They retry transient network failures once and report errors or incompleteReason; do not repeat exhausted requests or treat extraction failure as no jobs. Tell the user when public web content cannot be verified. Local write tools may require an explicit user confirmation after showing a JobTrail change preview. Never claim a write succeeded unless the tool returns the changed record.',
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
        inputSchema: observedSchema(inputSchema, 'mcp.validate-input', true),
        outputSchema: observedSchema(outputSchema, 'mcp.validate-output', false),
        annotations: {
          title: descriptor.title,
          readOnlyHint: descriptor.readOnlyHint ?? descriptor.readOnly,
          destructiveHint: descriptor.destructive,
          idempotentHint: descriptor.idempotent,
          openWorldHint: descriptor.openWorld,
        },
      },
      async (args, ctx) => {
        const incoming = ctx.mcpReq._meta?.['jobtrail/diagnostics']
        const context = validDiagnosticContext(incoming) ? incoming : newDiagnosticContext()
        return withDiagnosticContext(context, () =>
          runOperation(
            { operation: 'mcp.tool.' + descriptor.name.replaceAll('_', '-') },
            async () => {
              try {
                const config = dependencies.config.reload()
                if (!config.mcp.enabled) {
                  return errorResult(
                    'MCP_DISABLED',
                    'JobTrail MCP is disabled in application settings.',
                  )
                }
                if (descriptor.readOnly)
                  return successResult(
                    await descriptor.execute(dependencies.services, args, ctx.mcpReq.signal),
                  )

                if (config.mcp.requireWriteConfirmation && descriptor.confirmation !== 'never') {
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
                  config.mcp.requireWriteConfirmation && descriptor.confirmation !== 'never',
                )
              } catch (error) {
                const normalized = errorShape(error)
                const diagnostic = captureError(error, { operation: 'mcp.tool' })
                const localized = featureErrors[dependencies.config.get().locale]
                const message =
                  normalized.code in localized
                    ? localized[normalized.code as keyof typeof localized]
                    : normalized.code === 'INTERNAL_ERROR'
                      ? 'JobTrail MCP encountered an internal error.'
                      : normalized.message
                return errorResult(normalized.code, message, normalized.details, diagnostic)
              }
            },
          ),
        )
      },
    )
  }

  return server
}
