import { ChatOpenAI, type ChatOpenAICallOptions, type ChatOpenAIFields } from '@langchain/openai'
import type { BaseMessage, MessageContent } from '@langchain/core/messages'
import type { AppConfig } from '../../shared/types'
import { AppServiceError } from '../services/errors'
import { countMessageTokens, countTextTokens } from './token-count'

class LocalTokenChatOpenAI extends ChatOpenAI {
  constructor(fields?: ChatOpenAIFields) {
    super(fields)
    this.completions.getNumTokens = this.getNumTokens
    this.responses.getNumTokens = this.getNumTokens
    this.completions.getNumTokensFromMessages = this.getNumTokensFromMessages
    this.responses.getNumTokensFromMessages = this.getNumTokensFromMessages
  }

  override getNumTokens = async (content: MessageContent) => countTextTokens(this.model, content)
  override getNumTokensFromMessages = async (messages: BaseMessage[]) =>
    countMessageTokens(this.model, messages)

  override withConfig(config: Partial<ChatOpenAICallOptions>): LocalTokenChatOpenAI {
    // ChatOpenAI.withConfig constructs a base instance and would lose the local counter.
    const model = new LocalTokenChatOpenAI(this.fields)
    model.defaultOptions = { ...this.defaultOptions, ...config }
    return model
  }
}

export function createAgentModel(ai: AppConfig['ai'], maxTokens?: number): ChatOpenAI {
  if (!ai.modelId) throw new AppServiceError('VALIDATION_ERROR', '请先在设置中填写 AI 模型 ID')
  const endpoint = new URL(ai.baseUrl)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname) && !ai.apiKey.trim())
    throw new AppServiceError('AI_API_KEY_EMPTY', '当前 API Key 为空')
  return new LocalTokenChatOpenAI({
    model: ai.modelId,
    apiKey: ai.apiKey || 'local',
    useResponsesApi: false,
    streamUsage: true,
    maxTokens,
    configuration: { baseURL: ai.baseUrl },
  })
}
