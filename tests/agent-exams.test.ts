import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { AgentService } from '../src/main/agent/service'
import { AgentMcpClient } from '../src/main/agent/mcp-client'
import { ConfigService } from '../src/main/config'
import { MCP_TOOLS } from '../src/main/mcp-contracts'
import { createServiceContainer } from '../src/main/service-container'
import type { AgentEvent } from '../src/shared/types'

it('keeps default answers in execution but removes them from live events and reopened chat history', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrail-exam-privacy-'))
  const paths = {
    root,
    config: path.join(root, 'config.json'),
    data: path.join(root, 'data'),
    database: path.join(root, 'data', 'zhiji.db'),
    resumes: path.join(root, 'resumes'),
    chatUploads: path.join(root, 'chat-uploads'),
  }
  const container = createServiceContainer(paths, false)
  const config = new ConfigService(paths)
  const events: AgentEvent[] = []
  const requests: string[] = []
  const defaultAnswer = 'Private creation answer retained for future use.'
  let paperId = ''
  const server = http.createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk.toString()
    requests.push(body)
    const first = requests.length === 1
    const delta = first
      ? {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'append-private-question',
              type: 'function',
              function: {
                name: 'append_exam_question',
                arguments: JSON.stringify({
                  paperId,
                  question: { type: 'short_answer', prompt: 'Explain a promise', defaultAnswer },
                }),
              },
            },
          ],
        }
      : { role: 'assistant', content: '题目已保存。' }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    for (const [part, finishReason] of [
      [delta, null],
      [{}, first ? 'tool_calls' : 'stop'],
    ])
      response.write(
        `data: ${JSON.stringify({
          id: `private-${requests.length}`,
          object: 'chat.completion.chunk',
          created: 1,
          model: 'mock',
          choices: [{ index: 0, delta: part, finish_reason: finishReason }],
        })}\n\n`,
      )
    response.end('data: [DONE]\n\n')
  })
  let agent: AgentService | undefined
  const mcpCall = vi
    .spyOn(AgentMcpClient.prototype, 'call')
    .mockImplementation(async (name, args) => {
      expect(name).toBe('append_exam_question')
      const descriptor = MCP_TOOLS.find((tool) => tool.name === name)!
      return JSON.stringify(
        await descriptor.execute(
          container.services,
          descriptor.inputSchema.parse(args) as Record<string, unknown>,
          new AbortController().signal,
        ),
      )
    })
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Mock server failed')
    config.update({
      ai: { ...config.get().ai, baseUrl: `http://127.0.0.1:${address.port}/v1`, modelId: 'mock' },
      mcp: { enabled: true },
    })
    const createAgent = () =>
      new AgentService(
        paths,
        container.database.db,
        config,
        container.services,
        () => {
          throw new Error('Use the in-process test MCP adapter')
        },
        (event) => events.push(event),
      )
    agent = createAgent()
    const chat = agent.create()
    paperId = container.services.exams.create({
      conversationId: chat.id,
      requestId: 'create-private-exam',
      taskId: 'private-task',
      title: 'Private exam',
      topic: 'TS',
      difficulty: 'Medium',
      counts: { single_choice: 0, true_false: 0, short_answer: 1 },
    }).id
    await agent.send(chat.id, [{ kind: 'text', text: '继续生成简答题' }], [])
    expect(mcpCall).toHaveBeenCalledOnce()
    expect(requests).toHaveLength(2)
    expect(requests[1]).toContain(defaultAnswer)
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'tool-start',
        toolName: 'append_exam_question',
        toolArgs: JSON.stringify({
          paperId,
          question: { type: 'short_answer', prompt: 'Explain a promise' },
        }),
      }),
    )
    expect(JSON.stringify(events)).not.toContain(defaultAnswer)
    expect(JSON.stringify(await agent.history(chat.id))).not.toContain(defaultAnswer)
    expect(
      container.database.db
        .prepare('SELECT default_answer FROM exam_questions WHERE paper_id=?')
        .get(paperId),
    ).toEqual({ default_answer: defaultAnswer })
    await agent.close()
    agent = createAgent()
    const history = await agent.history(chat.id)
    expect(history.messages.some((message) => message.role === 'tool')).toBe(true)
    expect(JSON.stringify(history)).not.toContain(defaultAnswer)
    expect(JSON.stringify(history)).not.toContain('defaultAnswer')
  } finally {
    await agent?.close()
    mcpCall.mockRestore()
    container.database.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    fs.rmSync(root, { recursive: true, force: true })
  }
})
