import { ChatOpenAI, type ChatOpenAICallOptions, type ChatOpenAIFields } from '@langchain/openai'
import type { MessageContent } from '@langchain/core/messages'
import { Tiktoken } from 'js-tiktoken/lite'
import gpt2 from 'js-tiktoken/ranks/gpt2'
import type { AppConfig } from '../../shared/types'
import { AppServiceError } from '../services/errors'

let encoding: Tiktoken | undefined

async function countTokens(content: MessageContent): Promise<number> {
  const text =
    typeof content === 'string'
      ? content
      : content
          .map((part) => {
            if (typeof part === 'string') return part
            return part.type === 'text' && 'text' in part ? part.text : ''
          })
          .join('')
  // Keep the installed ChatOpenAI counter's GPT-2 estimate, without its CDN download.
  encoding ??= new Tiktoken(gpt2)
  try {
    return encoding.encode(text).length
  } catch {
    // Literal special-token markers use the same estimate as LangChain's counter.
    return Math.ceil(text.length / 4)
  }
}

class LocalTokenChatOpenAI extends ChatOpenAI {
  constructor(fields?: ChatOpenAIFields) {
    super(fields)
    this.completions.getNumTokens = countTokens
    this.responses.getNumTokens = countTokens
  }

  override getNumTokens = countTokens

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
