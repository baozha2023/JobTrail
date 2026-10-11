import { createHash } from 'node:crypto'
import type { BaseMessage, SystemMessage, UsageMetadata } from '@langchain/core/messages'
import { toJsonSchema } from '@langchain/core/utils/json_schema'
import { z } from 'zod'
import type { AppConfig } from '../../shared/types'
import { contextMessage, countMessageTokens, countTextTokens } from './token-count'

export const ContextBaseline = z.object({
  key: z.string(),
  messageHashes: z.array(z.string()),
  localTokens: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  estimated: z.boolean(),
})
export type ContextBaseline = z.infer<typeof ContextBaseline>

export const ContextDisplay = z.object({
  key: z.string(),
  contextTokens: z.number().int().nonnegative(),
  contextEstimated: z.boolean(),
})

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

function requestContext(
  ai: Pick<AppConfig['ai'], 'modelId' | 'baseUrl'>,
  system: SystemMessage,
  tools: unknown[],
) {
  const definitions = tools.map((item) => {
    const tool = item as {
      name: string
      description: string
      schema?: Parameters<typeof toJsonSchema>[0]
    }
    return {
      name: tool.name,
      description: tool.description,
      schema: tool.schema ? toJsonSchema(tool.schema) : undefined,
    }
  })
  const key = hash([1, ai.baseUrl, ai.modelId, contextMessage(system), definitions])
  return { key, definitions }
}

export function contextKey(
  ai: Pick<AppConfig['ai'], 'modelId' | 'baseUrl'>,
  system: SystemMessage,
  tools: unknown[],
) {
  return requestContext(ai, system, tools).key
}

export function measureContext(
  ai: Pick<AppConfig['ai'], 'modelId' | 'baseUrl'>,
  system: SystemMessage,
  messages: BaseMessage[],
  tools: unknown[],
  baseline?: ContextBaseline | null,
) {
  const { key, definitions } = requestContext(ai, system, tools)
  const messageHashes = messages.map((message) => hash(contextMessage(message)))
  const localTokens =
    countMessageTokens(ai.modelId, [system, ...messages]).totalCount +
    (definitions.length ? countTextTokens(ai.modelId, JSON.stringify(definitions)) : 0)
  const matches =
    baseline?.key === key &&
    baseline.messageHashes.length <= messageHashes.length &&
    baseline.messageHashes.every((value, index) => value === messageHashes[index])
  // Reuse actual input only for an unchanged request prefix. Removed/replaced
  // history, a new summary, model, endpoint or tool set requires a fresh count.
  const tokens = matches
    ? baseline.inputTokens + Math.max(0, localTokens - baseline.localTokens)
    : localTokens
  return {
    tokens,
    estimated:
      !matches || baseline.estimated || baseline.messageHashes.length !== messageHashes.length,
    key,
    messageHashes,
    localTokens,
  }
}

export function createContextBaseline(
  context: ReturnType<typeof measureContext>,
  usage?: UsageMetadata,
): ContextBaseline | null {
  const inputTokens = usage?.input_tokens
  if (inputTokens === undefined || !Number.isSafeInteger(inputTokens) || inputTokens < 0)
    return null
  return {
    key: context.key,
    messageHashes: context.messageHashes,
    localTokens: context.localTokens,
    inputTokens,
    estimated: false,
  }
}

export function createCompactedContextBaseline(
  before: ReturnType<typeof measureContext>,
  after: ReturnType<typeof measureContext>,
): ContextBaseline {
  // The summary response measures the summarization request, not the new agent
  // context. Carry the current calibration through the local compression ratio
  // so a different fallback tokenizer cannot introduce a jump in accounting.
  // The next agent response replaces this projected anchor with reported usage.
  return {
    key: after.key,
    messageHashes: after.messageHashes,
    localTokens: after.localTokens,
    inputTokens: Math.round((before.tokens * after.localTokens) / before.localTokens),
    estimated: true,
  }
}

export function contextBudget(
  ai: Pick<AppConfig['ai'], 'contextWindowK' | 'compactThresholdPercent'>,
) {
  const windowTokens = ai.contextWindowK * 1000
  const outputTokens = Math.min(8192, Math.floor(windowTokens * 0.1))
  const inputTokens = windowTokens - outputTokens
  return {
    windowTokens,
    outputTokens,
    inputTokens,
    compactTokens: Math.min(
      inputTokens,
      Math.floor((windowTokens * ai.compactThresholdPercent) / 100),
    ),
  }
}
