import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { Command, END, MemorySaver, START, StateGraph, StateSchema } from '@langchain/langgraph'
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite'
import { z } from 'zod'
import { callMcpWithConfirmation, serializeMcpResult } from '../src/main/agent/mcp-client'
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio'
import type { AppPaths } from '../src/main/config'
import { ConfigService } from '../src/main/config'
import { createJobTrailMcpServer } from '../src/main/mcp/server'
import { createServiceContainer } from '../src/main/service-container'

describe('JobTrail MCP server', () => {
  let root: string
  let paths: AppPaths
  let config: ConfigService
  let container: ReturnType<typeof createServiceContainer> | undefined
  const secondaryContainers: Array<ReturnType<typeof createServiceContainer>> = []
  const clients: Client[] = []
  const handles: StdioServerHandle[] = []

  it('keeps oversized tool results valid JSON and marks them as truncated', () => {
    const serialized = serializeMcpResult({ value: 'x'.repeat(60_000) })
    const parsed = JSON.parse(serialized) as {
      truncated: boolean
      notice: string
      preview: string
    }
    expect(parsed.truncated).toBe(true)
    expect(parsed.notice).toContain('工具结果过大')
    expect(parsed.preview.length).toBe(48_000)
  })

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrail-mcp-'))
    paths = {
      root,
      config: path.join(root, 'config.json'),
      data: path.join(root, 'data'),
      database: path.join(root, 'data', 'zhiji.db'),
      resumes: path.join(root, 'resumes'),
      chatUploads: path.join(root, 'chat-uploads'),
    }
    config = new ConfigService(paths)
    container = createServiceContainer(paths, false)
  })

  afterEach(async () => {
    await Promise.allSettled(clients.splice(0).map((client) => client.close()))
    await Promise.allSettled(handles.splice(0).map((handle) => handle.close()))
    secondaryContainers.splice(0).forEach((item) => item.database.close())
    container?.database.close()
    container = undefined
    fs.rmSync(root, { recursive: true, force: true })
  })

  async function connect(
    modern = false,
    confirmation: 'accept' | 'decline' | 'cancel' = 'accept',
    onElicitation?: () => void,
    supportsConfirmation = true,
  ) {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const handle = serveStdio(
      () =>
        createJobTrailMcpServer({
          version: '0.4.0-test',
          unitOfWork: container!.unitOfWork,
          services: container!.services,
          config,
        }),
      { transport: serverTransport },
    )
    handles.push(handle)
    const client = new Client(
      { name: 'jobtrail-test', version: '1.0.0' },
      {
        capabilities: supportsConfirmation ? { elicitation: {} } : {},
        ...(modern ? { versionNegotiation: { mode: { pin: '2026-07-28' as const } } } : {}),
      },
    )
    if (supportsConfirmation) {
      client.setRequestHandler('elicitation/create', async () => {
        onElicitation?.()
        return { action: confirmation }
      })
    }
    await client.connect(clientTransport)
    clients.push(client)
    return client
  }

  async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args })
    expect(result.isError, `${name} returned ${JSON.stringify(result.content)}`).not.toBe(true)
    return result.structuredContent as Record<string, unknown>
  }

  it('gates all data access while disabled and advertises exactly 36 tools', async () => {
    const client = await connect()
    const listed = await client.listTools()
    expect(listed.tools).toHaveLength(36)
    expect(new Set(listed.tools.map((tool) => tool.name))).toHaveProperty('size', 36)
    const result = await client.callTool({ name: 'list_statuses', arguments: {} })
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: 'MCP_DISABLED' },
    })
  })

  it('executes all 36 tools through application services', async () => {
    config.update({ mcp: { enabled: true, requireWriteConfirmation: true } })
    const client = await connect(true)

    const statuses = (await call(client, 'list_statuses')).items as Array<{ id: number }>
    await call(client, 'get_status', { id: statuses[0].id })
    const status = (await call(client, 'create_status', { input: { label: 'MCP 状态' } })).item as {
      id: number
    }
    await call(client, 'update_status', { id: status.id, input: { label: 'MCP 状态更新' } })
    const statusOrder = [status.id, ...statuses.map((item) => item.id)]
    await call(client, 'reorder_statuses', { order: statusOrder })

    const industries = (await call(client, 'list_industries')).items as Array<{ id: number }>
    await call(client, 'get_industry', { id: industries[0].id })
    const industry = (await call(client, 'create_industry', { input: { name: 'MCP 行业' } }))
      .item as { id: number }
    await call(client, 'update_industry', { id: industry.id, input: { name: 'MCP 行业更新' } })
    await call(client, 'reorder_industries', {
      order: [industry.id, ...industries.map((item) => item.id)],
    })

    const company = (
      await call(client, 'create_company', {
        input: { name: 'MCP 公司', industryIds: [industry.id], aliases: ['MCP'] },
      })
    ).item as { id: number }
    await call(client, 'search_companies', { keyword: 'MCP' })
    await call(client, 'list_companies')
    await call(client, 'get_company', { id: company.id })
    await call(client, 'mark_company_read', { id: company.id })
    await call(client, 'update_company', { id: company.id, input: { isFavorite: true } })

    const sourcePath = path.join(root, 'resume.pdf')
    fs.writeFileSync(sourcePath, 'mcp resume')
    const resume = (
      await call(client, 'import_resume_version', { sourcePath, name: 'MCP 简历', note: '测试' })
    ).item as { id: number }
    await call(client, 'list_resume_versions')
    await call(client, 'get_resume_version', { id: resume.id })
    await call(client, 'update_resume_version', { id: resume.id, input: { note: '已更新' } })
    await call(client, 'reorder_resume_versions', { order: [resume.id] })

    const opportunity = (
      await call(client, 'create_opportunity', {
        input: {
          companyId: company.id,
          title: 'MCP 工程师',
          statusId: status.id,
          resumeVersionId: resume.id,
        },
      })
    ).item as { id: number }
    await call(client, 'search_opportunities', { query: { search: 'MCP' } })
    await call(client, 'get_opportunity', { id: opportunity.id })
    await call(client, 'update_opportunity', { id: opportunity.id, input: { location: '上海' } })
    await call(client, 'change_opportunity_status', {
      id: opportunity.id,
      statusId: statuses[0].id,
    })

    const startAt = Date.now() + 60_000
    const event = (
      await call(client, 'create_calendar_event', {
        input: {
          opportunityId: opportunity.id,
          title: 'MCP 面试',
          eventType: '面试',
          startAt,
          endAt: startAt + 3_600_000,
          timezone: 'Asia/Shanghai',
        },
      })
    ).item as { id: number }
    await call(client, 'list_calendar_events', {
      range: { startAt: startAt - 1, endAt: startAt + 4_000_000 },
    })
    await call(client, 'get_calendar_event', { id: event.id })
    await call(client, 'update_calendar_event', { id: event.id, input: { location: '线上' } })
    await call(client, 'delete_calendar_event', { id: event.id })
    await call(client, 'delete_opportunity', { id: opportunity.id })
    await call(client, 'delete_resume_version', { id: resume.id })
    await call(client, 'delete_company', { id: company.id })
    await call(client, 'delete_industry', { id: industry.id })
    await call(client, 'delete_status', { id: status.id })
  })

  it('supports modern input-required confirmation and cancellation without writes', async () => {
    config.update({ mcp: { enabled: true, requireWriteConfirmation: true } })
    const acceptingClient = await connect(true, 'accept')
    await call(acceptingClient, 'create_status', { input: { label: '已确认' } })
    expect(container!.services.statuses.list().some((item) => item.label === '已确认')).toBe(true)

    const decliningClient = await connect(true, 'decline')
    const result = await decliningClient.callTool({
      name: 'create_status',
      arguments: { input: { label: '已拒绝' } },
    })
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({ cancelled: true })
    expect(container!.services.statuses.list().some((item) => item.label === '已拒绝')).toBe(false)
  })

  it('keeps built-in agent writes pending until LangGraph resumes the exact MCP preview', async () => {
    config.update({ mcp: { enabled: true, requireWriteConfirmation: true } })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    handles.push(
      serveStdio(
        () =>
          createJobTrailMcpServer({
            version: '0.7.0-test',
            unitOfWork: container!.unitOfWork,
            services: container!.services,
            config,
          }),
        { transport: serverTransport },
      ),
    )
    const client = new Client(
      { name: 'agent-test', version: '0.7.0' },
      {
        capabilities: { elicitation: {} },
        inputRequired: { autoFulfill: false },
        versionNegotiation: { mode: { pin: '2026-07-28' } },
      },
    )
    await client.connect(clientTransport)
    clients.push(client)
    const graph = new StateGraph(new StateSchema({ result: z.string().optional() }))
      .addNode('write', async () => ({
        result: await callMcpWithConfirmation(
          client,
          'create_status',
          { input: { label: '图确认状态' } },
          () => config.reload().mcp.requireWriteConfirmation,
        ),
      }))
      .addEdge(START, 'write')
      .addEdge('write', END)
      .compile({ checkpointer: new MemorySaver() })
    const thread = { configurable: { thread_id: 'agent-write' } }
    await graph.invoke({}, thread)
    expect(container!.services.statuses.list().some((item) => item.label === '图确认状态')).toBe(
      false,
    )
    const snapshot = await graph.getState(thread)
    const preview = snapshot.tasks[0].interrupts[0].value as {
      fingerprint: string
      message: string
    }
    expect(preview.message).toContain('图确认状态')
    await graph.invoke(
      new Command({ resume: { approved: true, fingerprint: preview.fingerprint } }),
      thread,
    )
    expect(
      container!.services.statuses.list().filter((item) => item.label === '图确认状态'),
    ).toHaveLength(1)
  })

  it('asks again when the MCP preview changes before the built-in agent resumes', async () => {
    config.update({ mcp: { enabled: true, requireWriteConfirmation: true } })
    const target = container!.services.statuses.create({ label: '原状态' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    handles.push(
      serveStdio(
        () =>
          createJobTrailMcpServer({
            version: '0.7.0-test',
            unitOfWork: container!.unitOfWork,
            services: container!.services,
            config,
          }),
        { transport: serverTransport },
      ),
    )
    const client = new Client(
      { name: 'agent-test', version: '0.7.0' },
      {
        capabilities: { elicitation: {} },
        inputRequired: { autoFulfill: false },
        versionNegotiation: { mode: { pin: '2026-07-28' } },
      },
    )
    await client.connect(clientTransport)
    clients.push(client)
    const graph = new StateGraph(new StateSchema({ result: z.string().optional() }))
      .addNode('write', async () => ({
        result: await callMcpWithConfirmation(
          client,
          'update_status',
          { id: target.id, input: { label: '最终状态' } },
          () => config.reload().mcp.requireWriteConfirmation,
        ),
      }))
      .addEdge(START, 'write')
      .addEdge('write', END)
      .compile({ checkpointer: new MemorySaver() })
    const thread = { configurable: { thread_id: 'agent-stale' } }
    await graph.invoke({}, thread)
    const first = (await graph.getState(thread)).tasks[0].interrupts[0].value as {
      fingerprint: string
    }
    container!.services.statuses.update(target.id, { label: '并发更新' })
    await graph.invoke(
      new Command({ resume: { approved: true, fingerprint: first.fingerprint } }),
      thread,
    )
    const second = (await graph.getState(thread)).tasks[0].interrupts[0].value as {
      fingerprint: string
      message: string
    }
    expect(second.fingerprint).not.toBe(first.fingerprint)
    expect(second.message).toContain('并发更新')
    expect(container!.services.statuses.get(target.id).label).toBe('并发更新')
    await graph.invoke(
      new Command({ resume: { approved: true, fingerprint: second.fingerprint } }),
      thread,
    )
    expect(container!.services.statuses.get(target.id).label).toBe('最终状态')
  })

  it('revalidates a pending approval with a fresh MCP server after restart', async () => {
    config.update({ mcp: { enabled: true, requireWriteConfirmation: true } })
    async function freshClient(): Promise<Client> {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      handles.push(
        serveStdio(
          () =>
            createJobTrailMcpServer({
              version: '0.7.0-test',
              unitOfWork: container!.unitOfWork,
              services: container!.services,
              config,
            }),
          { transport: serverTransport },
        ),
      )
      const client = new Client(
        { name: 'agent-test', version: '0.7.0' },
        {
          capabilities: { elicitation: {} },
          inputRequired: { autoFulfill: false },
          versionNegotiation: { mode: { pin: '2026-07-28' } },
        },
      )
      await client.connect(clientTransport)
      clients.push(client)
      return client
    }
    const compile = (client: Client) =>
      new StateGraph(new StateSchema({ result: z.string().optional() }))
        .addNode('write', async () => ({
          result: await callMcpWithConfirmation(
            client,
            'create_status',
            { input: { label: '重启后确认' } },
            () => config.reload().mcp.requireWriteConfirmation,
          ),
        }))
        .addEdge(START, 'write')
        .addEdge('write', END)
        .compile({ checkpointer: new SqliteSaver(container!.database.db) })
    const thread = { configurable: { thread_id: 'restart-approval' } }
    const beforeRestart = compile(await freshClient())
    await beforeRestart.invoke({}, thread)
    const preview = (await beforeRestart.getState(thread)).tasks[0].interrupts[0].value as {
      fingerprint: string
    }
    const afterRestart = compile(await freshClient())
    await afterRestart.invoke(
      new Command({ resume: { approved: true, fingerprint: preview.fingerprint } }),
      thread,
    )
    expect(
      container!.services.statuses.list().filter((item) => item.label === '重启后确认'),
    ).toHaveLength(1)
  })

  it('supports legacy confirmation and requests confirmation again for a stale preview', async () => {
    config.update({ mcp: { enabled: true, requireWriteConfirmation: true } })
    const legacyClient = await connect(false, 'accept')
    await call(legacyClient, 'create_status', { input: { label: '旧协议确认' } })
    expect(container!.services.statuses.list().some((item) => item.label === '旧协议确认')).toBe(
      true,
    )

    config.update({ mcp: { enabled: true, requireWriteConfirmation: false } })
    const desktopContainer = createServiceContainer(paths, false)
    secondaryContainers.push(desktopContainer)
    expect(desktopContainer.database.db.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(desktopContainer.database.db.pragma('busy_timeout', { simple: true })).toBe(5000)
    const target = desktopContainer.services.statuses.create({ label: '并发前' })
    config.update({ mcp: { enabled: true, requireWriteConfirmation: true } })
    let prompts = 0
    const staleClient = await connect(true, 'accept', () => {
      prompts += 1
      if (prompts === 1) {
        desktopContainer.services.statuses.update(target.id, { label: '并发修改' })
      }
    })
    await call(staleClient, 'update_status', {
      id: target.id,
      input: { label: '确认后的最终值' },
    })
    expect(prompts).toBe(2)
    expect(desktopContainer.services.statuses.get(target.id).label).toBe('确认后的最终值')
  })

  it('shares committed data bidirectionally with an open desktop database connection', async () => {
    config.update({ mcp: { enabled: true, requireWriteConfirmation: false } })
    const desktopContainer = createServiceContainer(paths, false)
    secondaryContainers.push(desktopContainer)
    const client = await connect()

    const desktopStatus = desktopContainer.services.statuses.create({ label: '桌面创建' })
    const visibleToMcp = (await call(client, 'get_status', { id: desktopStatus.id })).item as {
      label: string
    }
    expect(visibleToMcp.label).toBe('桌面创建')

    const mcpStatus = (await call(client, 'create_status', { input: { label: 'MCP 创建' } }))
      .item as { id: number }
    expect(desktopContainer.services.statuses.get(mcpStatus.id).label).toBe('MCP 创建')

    desktopContainer.services.statuses.update(mcpStatus.id, { label: '桌面随后更新' })
    const updated = (await call(client, 'get_status', { id: mcpStatus.id })).item as {
      label: string
    }
    expect(updated.label).toBe('桌面随后更新')
  })

  it('does not write for cancellation, unsupported confirmation, or invalid resume paths', async () => {
    config.update({ mcp: { enabled: true, requireWriteConfirmation: true } })
    const cancellingClient = await connect(true, 'cancel')
    const cancelled = await cancellingClient.callTool({
      name: 'create_status',
      arguments: { input: { label: '已取消' } },
    })
    expect(cancelled.isError).toBe(true)
    expect(cancelled.structuredContent).toMatchObject({ cancelled: true })
    expect(container!.services.statuses.list().some((item) => item.label === '已取消')).toBe(false)

    const unsupportedClient = await connect(false, 'accept', undefined, false)
    const unsupported = await unsupportedClient.callTool({
      name: 'create_status',
      arguments: { input: { label: '不支持确认' } },
    })
    expect(unsupported.isError).toBe(true)
    expect(unsupported.structuredContent).toMatchObject({
      error: { code: 'CONFIRMATION_UNSUPPORTED' },
    })
    expect(container!.services.statuses.list().some((item) => item.label === '不支持确认')).toBe(
      false,
    )

    config.update({ mcp: { enabled: true, requireWriteConfirmation: false } })
    const invalidPath = path.join(root, 'resume.txt')
    fs.writeFileSync(invalidPath, 'not a supported resume')
    const invalidResume = await unsupportedClient.callTool({
      name: 'import_resume_version',
      arguments: { sourcePath: invalidPath },
    })
    expect(invalidResume.isError).toBe(true)
    expect(container!.services.resumes.list()).toHaveLength(0)
  })
})
