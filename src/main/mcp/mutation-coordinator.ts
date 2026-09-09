import crypto from 'node:crypto'
import type { ServerContext } from '@modelcontextprotocol/server'
import {
  createRequestStateCodec,
  inputRequired,
  inputResponse,
  type CallToolResult,
  type InputRequiredResult,
} from '@modelcontextprotocol/server'
import type { Locale } from '../../shared/types'
import type { ConfigService } from '../config'
import type { McpMutationPreview, McpWriteToolDescriptor } from '../mcp-contracts'
import type { Services } from '../service-container'
import type { UnitOfWork } from '../services/unit-of-work'
import { errorResult, successResult } from './results'

interface ConfirmationState {
  toolName: string
  argumentsFingerprint: string
  previewFingerprint: string
}

interface McpChangePreview extends McpMutationPreview {
  action: string
  warnings: string[]
}

interface PreparedChange {
  preview: McpChangePreview
  stateFingerprint: string
}

type MutationOutcome =
  | { kind: 'success'; value: Record<string, unknown> }
  | { kind: 'stale'; change: PreparedChange }

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    )
  }
  return value
}

function fingerprint(value: unknown): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex')
}

export class McpMutationCoordinator {
  private readonly stateCodec = createRequestStateCodec<ConfirmationState>({
    key: crypto.randomBytes(32),
    ttlSeconds: 600,
    bind: (ctx) => ctx.mcpReq.method,
  })

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly services: Services,
    private readonly config: ConfigService,
  ) {}

  get verifyRequestState() {
    return this.stateCodec.verify
  }

  async handle(
    descriptor: McpWriteToolDescriptor,
    args: Record<string, unknown>,
    ctx: ServerContext,
    requireWriteConfirmation: boolean,
  ): Promise<CallToolResult | InputRequiredResult> {
    if (!requireWriteConfirmation) {
      return successResult(descriptor.execute(this.services, args))
    }

    const change = this.prepare(descriptor, args)
    const argsFingerprint = fingerprint(args)
    const state = ctx.mcpReq.requestState<ConfirmationState>()
    const response = inputResponse(ctx.mcpReq.inputResponses, 'confirm')

    if (!state) return this.requestConfirmation(descriptor, argsFingerprint, change, ctx)
    if (state.toolName !== descriptor.name || state.argumentsFingerprint !== argsFingerprint) {
      return errorResult('CONFIRMATION_REQUIRED', '确认状态与当前操作不匹配')
    }
    if (
      response.kind === 'elicit' &&
      (response.action === 'decline' || response.action === 'cancel')
    ) {
      return this.cancelled(change.preview)
    }
    if (response.kind !== 'elicit' || response.action !== 'accept') {
      return this.requestConfirmation(descriptor, argsFingerprint, change, ctx)
    }

    const outcome = this.unitOfWork.run((): MutationOutcome => {
      const latest = this.prepare(descriptor, args)
      if (latest.stateFingerprint !== state.previewFingerprint) {
        return { kind: 'stale', change: latest }
      }
      return { kind: 'success', value: descriptor.execute(this.services, args) }
    })
    if (outcome.kind === 'stale') {
      return this.requestConfirmation(descriptor, argsFingerprint, outcome.change, ctx)
    }
    return successResult(outcome.value)
  }

  private prepare(
    descriptor: McpWriteToolDescriptor,
    args: Record<string, unknown>,
  ): PreparedChange {
    const mutation = descriptor.preview(this.services, args)
    const action = descriptor.name.split('_')[0]
    const warnings = descriptor.destructive
      ? ['This operation permanently deletes data and cannot be undone.']
      : []
    const preview = { action, ...mutation, warnings }
    return {
      preview,
      stateFingerprint: fingerprint({ toolName: descriptor.name, ...mutation }),
    }
  }

  private async requestConfirmation(
    descriptor: McpWriteToolDescriptor,
    argumentsFingerprint: string,
    change: PreparedChange,
    ctx: ServerContext,
  ): Promise<InputRequiredResult> {
    const requestState = await this.stateCodec.mint(
      {
        toolName: descriptor.name,
        argumentsFingerprint,
        previewFingerprint: change.stateFingerprint,
      },
      ctx,
    )
    const locale = this.config.get().locale
    return inputRequired({
      requestState,
      inputRequests: {
        confirm: inputRequired.elicit({
          message: this.confirmationMessage(locale, descriptor.title, change.preview),
          requestedSchema: {
            type: 'object',
            properties: {},
          },
        }),
      },
    })
  }

  private confirmationMessage(locale: Locale, title: string, preview: McpChangePreview): string {
    const heading = locale === 'zh-CN' ? `请确认：${title}` : `Confirm: ${title}`
    return `${heading}\n${JSON.stringify(preview, null, 2)}`
  }

  private cancelled(preview: McpChangePreview): CallToolResult {
    const structuredContent = { cancelled: true, preview }
    return {
      content: [{ type: 'text', text: 'Operation cancelled; no data was changed.' }],
      structuredContent,
      isError: true,
    }
  }
}
