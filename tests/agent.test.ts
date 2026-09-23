import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentService } from '../src/main/agent/service'
import { ConfigService, type AppPaths } from '../src/main/config'
import { createServiceContainer } from '../src/main/service-container'
import type { AgentEvent } from '../src/shared/types'

describe('built-in LangGraph agent', () => {
  const roots: string[] = []
  const servers: http.Server[] = []
  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    )
    roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }))
  })

  it('persists multi-turn messages and managed attachments in the same SQLite database', async () => {
    const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = []
    let thirdRequestStarted!: () => void
    const thirdRequest = new Promise<void>((resolve) => {
      thirdRequestStarted = resolve
    })
    const server = http.createServer(async (request, response) => {
      let body = ''
      for await (const chunk of request) body += chunk.toString()
      requests.push(JSON.parse(body) as { messages: Array<{ role: string; content: unknown }> })
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const id = `test-${requests.length}`
      response.write(
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta: { role: 'assistant', content: requests.length === 3 ? '部分回复' : '测试回复' }, finish_reason: null }] })}\n\n`,
      )
      if (requests.length === 3) {
        thirdRequestStarted()
        await new Promise((resolve) => setTimeout(resolve, 500))
        if (response.destroyed) return
      }
      response.write(
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
      )
      response.end('data: [DONE]\n\n')
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('mock server failed')

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrail-agent-'))
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
      ai: {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        modelId: 'mock',
        apiKey: '',
        multimodal: false,
        contextWindowK: 256,
        compactThresholdPercent: 80,
      },
    })
    let container = createServiceContainer(paths, false)
    const events: AgentEvent[] = []
    let agent = new AgentService(
      paths,
      container.database.db,
      config,
      container.services,
      () => {
        throw new Error('MCP must be disabled')
      },
      (event) => events.push(event),
    )
    expect(() =>
      agent.saveSettings({
        baseUrl: 'https://api.example.com/v1',
        modelId: 'remote-model',
        apiKey: '',
        multimodal: false,
        contextWindowK: 256,
        compactThresholdPercent: 80,
      }),
    ).toThrow('API Key')
    expect(config.get().ai.modelId).toBe('mock')
    const conversation = agent.create()
    const source = path.join(root, 'notes.txt')
    fs.writeFileSync(source, '岗位要求：TypeScript。')
    const attachment = agent.upload(conversation.id, source)
    expect(fs.existsSync(path.join(paths.chatUploads, `${attachment.id}.txt`))).toBe(true)
    expect(agent.getAttachmentPath(conversation.id, attachment.id)).toBe(
      path.join(paths.chatUploads, `${attachment.id}.txt`),
    )
    const imagePath = path.join(root, 'screenshot.png')
    fs.writeFileSync(
      imagePath,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lxoAAAAASUVORK5CYII=',
        'base64',
      ),
    )
    expect(() => agent.upload(conversation.id, imagePath)).toThrow('多模态')
    config.update({
      ai: {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        modelId: 'mock',
        apiKey: '',
        multimodal: true,
        contextWindowK: 256,
        compactThresholdPercent: 80,
      },
    })
    const image = agent.upload(conversation.id, imagePath)
    expect(image.mimeType).toBe('image/png')
    const pasted = agent.uploadBytes(
      conversation.id,
      'clipboard.png',
      'image/png',
      new Uint8Array(fs.readFileSync(imagePath)),
    )
    expect(agent.preview(conversation.id, pasted.id)).toMatch(/^data:image\/png;base64,/)
    expect(() =>
      agent.uploadBytes(conversation.id, 'fake.png', 'image/png', new Uint8Array([1, 2, 3])),
    ).toThrow('附件内容与类型不匹配')
    expect(() =>
      agent.uploadBytes(
        conversation.id,
        `${'a'.repeat(252)}.txt`,
        'text/plain',
        new TextEncoder().encode('test'),
      ),
    ).toThrow('附件名称无效')
    await agent.removeUpload(conversation.id, pasted.id)
    expect(fs.existsSync(path.join(paths.chatUploads, `${pasted.id}.png`))).toBe(false)
    await expect(
      agent.send(conversation.id, [{ kind: 'resume', id: 7, name: '伪造简历' }], []),
    ).rejects.toThrow('MCP 连接已关闭')
    await expect(
      agent.send(conversation.id, [{ kind: 'text', text: '重复附件' }], [image.id, image.id]),
    ).rejects.toThrow('消息附件格式无效')
    await agent.send(conversation.id, [{ kind: 'text', text: '请阅读附件' }], [attachment.id])
    await expect(agent.removeUpload(conversation.id, attachment.id)).rejects.toThrow(
      '已发送的附件不能移除',
    )
    const first = await agent.history(conversation.id)
    expect(first.usage.cacheReadTokens).toBeNull()
    expect(first.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    if (first.messages[0].role === 'user')
      expect(first.messages[0].parts).toEqual([{ kind: 'text', text: '请阅读附件' }])
    expect(first.messages[0].attachments[0].id).toBe(attachment.id)
    expect(events.some((event) => event.kind === 'done')).toBe(true)
    expect(
      events
        .filter((event) => event.kind === 'token')
        .map((event) => event.text)
        .join(''),
    ).toContain('测试回复')
    expect(JSON.stringify(requests[0])).toContain('岗位要求：TypeScript。')
    expect(JSON.stringify(requests[0])).not.toContain('jobtrailParts')
    await agent.close()
    container.database.close()

    container = createServiceContainer(paths, false)
    agent = new AgentService(
      paths,
      container.database.db,
      config,
      container.services,
      () => {
        throw new Error('MCP must be disabled')
      },
      (event) => events.push(event),
    )
    expect((await agent.history(conversation.id)).messages).toHaveLength(2)
    await agent.send(conversation.id, [{ kind: 'text', text: '继续' }], [])
    expect((await agent.history(conversation.id)).messages).toHaveLength(4)
    expect(requests[1].messages.some((message) => message.role === 'assistant')).toBe(true)
    const cancelled = agent.send(conversation.id, [{ kind: 'text', text: '停止这次回复' }], [])
    await thirdRequest
    await new Promise((resolve) => setTimeout(resolve, 50))
    const closing = agent.close()
    await cancelled
    await closing
    expect(events.some((event) => event.kind === 'error' && event.text === '已停止回复')).toBe(true)
    container.database.close()
    container = createServiceContainer(paths, false)
    agent = new AgentService(
      paths,
      container.database.db,
      config,
      container.services,
      () => {
        throw new Error('MCP must be disabled')
      },
      (event) => events.push(event),
    )
    const interrupted = (await agent.history(conversation.id)).messages.at(-1)
    expect(interrupted?.role).toBe('assistant')
    if (interrupted?.role === 'assistant') {
      expect(interrupted.text).toContain('部分回复')
      expect(interrupted.incomplete).toBe(true)
    }
    await agent.delete(conversation.id)
    expect(agent.list()).toHaveLength(0)
    expect(fs.existsSync(path.join(paths.chatUploads, `${attachment.id}.txt`))).toBe(false)
    expect(fs.existsSync(path.join(paths.chatUploads, `${image.id}.png`))).toBe(false)
    expect(fs.existsSync(path.join(paths.chatUploads, `${pasted.id}.png`))).toBe(false)
    await agent.close()
    container.database.close()
  })

  it('uses a LangGraph interrupt for ask_user and resumes the same conversation', async () => {
    let requests = 0
    const requestBodies: { messages: { role: string; content: string }[] }[] = []
    const server = http.createServer(async (request, response) => {
      let body = ''
      for await (const chunk of request) body += chunk.toString()
      requestBodies.push(JSON.parse(body) as (typeof requestBodies)[number])
      requests++
      const delta =
        requests === 1
          ? {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'call-question',
                  type: 'function',
                  function: {
                    name: 'ask_user',
                    arguments: JSON.stringify({
                      questions: [
                        {
                          question: '目标城市是哪里？',
                          options: [
                            { label: '上海', description: '优先考虑长三角', recommended: true },
                            { label: '北京', description: '优先考虑京津冀' },
                          ],
                        },
                        { question: '希望的岗位方向？' },
                      ],
                    }),
                  },
                },
              ],
            }
          : { role: 'assistant', content: '已按上海继续分析。' }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write(
        `data: ${JSON.stringify({ id: `ask-${requests}`, object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
      )
      response.write(
        `data: ${JSON.stringify({ id: `ask-${requests}`, object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta: {}, finish_reason: requests === 1 ? 'tool_calls' : 'stop' }] })}\n\n`,
      )
      response.end('data: [DONE]\n\n')
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('mock server failed')
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrail-agent-'))
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
      ai: {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        modelId: 'mock',
        apiKey: '',
        multimodal: false,
        contextWindowK: 256,
        compactThresholdPercent: 80,
      },
    })
    let container = createServiceContainer(paths, false)
    let agent = new AgentService(
      paths,
      container.database.db,
      config,
      container.services,
      () => {
        throw new Error('MCP must be disabled')
      },
      () => {},
    )
    try {
      const conversation = agent.create()
      await agent.send(conversation.id, [{ kind: 'text', text: '帮我分析工作机会' }], [])
      expect((await agent.history(conversation.id)).pending).toMatchObject({
        kind: 'question',
        questions: [
          {
            question: '目标城市是哪里？',
            options: [
              { label: '上海', description: '优先考虑长三角', recommended: true },
              { label: '北京', description: '优先考虑京津冀' },
            ],
          },
          { question: '希望的岗位方向？' },
        ],
      })
      expect(requests).toBe(1)
      await agent.close()
      container.database.close()
      container = createServiceContainer(paths, false)
      agent = new AgentService(
        paths,
        container.database.db,
        config,
        container.services,
        () => {
          throw new Error('MCP must be disabled')
        },
        () => {},
      )
      expect((await agent.history(conversation.id)).pending?.kind).toBe('question')
      await expect(agent.resume(conversation.id, ['上海'])).rejects.toThrow('回答全部问题')
      await agent.resume(conversation.id, ['上海', 'Java 后端'])
      const history = await agent.history(conversation.id)
      expect(history.pending).toBeNull()
      expect(history.messages.map((message) => message.role)).toEqual(['user', 'tool', 'assistant'])
      expect(history.messages[1].role === 'tool' && history.messages[1].status).toBe('completed')
      const lastMessage = history.messages.at(-1)
      expect(lastMessage?.role).toBe('assistant')
      if (lastMessage?.role === 'assistant') expect(lastMessage.text).toContain('上海')
      expect(requests).toBe(2)
      expect(
        JSON.parse(requestBodies[1].messages.find((message) => message.role === 'tool')!.content),
      ).toEqual([
        { question: '目标城市是哪里？', answer: '上海' },
        { question: '希望的岗位方向？', answer: 'Java 后端' },
      ])
    } finally {
      await agent.close()
      container.database.close()
    }
  })

  it('runs every tool call in one model response and resumes interrupts one at a time', async () => {
    let requests = 0
    type RequestMessage = { role: string; content?: string; tool_call_id?: string }
    let finalMessages: RequestMessage[] = []
    let latestMessages: RequestMessage[] = []
    const server = http.createServer(async (request, response) => {
      let body = ''
      for await (const chunk of request) body += chunk.toString()
      requests++
      latestMessages = (JSON.parse(body) as { messages: RequestMessage[] }).messages
      if (requests === 2) finalMessages = latestMessages
      const delta =
        requests === 1
          ? {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'call-city',
                  type: 'function',
                  function: {
                    name: 'ask_user',
                    arguments: '{"questions":[{"question":"城市？"}]}',
                  },
                },
                {
                  index: 1,
                  id: 'call-salary',
                  type: 'function',
                  function: {
                    name: 'ask_user',
                    arguments: '{"questions":[{"question":"薪资？"}]}',
                  },
                },
              ],
            }
          : requests === 3
            ? {
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: 'call-cancelled-read',
                    type: 'function',
                    function: { name: 'list_statuses', arguments: '{}' },
                  },
                ],
              }
            : { role: 'assistant', content: '已收到两个回答。' }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write(
        `data: ${JSON.stringify({ id: `multi-${requests}`, object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
      )
      response.write(
        `data: ${JSON.stringify({ id: `multi-${requests}`, object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta: {}, finish_reason: requests === 1 || requests === 3 ? 'tool_calls' : 'stop' }] })}\n\n`,
      )
      response.end('data: [DONE]\n\n')
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('mock server failed')
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrail-agent-multi-'))
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
      ai: {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        modelId: 'mock',
        apiKey: '',
        multimodal: false,
        contextWindowK: 256,
        compactThresholdPercent: 80,
      },
    })
    const container = createServiceContainer(paths, false)
    const agent = new AgentService(
      paths,
      container.database.db,
      config,
      container.services,
      () => {
        throw new Error('MCP must be disabled')
      },
      () => {},
    )
    try {
      const conversation = agent.create()
      await agent.send(conversation.id, [{ kind: 'text', text: '请补充条件' }], [])
      const firstPending = await agent.history(conversation.id)
      expect(firstPending.pending).toMatchObject({
        kind: 'question',
        questions: [{ question: '城市？' }],
      })
      expect(
        firstPending.messages
          .filter((message) => message.role === 'tool')
          .map((message) => message.status),
      ).toEqual(['waiting', 'running'])
      await agent.resume(conversation.id, ['上海'])
      expect((await agent.history(conversation.id)).pending).toMatchObject({
        kind: 'question',
        questions: [{ question: '薪资？' }],
      })
      await agent.resume(conversation.id, ['20k'])
      const completedHistory = await agent.history(conversation.id)
      expect(completedHistory.pending).toBeNull()
      expect(completedHistory.messages.map((message) => message.role)).toEqual([
        'user',
        'tool',
        'tool',
        'assistant',
      ])
      expect(
        completedHistory.messages
          .filter((message) => message.role === 'tool')
          .map((message) => message.status),
      ).toEqual(['completed', 'completed'])
      expect(requests).toBe(2)
      expect(
        finalMessages
          .filter((message) => message.role === 'tool')
          .map((message) => message.tool_call_id),
      ).toEqual(['call-city', 'call-salary'])

      config.update({ mcp: { enabled: true, requireWriteConfirmation: true } })
      let started!: () => void
      const toolStarted = new Promise<void>((resolve) => {
        started = resolve
      })
      let toolSignal: AbortSignal | undefined
      const client = (
        agent as unknown as { mcp: { call: (...args: unknown[]) => Promise<string> } }
      ).mcp
      client.call = async (_name, _args, signal) => {
        toolSignal = signal as AbortSignal
        started()
        return new Promise<string>((_resolve, reject) => {
          toolSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      }
      const stopped = agent.send(conversation.id, [{ kind: 'text', text: '读取状态后取消' }], [])
      await toolStarted
      agent.cancel(conversation.id)
      await stopped
      expect(toolSignal?.aborted).toBe(true)
      config.update({ mcp: { enabled: false, requireWriteConfirmation: true } })
      for (let index = 0; index < 13; index++)
        await agent.send(conversation.id, [{ kind: 'text', text: `后续问题 ${index}` }], [])
      expect(
        latestMessages.some(
          (message) => message.role === 'user' && message.content === '请补充条件',
        ),
      ).toBe(true)
      expect(
        latestMessages.find((message) => message.tool_call_id === 'call-cancelled-read')?.content,
      ).toContain('已停止')
    } finally {
      await agent.close()
      container.database.close()
    }
  })

  it('runs independent read tools concurrently and reports each call', async () => {
    let requests = 0
    const server = http.createServer(async (request, response) => {
      for await (const _chunk of request) {
        /* consume body */
      }
      requests++
      const delta =
        requests === 1
          ? {
              role: 'assistant',
              content: '先说明',
              tool_calls: [
                {
                  index: 0,
                  id: 'read-statuses',
                  type: 'function',
                  function: { name: 'list_statuses', arguments: '{}' },
                },
                {
                  index: 1,
                  id: 'read-industries',
                  type: 'function',
                  function: { name: 'list_industries', arguments: '{}' },
                },
              ],
            }
          : { role: 'assistant', content: '后总结' }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write(
        `data: ${JSON.stringify({ id: `parallel-${requests}`, object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
      )
      response.write(
        `data: ${JSON.stringify({ id: `parallel-${requests}`, object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta: {}, finish_reason: requests === 1 ? 'tool_calls' : 'stop' }] })}\n\n`,
      )
      response.end('data: [DONE]\n\n')
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('mock server failed')
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrail-agent-parallel-'))
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
      ai: {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        modelId: 'mock',
        apiKey: '',
        multimodal: false,
        contextWindowK: 256,
        compactThresholdPercent: 80,
      },
      mcp: { enabled: true, requireWriteConfirmation: true },
    })
    const container = createServiceContainer(paths, false)
    const events: AgentEvent[] = []
    const agent = new AgentService(
      paths,
      container.database.db,
      config,
      container.services,
      () => {
        throw new Error('MCP client is stubbed')
      },
      (event) => events.push(event),
    )
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let bothStarted!: () => void
    const started = new Promise<void>((resolve) => {
      bothStarted = resolve
    })
    const calls: string[] = []
    const client = (agent as unknown as { mcp: { call: (name: string) => Promise<string> } }).mcp
    client.call = async (name) => {
      calls.push(name)
      if (calls.length === 2) bothStarted()
      await gate
      return '{}'
    }
    try {
      const conversation = agent.create()
      const renamed = agent.rename(conversation.id, '  新对话  ')
      expect(renamed.title).toBe('新对话')
      expect(() => agent.rename(conversation.id, ' ')).toThrow()
      const running = agent.send(conversation.id, [{ kind: 'text', text: '列出状态和行业' }], [])
      await Promise.race([
        started,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('read tools did not start concurrently')), 3000),
        ),
      ])
      expect(calls).toEqual(['list_statuses', 'list_industries'])
      expect(events.filter((event) => event.kind === 'tool-start')).toHaveLength(2)
      release()
      await running
      const history = await agent.history(conversation.id)
      expect(history.messages.map((message) => message.role)).toEqual([
        'user',
        'assistant',
        'tool',
        'tool',
        'assistant',
      ])
      expect(
        history.messages
          .filter((message) => message.role === 'assistant')
          .map((message) => message.text),
      ).toEqual(['先说明', '后总结'])
      expect(agent.list()[0].title).toBe('新对话')
      expect(agent.rename(conversation.id, '并行读取').title).toBe('并行读取')
      expect(events.filter((event) => event.kind === 'tool-end')).toHaveLength(2)
      expect(requests).toBe(2)
    } finally {
      release()
      await agent.close()
      container.database.close()
    }
  })
})
