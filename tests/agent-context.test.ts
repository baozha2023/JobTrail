import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentService } from '../src/main/agent/service'
import { ConfigService, type AppPaths } from '../src/main/config'
import { createServiceContainer } from '../src/main/service-container'
import type { AgentEvent } from '../src/shared/types'

describe('agent context and display history', () => {
  const roots: string[] = []
  const servers: http.Server[] = []
  let activeAgent: AgentService | null = null
  let activeContainer: ReturnType<typeof createServiceContainer> | null = null
  const externalRequests: string[] = []
  beforeEach(() => {
    const fetch = globalThis.fetch
    externalRequests.length = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (new URL(url).hostname !== '127.0.0.1') {
        externalRequests.push(url)
        throw new DOMException('External network disabled in agent context tests', 'AbortError')
      }
      return fetch(input, init)
    })
  })
  afterEach(async () => {
    try {
      if (activeAgent) await activeAgent.close()
      if (activeContainer?.database.db.open) activeContainer.database.close()
      activeAgent = null
      activeContainer = null
      await Promise.all(
        servers
          .splice(0)
          .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
      )
      roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }))
      expect(externalRequests).toEqual([])
    } finally {
      vi.restoreAllMocks()
    }
  })

  type Request = { messages: Array<{ role: string; content: string }>; max_tokens?: number }
  type Reply = {
    content?: string
    inputTokens?: number
    outputTokens?: number
    toolCalls?: unknown[]
  }
  async function fixture(reply: (request: Request, index: number) => Reply | Promise<Reply>) {
    const requests: Request[] = []
    const events: AgentEvent[] = []
    const server = http.createServer(async (request, response) => {
      let raw = ''
      for await (const chunk of request) raw += chunk.toString()
      const body = JSON.parse(raw) as Request
      requests.push(body)
      const result = await reply(body, requests.length)
      const id = `usage-${requests.length}`
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const emit = (value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`)
      emit({
        id,
        object: 'chat.completion.chunk',
        model: 'mock',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              content: result.content ?? '测试回复',
              tool_calls: result.toolCalls,
            },
            finish_reason: null,
          },
        ],
      })
      emit({
        id,
        object: 'chat.completion.chunk',
        model: 'mock',
        choices: [{ index: 0, delta: {}, finish_reason: result.toolCalls ? 'tool_calls' : 'stop' }],
      })
      if (result.inputTokens !== undefined)
        emit({
          id,
          object: 'chat.completion.chunk',
          model: 'mock',
          choices: [],
          usage: {
            prompt_tokens: result.inputTokens,
            completion_tokens: result.outputTokens ?? 20,
            total_tokens: result.inputTokens + (result.outputTokens ?? 20),
            prompt_tokens_details: { cached_tokens: Math.floor(result.inputTokens / 2) },
            completion_tokens_details: { reasoning_tokens: (result.outputTokens ?? 20) - 10 },
          },
        })
      response.end('data: [DONE]\n\n')
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('mock server failed')
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrail-context-usage-'))
    roots.push(root)
    const paths: AppPaths = {
      root,
      config: path.join(root, 'config.json'),
      data: path.join(root, 'data'),
      database: path.join(root, 'data', 'zhiji.db'),
      resumes: path.join(root, 'resumes'),
      chatUploads: path.join(root, 'chat-uploads'),
    }
    const config = new ConfigService(paths)
    config.update({
      mcp: { enabled: false },
      ai: { ...config.get().ai, baseUrl: `http://127.0.0.1:${address.port}/v1`, modelId: 'mock' },
    })
    let container = createServiceContainer(paths, false)
    const create = () =>
      new AgentService(
        paths,
        container.database.db,
        config,
        container.services,
        () => {
          throw new Error('MCP disabled')
        },
        (event) => events.push(event),
      )
    let agent = create()
    activeAgent = agent
    activeContainer = container
    return {
      get agent() {
        return agent
      },
      config,
      requests,
      events,
      async restart() {
        await agent.close()
        container.database.close()
        container = createServiceContainer(paths, false)
        agent = create()
        activeContainer = container
        activeAgent = agent
      },
    }
  }

  it('uses actual input plus retained output across restart and invalidates it on model changes', async () => {
    const f = await fixture((_request, index) =>
      index === 1 ? { inputTokens: 12000, outputTokens: 50000 } : {},
    )
    const chat = f.agent.create()
    await f.agent.send(chat.id, [{ kind: 'text', text: '你好' }], [])
    const first = (await f.agent.history(chat.id)).usage
    expect(first.contextTokens).toBeGreaterThan(12000)
    expect(first.contextTokens).toBeLessThan(12100)
    expect(first.inputTokens).toBe(12000)
    expect(first.outputTokens).toBe(50000)
    expect(first.cacheReadTokens).toBe(6000)
    expect(f.events.filter((event) => event.kind === 'usage').at(-1)?.usage).toEqual(first)
    await f.restart()
    expect((await f.agent.history(chat.id)).usage).toEqual(first)
    await f.agent.send(chat.id, [{ kind: 'text', text: '继续' }], [])
    const missing = (await f.agent.history(chat.id)).usage
    expect(missing.contextTokens).toBeGreaterThan(first.contextTokens!)
    expect(missing.contextTokens).toBeLessThan(12200)
    expect(missing.inputTokens).toBeNull()
    expect(missing.outputTokens).toBeNull()
    f.config.update({ ai: { ...f.config.get().ai, modelId: 'gpt-4o' } })
    const switched = (await f.agent.history(chat.id)).usage
    expect(switched.contextTokens).toBeNull()
    expect(switched.contextEstimated).toBe(true)
    expect(f.requests).toHaveLength(2)
  })

  it('binds a skipped compaction display to the current model after settings change', async () => {
    const f = await fixture(() => ({ inputTokens: 12000 }))
    const chat = f.agent.create()
    await f.agent.send(chat.id, [{ kind: 'text', text: '你好' }], [])
    f.config.update({ ai: { ...f.config.get().ai, modelId: 'gpt-4o' } })
    expect((await f.agent.history(chat.id)).usage.contextTokens).toBeNull()
    await f.agent.compact(chat.id)
    const history = await f.agent.history(chat.id)
    expect(history.messages.at(-1)).toMatchObject({
      role: 'compact',
      status: 'skipped',
      afterTokens: expect.any(Number),
    })
    expect(history.usage.contextTokens).toBeGreaterThan(0)
    expect(history.messages.at(-1)).toMatchObject({ afterTokens: history.usage.contextTokens })
    await f.restart()
    expect((await f.agent.history(chat.id)).usage).toEqual(history.usage)
    expect(f.requests).toHaveLength(1)
  })

  it('holds the displayed context during tool estimates and history reloads until the next response', async () => {
    let release!: (reply: Reply) => void
    const response = new Promise<Reply>((resolve) => {
      release = resolve
    })
    let requested!: () => void
    const requestStarted = new Promise<void>((resolve) => {
      requested = resolve
    })
    const f = await fixture((_request, index) =>
      index === 1
        ? {
            content: '',
            inputTokens: 7000,
            toolCalls: [
              {
                index: 0,
                id: 'ask-1',
                type: 'function',
                function: {
                  name: 'ask_user',
                  arguments: JSON.stringify({ questions: [{ question: '请提供岗位要求' }] }),
                },
              },
            ],
          }
        : (requested(), response),
    )
    const chat = f.agent.create()
    await f.agent.send(chat.id, [{ kind: 'text', text: '分析岗位' }], [])
    const pending = await f.agent.history(chat.id)
    expect(pending.pending?.kind).toBe('question')
    expect(pending.usage.contextTokens).toBeGreaterThan(7000)
    const eventCount = f.events.length
    const running = f.agent.resume(chat.id, ['数据库与中文文档处理要求。'.repeat(600)])
    await requestStarted
    try {
      expect((await f.agent.history(chat.id)).usage.contextTokens).toBe(pending.usage.contextTokens)
      expect(f.events.slice(eventCount).filter((event) => event.kind === 'usage')).toEqual([])
    } finally {
      release({ inputTokens: 9500 })
    }
    await running
    const counts = f.events
      .slice(eventCount)
      .filter((event) => event.kind === 'usage')
      .map((event) => event.usage!.contextTokens!)
    expect(new Set(counts).size).toBe(1)
    expect(counts[0]).toBeGreaterThan(9500)
    expect(
      f.requests[1].messages.some(
        (message) => message.role === 'tool' && message.content.includes('数据库'),
      ),
    ).toBe(true)
    expect((await f.agent.history(chat.id)).usage.contextTokens).toBeGreaterThan(9500)
  })

  it('keeps unavailable usage separate from context estimates and reserves output space before sending', async () => {
    const f = await fixture(() => ({}))
    f.config.update({ ai: { ...f.config.get().ai, contextWindowK: 8 } })
    const chat = f.agent.create()
    await f.agent.send(chat.id, [{ kind: 'text', text: 'hello' }], [])
    expect(f.requests[0].max_tokens).toBe(800)
    const usage = (await f.agent.history(chat.id)).usage
    expect(usage).toMatchObject({ inputTokens: null, outputTokens: null, contextEstimated: true })
    expect(usage.contextTokens).toBeGreaterThan(0)
    const firstInput = f.events.find((event) => event.kind === 'usage')!.usage!.contextTokens!
    const largeChat = f.agent.create()
    await expect(
      f.agent.send(largeChat.id, [{ kind: 'text', text: 'x '.repeat(7500 - firstInput) }], []),
    ).rejects.toThrow('输入预算')
    expect(f.requests).toHaveLength(1)
    const failed = await f.agent.history(largeChat.id)
    expect(failed.usage.contextTokens).toBeNull()
    expect(failed.messages.at(-1)?.role).toBe('user')
  })

  it('archives full history, compacts working memory, and persists reported usage', async () => {
    let reportedInput = 1200
    const requests: Array<{
      messages: Array<{ role: string; content: string }>
      stream?: boolean
    }> = []
    const server = http.createServer(async (request, response) => {
      let raw = ''
      for await (const chunk of request) raw += chunk.toString()
      const body = JSON.parse(raw) as (typeof requests)[number]
      requests.push(body)
      const summary = body.messages.some((message) =>
        String(message.content).includes('请准确压缩求职对话'),
      )
      const content = summary ? '较早对话的可靠摘要' : '测试回复'
      const id = `context-${requests.length}`
      const usage = {
        prompt_tokens: reportedInput,
        completion_tokens: 50,
        total_tokens: reportedInput + 50,
        prompt_tokens_details: { cached_tokens: 200 },
      }
      if (body.stream) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        response.write(
          `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`,
        )
        response.write(
          `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
        )
        response.write(
          `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [], usage })}\n\n`,
        )
        response.end('data: [DONE]\n\n')
      } else {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(
          JSON.stringify({
            id,
            object: 'chat.completion',
            created: 1,
            model: 'mock',
            choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
            usage,
          }),
        )
      }
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('mock server failed')
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrail-context-'))
    roots.push(root)
    const paths: AppPaths = {
      root,
      config: path.join(root, 'config.json'),
      data: path.join(root, 'data'),
      database: path.join(root, 'data', 'zhiji.db'),
      resumes: path.join(root, 'resumes'),
      chatUploads: path.join(root, 'chat-uploads'),
    }
    const config = new ConfigService(paths)
    config.update({
      mcp: { enabled: false, requireWriteConfirmation: true },
      ai: { ...config.get().ai, baseUrl: `http://127.0.0.1:${address.port}/v1`, modelId: 'mock' },
    })
    let container = createServiceContainer(paths, false)
    let agent = new AgentService(
      paths,
      container.database.db,
      config,
      container.services,
      () => {
        throw new Error('MCP disabled')
      },
      () => {},
    )
    activeContainer = container
    activeAgent = agent
    const chat = agent.create()
    await agent.send(chat.id, [{ kind: 'text', text: '第一轮：我偏好远程岗位' }], [])
    await agent.send(chat.id, [{ kind: 'text', text: '第二轮：我偏好 TypeScript' }], [])
    const beforeCompactTokens = (await agent.history(chat.id)).usage.contextTokens
    await agent.compact(chat.id)
    const afterCompact = await agent.history(chat.id)
    expect(afterCompact.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'compact',
    ])
    expect(afterCompact.usage.contextEstimated).toBe(true)
    expect(afterCompact.usage.inputTokens).toBe(3600)
    expect(afterCompact.usage.outputTokens).toBe(150)
    expect(afterCompact.usage.cacheReadTokens).toBe(600)
    expect(afterCompact.messages.at(-1)).toMatchObject({
      role: 'compact',
      beforeTokens: beforeCompactTokens,
      afterTokens: afterCompact.usage.contextTokens,
    })
    await agent.close()
    container.database.close()
    container = createServiceContainer(paths, false)
    agent = new AgentService(
      paths,
      container.database.db,
      config,
      container.services,
      () => {
        throw new Error('MCP disabled')
      },
      () => {},
    )
    activeContainer = container
    activeAgent = agent
    expect((await agent.history(chat.id)).messages).toHaveLength(5)
    expect((await agent.history(chat.id)).usage).toEqual(afterCompact.usage)
    await agent.send(chat.id, [{ kind: 'text', text: '继续讨论' }], [])
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain('较早对话的可靠摘要')
    expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain('我偏好远程岗位')
    expect((await agent.history(chat.id)).messages).toHaveLength(7)
    config.update({ ai: { ...config.get().ai, contextWindowK: 12, compactThresholdPercent: 50 } })
    reportedInput = 6500
    await agent.send(chat.id, [{ kind: 'text', text: `第一段 ${'TypeScript '.repeat(1000)}` }], [])
    await agent.send(chat.id, [{ kind: 'text', text: `第二段 ${'Electron '.repeat(1000)}` }], [])
    expect(
      (await agent.history(chat.id)).messages.filter((message) => message.role === 'compact')
        .length,
    ).toBeGreaterThan(1)
    expect((await agent.history(chat.id)).usage.contextWindowTokens).toBe(12000)
    expect((await agent.history(chat.id)).usage.contextEstimated).toBe(true)
    config.update({ ai: { ...config.get().ai, contextWindowK: 256 } })
    reportedInput = 1200
    for (let index = 0; index < 6; index++)
      await agent.send(
        chat.id,
        [{ kind: 'text', text: `批次 ${index} ${'Graph '.repeat(1600)}` }],
        [],
      )
    const requestsBeforeBatches = requests.length
    config.update({ ai: { ...config.get().ai, contextWindowK: 12 } })
    await agent.compact(chat.id)
    expect(
      requests
        .slice(requestsBeforeBatches)
        .filter((request) =>
          request.messages.some((message) =>
            String(message.content).includes('请准确压缩求职对话'),
          ),
        ).length,
    ).toBeGreaterThan(1)
    const compactCount = (await agent.history(chat.id)).messages.filter(
      (message) => message.role === 'compact',
    ).length
    config.update({ ai: { ...config.get().ai, contextWindowK: 8 } })
    await expect(
      agent.send(chat.id, [{ kind: 'text', text: `超长单轮 ${'x '.repeat(7500)}` }], []),
    ).rejects.toThrow('当前单轮内容超出上下文窗口')
    const afterFailure = await agent.history(chat.id)
    expect(afterFailure.messages.filter((message) => message.role === 'compact')).toHaveLength(
      compactCount,
    )
    expect(afterFailure.messages.at(-1)?.role).toBe('user')
    await agent.close()
    container.database.close()
  })
})
