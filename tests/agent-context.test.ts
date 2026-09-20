import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentService } from '../src/main/agent/service'
import { ConfigService, type AppPaths } from '../src/main/config'
import { createServiceContainer } from '../src/main/service-container'

describe('agent context and display history', () => {
  const roots: string[] = []
  const servers: http.Server[] = []
  let activeAgent: AgentService | null = null
  let activeContainer: ReturnType<typeof createServiceContainer> | null = null
  afterEach(async () => {
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
  })

  it('archives full history, compacts working memory, and persists reported usage', async () => {
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
        prompt_tokens: 1200,
        completion_tokens: 50,
        total_tokens: 1250,
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
    await agent.send(chat.id, [{ kind: 'text', text: '继续讨论' }], [])
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain('较早对话的可靠摘要')
    expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain('我偏好远程岗位')
    expect((await agent.history(chat.id)).messages).toHaveLength(7)
    config.update({ ai: { ...config.get().ai, contextWindowK: 12, compactThresholdPercent: 50 } })
    await agent.send(chat.id, [{ kind: 'text', text: `第一段 ${'TypeScript '.repeat(1000)}` }], [])
    await agent.send(chat.id, [{ kind: 'text', text: `第二段 ${'Electron '.repeat(1000)}` }], [])
    expect(
      (await agent.history(chat.id)).messages.filter((message) => message.role === 'compact')
        .length,
    ).toBeGreaterThan(1)
    expect((await agent.history(chat.id)).usage.contextWindowTokens).toBe(12000)
    expect((await agent.history(chat.id)).usage.contextEstimated).toBe(false)
    config.update({ ai: { ...config.get().ai, contextWindowK: 256 } })
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
      agent.send(chat.id, [{ kind: 'text', text: `超长单轮 ${'TypeScript '.repeat(2500)}` }], []),
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
