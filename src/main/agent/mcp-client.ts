import crypto from 'node:crypto'
import { app } from 'electron'
import { Client, isInputRequiredResult, type CallToolResult } from '@modelcontextprotocol/client'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio'
import { interrupt } from '@langchain/langgraph'
import type { McpConnectionInfo } from '../../shared/types'
import type { ConfigService } from '../config'

function previewFingerprint(message: string): string {
  return crypto.createHash('sha256').update(message).digest('hex')
}

export class AgentMcpClient {
  private client: Client | undefined
  private connecting: Promise<Client> | undefined
  constructor(
    private readonly config: ConfigService,
    private readonly connection: () => McpConnectionInfo,
  ) {}

  private async ready(): Promise<Client> {
    if (!this.config.reload().mcp.enabled) throw new Error('MCP 连接已关闭')
    if (this.client) return this.client
    if (!this.connecting) this.connecting = this.connect()
    try {
      return await this.connecting
    } finally {
      this.connecting = undefined
    }
  }

  private async connect(): Promise<Client> {
    const info = this.connection()
    const env = { ...getDefaultEnvironment(), ...info.env }
    const client = new Client(
      { name: 'jobtrail-built-in-agent', version: app.getVersion() },
      {
        capabilities: { elicitation: {} },
        versionNegotiation: { mode: { pin: '2026-07-28' } },
        inputRequired: { autoFulfill: false },
      },
    )
    try {
      const transport = new StdioClientTransport({
        command: info.command,
        args: info.args,
        env,
        stderr: 'pipe',
      })
      transport.stderr?.on('data', () => undefined)
      await client.connect(transport)
      await client.listTools()
    } catch (error) {
      await client.close().catch(() => {})
      throw error
    }
    client.onclose = () => {
      if (this.client === client) this.client = undefined
    }
    this.client = client
    return client
  }

  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const client = await this.ready()
    return callMcpWithConfirmation(
      client,
      name,
      args,
      () => this.config.reload().mcp.requireWriteConfirmation,
      signal,
    )
  }

  async close(): Promise<void> {
    await this.connecting?.catch(() => {})
    const client = this.client
    this.client = undefined
    if (client) await client.close()
  }
}

export async function callMcpWithConfirmation(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  confirmationEnabled: () => boolean,
  signal?: AbortSignal,
): Promise<string> {
  let result: CallToolResult | Awaited<ReturnType<typeof client.callTool>> = await client.callTool(
    { name, arguments: args },
    { allowInputRequired: true, signal },
  )
  for (let round = 0; isInputRequiredResult(result) && round < 8; round++) {
    const request = result.inputRequests?.confirm
    if (!request || request.method !== 'elicitation/create' || !result.requestState)
      throw new Error('MCP 返回了不支持的交互请求')
    const message = 'message' in request.params ? String(request.params.message) : ''
    if (!message) throw new Error('MCP 写入预览缺失')
    const fingerprint = previewFingerprint(message)
    let answer = interrupt({ kind: 'confirmation', message, fingerprint }) as {
      approved: boolean
      fingerprint: string
    }
    while (answer.approved && answer.fingerprint !== fingerprint) {
      // On replay, an approval for an older preview is consumed first.
      // A new interrupt must be answered for the current preview.
      answer = interrupt({ kind: 'confirmation', message, fingerprint }) as {
        approved: boolean
        fingerprint: string
      }
    }
    if (!answer.approved) return '用户已取消，未修改数据。'
    // Interrupt replay may start a new MCP process. Obtain a fresh signed state,
    // and never use approval for a different preview.
    if (!confirmationEnabled()) throw new Error('写入确认设置已更改，请重新发起操作')
    const fresh = await client.callTool(
      { name, arguments: args },
      { allowInputRequired: true, signal },
    )
    if (!isInputRequiredResult(fresh)) throw new Error('MCP 未返回新的写入预览，已停止操作')
    const freshRequest = fresh.inputRequests?.confirm
    const freshMessage =
      freshRequest?.method === 'elicitation/create' &&
      freshRequest.params &&
      'message' in freshRequest.params
        ? String(freshRequest.params.message)
        : ''
    if (previewFingerprint(freshMessage) !== fingerprint) {
      result = fresh
      continue
    }
    result = await client.callTool(
      {
        name,
        arguments: args,
        requestState: fresh.requestState,
        inputResponses: { confirm: { action: 'accept', content: {} } },
      } as Parameters<Client['callTool']>[0],
      { allowInputRequired: true, signal },
    )
  }
  if (isInputRequiredResult(result)) throw new Error('MCP 确认轮次过多')
  return serializeMcpResult(result.structuredContent ?? result.content)
}

export function serializeMcpResult(value: unknown): string {
  const serialized = JSON.stringify(value)
  if (serialized.length <= 50_000) return serialized
  return JSON.stringify({
    truncated: true,
    notice: '工具结果过大；请使用搜索或更精确的读取工具缩小范围。',
    preview: serialized.slice(0, 48_000),
  })
}
