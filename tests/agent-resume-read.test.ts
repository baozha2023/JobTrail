import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentService } from '../src/main/agent/service'
import { ConfigService, type AppPaths } from '../src/main/config'
import { createServiceContainer } from '../src/main/service-container'
import type { ResumeVersion } from '../src/shared/types'
import { onePagePdf } from './helpers/pdf'

describe('agent resume reader', () => {
  const roots: string[] = []
  const servers: http.Server[] = []
  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map(
          (server) =>
            new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            ),
        ),
    )
    roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }))
  })

  it('reads a referenced resume through a dedicated tool without exposing its path', async () => {
    const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = []
    const server = http.createServer(async (request, response) => {
      let raw = ''
      for await (const chunk of request) raw += chunk.toString()
      requests.push(JSON.parse(raw) as (typeof requests)[number])
      const first = requests.length === 1
      const delta = first
        ? {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'read-resume-1',
                type: 'function',
                function: { name: 'read_resume', arguments: '{"resumeId":7}' },
              },
            ],
          }
        : { role: 'assistant', content: '已读取简历。' }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write(
        `data: ${JSON.stringify({ id: `resume-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
      )
      response.write(
        `data: ${JSON.stringify({ id: `resume-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta: {}, finish_reason: first ? 'tool_calls' : 'stop' }] })}\n\n`,
      )
      response.end('data: [DONE]\n\n')
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('mock server failed')

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrail-read-resume-'))
    roots.push(root)
    const paths: AppPaths = {
      root,
      config: path.join(root, 'config.json'),
      data: path.join(root, 'data'),
      database: path.join(root, 'data', 'zhiji.db'),
      resumes: path.join(root, 'resumes'),
      chatUploads: path.join(root, 'chat-uploads'),
    }
    const resumePath = path.join(root, 'resume.pdf')
    fs.writeFileSync(resumePath, onePagePdf('TypeScript Electron resume'))
    const config = new ConfigService(paths)
    config.update({
      ai: {
        ...config.get().ai,
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        modelId: 'mock',
        multimodal: true,
      },
      mcp: { enabled: true, requireWriteConfirmation: true },
    })
    const container = createServiceContainer(paths, false)
    const resume: ResumeVersion = {
      id: 7,
      name: '技术简历',
      relativePath: 'private-managed-name.pdf',
      sizeBytes: 100,
      sha256: 'private-hash',
      note: '用于研发岗位',
      sortOrder: 1,
      createdAt: 1,
      updatedAt: 1,
    }
    const services = {
      ...container.services,
      resumes: {
        get: (id: number) => {
          expect(id).toBe(7)
          return resume
        },
        getPath: (id: number) => {
          expect(id).toBe(7)
          return resumePath
        },
      } as typeof container.services.resumes,
    }
    const agent = new AgentService(
      paths,
      container.database.db,
      config,
      services,
      () => {
        throw new Error('MCP transport must not be used by read_resume')
      },
      () => {},
    )
    try {
      const chat = agent.create()
      await agent.send(
        chat.id,
        [
          { kind: 'text', text: '概括' },
          { kind: 'resume', id: resume.id, name: resume.name },
        ],
        [],
      )
      expect(requests).toHaveLength(2)
      const toolMessage = requests[1].messages.find((message) => message.role === 'tool')
      expect(toolMessage).toBeTruthy()
      expect(JSON.parse(String(toolMessage!.content))).toEqual({
        resumeId: 7,
        name: '技术简历',
        note: '用于研发岗位',
        text: 'TypeScript Electron resume',
      })
      expect(String(toolMessage!.content)).not.toContain('private-managed-name.pdf')
      expect(String(toolMessage!.content)).not.toContain('private-hash')
      const visualMessage = requests[1].messages.find(
        (message) =>
          message.role === 'user' &&
          Array.isArray(message.content) &&
          message.content.some(
            (part) =>
              typeof part === 'object' &&
              part !== null &&
              (part as { type?: string }).type === 'image_url',
          ),
      )
      expect(visualMessage).toBeTruthy()
      expect(JSON.stringify(visualMessage!.content)).toContain('data:image/png;base64,')
      const archivedTool = (await agent.history(chat.id)).messages.find(
        (message) => message.role === 'tool' && message.name === 'read_resume',
      )
      expect(archivedTool?.role === 'tool' && archivedTool.result).toContain(
        'TypeScript Electron resume',
      )
    } finally {
      await agent.close()
      container.database.close()
    }
  })
})
