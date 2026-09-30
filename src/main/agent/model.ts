import { ChatOpenAI } from '@langchain/openai'
import type { AppConfig } from '../../shared/types'
import { AppServiceError } from '../services/errors'
export function createAgentModel(ai: AppConfig['ai'], maxTokens?: number): ChatOpenAI {
  if (!ai.modelId) throw new AppServiceError('VALIDATION_ERROR', '请先在设置中填写 AI 模型 ID')
  const endpoint = new URL(ai.baseUrl)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname) && !ai.apiKey.trim())
    throw new AppServiceError('AI_API_KEY_EMPTY', '当前 API Key 为空')
  return new ChatOpenAI({
    model: ai.modelId,
    apiKey: ai.apiKey || 'local',
    useResponsesApi: false,
    streamUsage: true,
    maxTokens,
    configuration: { baseURL: ai.baseUrl },
  })
}
