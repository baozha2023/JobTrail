import { HumanMessage, SystemMessage, type MessageContent } from '@langchain/core/messages'
import { ChatOpenAI, type ChatOpenAICompletions } from '@langchain/openai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgentModel } from '../src/main/agent/model'
import { DEFAULT_CONFIG } from '../src/main/config'

const ai = { ...DEFAULT_CONFIG.ai, modelId: 'mock', baseUrl: 'http://127.0.0.1:12345/v1' }

afterEach(() => vi.restoreAllMocks())

describe('local agent token estimates', () => {
  it('counts text and multimodal text without fetching a tokenizer', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network forbidden'))
    const model = createAgentModel(ai)
    expect(await model.getNumTokens('Hello world')).toBe(2)
    expect(await model.getNumTokens('第一轮：我偏好远程岗位')).toBe(27)
    expect(await model.getNumTokens('')).toBe(0)
    const content: MessageContent = [
      { type: 'text', text: 'Hello ' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
      { type: 'text', text: 'world' },
    ]
    expect(await model.getNumTokens(content)).toBe(2)
    expect(await model.getNumTokens('<|endoftext|>')).toBe(4)
    const messages = [new SystemMessage('Hello'), new HumanMessage('world')]
    expect(await model.getNumTokensFromMessages(messages)).toEqual({
      totalCount: 13,
      countPerMessage: [5, 5],
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps the local counter and accumulated options when deriving a model', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network forbidden'))
    const original = createAgentModel(ai, 512)
    const configured = original.withConfig({ seed: 17 }).withConfig({ stop: ['END'] })
    expect(configured).toBeInstanceOf(ChatOpenAI)
    const model = configured as ChatOpenAI
    expect(await model.getNumTokens('Hello world')).toBe(2)
    expect(model.invocationParams()).toMatchObject({ seed: 17, stop: ['END'], max_tokens: 512 })
    expect(original.invocationParams()).not.toHaveProperty('seed', 17)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('uses local estimates for streaming completions without reported usage', async () => {
    const requests: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      requests.push(url)
      if (url !== `${ai.baseUrl}/chat/completions`)
        throw new DOMException('Unexpected network request', 'AbortError')
      return new Response(
        `data: ${JSON.stringify({ id: 'local', object: 'chat.completion.chunk', model: 'mock', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello world' }, finish_reason: null }] })}\n\n` +
          `data: ${JSON.stringify({ id: 'local', object: 'chat.completion.chunk', model: 'mock', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n` +
          'data: [DONE]\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } },
      )
    })
    const model = createAgentModel(ai)
    // The wrapper delegates generation to its own completions instance.
    const completions = Reflect.get(model, 'completions') as ChatOpenAICompletions
    completions.streaming = true
    const response = await model.invoke('Hello')
    expect(response.content).toBe('Hello world')
    expect(requests).toEqual([`${ai.baseUrl}/chat/completions`])
  })
})
