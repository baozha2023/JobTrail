import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages'
import { Command } from '@langchain/langgraph'
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite'
import type {
  AgentAttachment,
  AgentConversation,
  AgentDraftPart,
  AgentEvent,
  AgentHistory,
  AgentPending,
  AppConfig,
} from '../../shared/types'
import type { AppPaths, ConfigService } from '../config'
import type { Services } from '../service-container'
import { AppServiceError } from '../services/errors'
import { AgentFileStore } from './files'
import { createAgentGraph } from './graph'
import { AgentArchive } from './archive'
import { AgentMcpClient } from './mcp-client'
import { prepareUserMessage } from './message'

type SqliteDatabase = InstanceType<typeof Database>

export class AgentService {
  readonly files: AgentFileStore
  private readonly saver: SqliteSaver
  private readonly mcp: AgentMcpClient
  private readonly graph: ReturnType<typeof createAgentGraph>
  private readonly archive: AgentArchive
  private readonly running = new Map<string, AbortController>()
  private readonly inFlight = new Set<Promise<unknown>>()
  private closing = false

  constructor(
    paths: AppPaths,
    private readonly db: SqliteDatabase,
    private readonly config: ConfigService,
    private readonly services: Services,
    connection: ConstructorParameters<typeof AgentMcpClient>[1],
    private readonly emit: (event: AgentEvent) => void,
  ) {
    this.files = new AgentFileStore(paths, db)
    this.archive = new AgentArchive(db, this.files)
    this.saver = new SqliteSaver(db)
    this.mcp = new AgentMcpClient(config, connection)
    this.graph = createAgentGraph(config, services, this.files, this.mcp, this.saver, this.archive)
  }

  list(): AgentConversation[] {
    this.assertOpen()
    return this.db
      .prepare(
        'SELECT id, title, created_at AS createdAt, updated_at AS updatedAt FROM agent_conversations ORDER BY updated_at DESC',
      )
      .all() as AgentConversation[]
  }

  create(): AgentConversation {
    this.assertOpen()
    const conversation = {
      id: randomUUID(),
      title: this.config.get().locale === 'en-US' ? 'New chat' : '新对话',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    this.db
      .prepare(
        'INSERT INTO agent_conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)',
      )
      .run(conversation.id, conversation.title, conversation.createdAt, conversation.updatedAt)
    return conversation
  }

  rename(id: string, inputTitle: string): AgentConversation {
    this.ensure(id)
    if (typeof inputTitle !== 'string')
      throw new AppServiceError('VALIDATION_ERROR', '对话标题无效')
    const title = inputTitle.trim()
    if (!title || title.length > 100)
      throw new AppServiceError('VALIDATION_ERROR', '对话标题须为 1–100 个字符')
    const updatedAt = Date.now()
    this.db
      .prepare(
        'UPDATE agent_conversations SET title = ?, title_finalized = 1, updated_at = ? WHERE id = ?',
      )
      .run(title, updatedAt, id)
    return this.db
      .prepare(
        'SELECT id, title, created_at AS createdAt, updated_at AS updatedAt FROM agent_conversations WHERE id = ?',
      )
      .get(id) as AgentConversation
  }

  private ensure(id: string): void {
    this.assertOpen()
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ||
      !this.db.prepare('SELECT 1 FROM agent_conversations WHERE id = ?').get(id)
    )
      throw new AppServiceError('NOT_FOUND', '对话不存在')
  }

  private assertOpen(): void {
    if (this.closing) throw new AppServiceError('VALIDATION_ERROR', '智能体正在关闭')
  }

  private async rawPending(id: string): Promise<AgentPending | null> {
    const state = await this.graph.getState({ configurable: { thread_id: id } })
    const value = state.tasks?.flatMap((task) => task.interrupts ?? []).at(0)?.value
    if (!value || typeof value !== 'object') return null
    const pending = value as AgentPending
    if (pending.kind === 'confirmation')
      return typeof pending.message === 'string' && typeof pending.fingerprint === 'string'
        ? pending
        : null
    if (
      pending.kind === 'question' &&
      Array.isArray(pending.questions) &&
      pending.questions.length >= 1 &&
      pending.questions.length <= 3 &&
      pending.questions.every(
        (question) =>
          typeof question.question === 'string' &&
          (question.options === undefined ||
            (Array.isArray(question.options) &&
              question.options.every(
                (option) =>
                  typeof option.label === 'string' && typeof option.description === 'string',
              ))),
      )
    )
      return pending
    return null
  }

  history(id: string): Promise<AgentHistory> {
    return this.track(() => this.readHistory(id))
  }

  private async readHistory(id: string): Promise<AgentHistory> {
    this.ensure(id)
    const snapshot = await this.graph.getState({ configurable: { thread_id: id } })
    this.archive.sync(id, (snapshot.values?.messages ?? []) as BaseMessage[])
    const visible = this.archive.messages(id)
    const pending = await this.rawPending(id)
    if (pending) {
      const waiting = visible.find(
        (message) => message.role === 'tool' && message.status === 'running',
      )
      if (waiting?.role === 'tool') waiting.status = 'waiting'
    }
    const compacted = this.archive.lastEventKind(id) === 'compact'
    const contextTokens = compacted
      ? (snapshot.values?.lastCompact?.afterTokens ?? null)
      : this.archive.latestAgentInput(id)
    const usage = this.archive.usage(
      id,
      this.config.get().ai.contextWindowK * 1000,
      contextTokens,
      compacted || contextTokens === null,
    )
    return { messages: visible, pending, usage, running: this.running.has(id) }
  }

  delete(id: string): Promise<void> {
    return this.track(() => this.deleteConversation(id))
  }

  private async deleteConversation(id: string): Promise<void> {
    this.ensure(id)
    if (this.running.has(id)) throw new AppServiceError('VALIDATION_ERROR', '请先停止当前回复')
    await this.saver.deleteThread(id)
    this.archive.delete(id)
    this.files.deleteConversation(id)
    this.db.prepare('DELETE FROM agent_conversations WHERE id = ?').run(id)
  }

  upload(id: string, sourcePath: string): AgentAttachment {
    this.ensure(id)
    return this.files.import(id, sourcePath, this.config.get().ai.multimodal)
  }

  uploadBytes(id: string, name: string, mimeType: string, bytes: Uint8Array): AgentAttachment {
    this.ensure(id)
    return this.files.importBytes(id, name, mimeType, bytes, this.config.get().ai.multimodal)
  }

  preview(id: string, attachmentId: string): string | null {
    this.ensure(id)
    return this.files.preview(attachmentId, id)
  }

  removeUpload(id: string, attachmentId: string): Promise<void> {
    return this.track(() => this.removePendingUpload(id, attachmentId))
  }

  private async removePendingUpload(id: string, attachmentId: string): Promise<void> {
    this.ensure(id)
    if (this.running.has(id)) throw new AppServiceError('VALIDATION_ERROR', '请先停止当前回复')
    if (this.archive.usesAttachment(id, attachmentId))
      throw new AppServiceError('VALIDATION_ERROR', '已发送的附件不能移除')
    this.files.remove(attachmentId, id)
  }

  saveSettings(ai: AppConfig['ai']): AppConfig {
    if (
      !ai ||
      typeof ai.baseUrl !== 'string' ||
      typeof ai.modelId !== 'string' ||
      !ai.modelId.trim() ||
      typeof ai.apiKey !== 'string' ||
      ai.apiKey.length > 8192 ||
      typeof ai.multimodal !== 'boolean' ||
      !Number.isSafeInteger(ai.contextWindowK) ||
      ai.contextWindowK < 8 ||
      ai.contextWindowK > 2048 ||
      !Number.isSafeInteger(ai.compactThresholdPercent) ||
      ai.compactThresholdPercent < 50 ||
      ai.compactThresholdPercent > 90 ||
      !ai.baseUrl.trim()
    )
      throw new AppServiceError('VALIDATION_ERROR', '模型设置格式无效')
    let host: string
    try {
      host = new URL(ai.baseUrl).hostname
    } catch {
      throw new AppServiceError('VALIDATION_ERROR', 'AI Base URL 无效')
    }
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host) && !ai.apiKey.trim())
      throw new AppServiceError('VALIDATION_ERROR', '远程 AI 服务需要 API Key')
    return this.config.update({ ai })
  }

  send(id: string, inputParts: AgentDraftPart[], attachmentIds: string[]): Promise<void> {
    return this.track(() => this.sendMessage(id, inputParts, attachmentIds))
  }

  private async sendMessage(
    id: string,
    inputParts: AgentDraftPart[],
    attachmentIds: string[],
  ): Promise<void> {
    this.ensure(id)
    if (await this.rawPending(id))
      throw new AppServiceError('VALIDATION_ERROR', '请先回答当前问题或确认请求')
    const { message, title } = prepareUserMessage(
      inputParts,
      attachmentIds,
      this.services,
      this.config.reload().mcp.enabled,
    )
    for (const attachmentId of attachmentIds) {
      const attachment = this.files.get(attachmentId, id)
      if (attachment.mimeType.startsWith('image/') && !this.config.get().ai.multimodal)
        throw new AppServiceError('VALIDATION_ERROR', '请先启用多模态图片输入')
    }
    const row = this.db
      .prepare('SELECT title_finalized AS titleFinalized FROM agent_conversations WHERE id = ?')
      .get(id) as {
      titleFinalized: number
    }
    if (!row.titleFinalized) {
      this.db
        .prepare('UPDATE agent_conversations SET title = ?, title_finalized = 1 WHERE id = ?')
        .run(title, id)
      this.emit({ conversationId: id, kind: 'title', text: title })
    }
    await this.run(id, { messages: [message], mode: 'chat' })
  }

  compact(id: string): Promise<void> {
    return this.track(async () => {
      this.ensure(id)
      if (await this.rawPending(id))
        throw new AppServiceError('VALIDATION_ERROR', '请先完成当前待确认操作')
      await this.run(id, { mode: 'compact' })
    })
  }

  resume(id: string, answer: string[] | boolean): Promise<void> {
    return this.track(() => this.resumeConversation(id, answer))
  }

  private async resumeConversation(id: string, answer: string[] | boolean): Promise<void> {
    this.ensure(id)
    const pending = await this.rawPending(id)
    if (!pending) throw new AppServiceError('VALIDATION_ERROR', '没有等待回复的请求')
    let response: string[] | { approved: boolean; fingerprint: string }
    if (pending.kind === 'question') {
      if (
        !Array.isArray(answer) ||
        answer.length !== pending.questions.length ||
        answer.some((item) => typeof item !== 'string' || !item.trim() || item.length > 10_000)
      )
        throw new AppServiceError('VALIDATION_ERROR', '请回答全部问题，每项不超过 10000 字符')
      response = answer.map((item) => item.trim())
    } else {
      if (typeof answer !== 'boolean') throw new AppServiceError('VALIDATION_ERROR', '确认结果无效')
      response = { approved: answer, fingerprint: pending.fingerprint }
    }
    await this.run(id, new Command({ resume: response }))
  }

  cancel(id: string): void {
    this.running.get(id)?.abort()
  }

  private track<T>(action: () => Promise<T>): Promise<T> {
    if (this.closing)
      return Promise.reject(new AppServiceError('VALIDATION_ERROR', '智能体正在关闭'))
    const work = action()
    this.inFlight.add(work)
    return work.finally(() => this.inFlight.delete(work))
  }

  private async run(
    id: string,
    input: { messages?: HumanMessage[]; mode: 'chat' | 'compact' } | Command,
  ): Promise<void> {
    if (this.closing) throw new AppServiceError('VALIDATION_ERROR', '智能体正在关闭')
    if (this.running.has(id)) throw new AppServiceError('VALIDATION_ERROR', '对话正在回复中')
    const controller = new AbortController()
    this.running.set(id, controller)
    try {
      await this.runGraph(id, input, controller)
    } finally {
      this.running.delete(id)
    }
  }

  private async runGraph(
    id: string,
    input: { messages?: HumanMessage[]; mode: 'chat' | 'compact' } | Command,
    controller: AbortController,
  ): Promise<void> {
    const partialId = randomUUID()
    let partialText = ''
    try {
      const stream = await this.graph.stream(input as Parameters<typeof this.graph.stream>[0], {
        configurable: { thread_id: id },
        streamMode: ['messages', 'updates'],
        recursionLimit: 96,
        signal: controller.signal,
      })
      const startedTools = new Set<string>()
      const endedTools = new Set<string>()
      const finishTool = (message: ToolMessage): void => {
        if (endedTools.has(message.tool_call_id)) return
        endedTools.add(message.tool_call_id)
        this.emit({
          conversationId: id,
          kind: 'tool-end',
          toolCallId: message.tool_call_id,
          toolName: message.name,
          toolResult:
            typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
          toolStatus: message.status === 'error' ? 'error' : 'completed',
        })
      }
      for await (const item of stream) {
        const [mode, chunk] = item as [string, unknown]
        if (mode === 'messages') {
          const [token, metadata] = chunk as [BaseMessage, { langgraph_node?: string }]
          if (
            metadata.langgraph_node === 'agent' &&
            typeof token.content === 'string' &&
            token.content
          ) {
            this.emit({ conversationId: id, kind: 'token', text: token.content })
            partialText += token.content
          }
          if (metadata.langgraph_node === 'tools' && token instanceof ToolMessage) finishTool(token)
        } else if (mode === 'updates' && chunk && typeof chunk === 'object') {
          const update = chunk as Record<
            string,
            { messages?: BaseMessage[]; lastCompact?: unknown }
          >
          for (const message of update.agent?.messages ?? []) {
            if (!(message instanceof AIMessage)) continue
            partialText = ''
            for (const call of message.tool_calls ?? []) {
              if (!call.id || startedTools.has(call.id)) continue
              startedTools.add(call.id)
              this.emit({
                conversationId: id,
                kind: 'tool-start',
                toolCallId: call.id,
                toolName: call.name,
                toolArgs: JSON.stringify(call.args ?? {}),
              })
            }
          }
          for (const message of update.tools?.messages ?? []) {
            if (!(message instanceof ToolMessage)) continue
            finishTool(message)
          }
          const compacted = update.archive_compact?.lastCompact
          if (compacted) {
            const result = compacted as {
              id: string
              beforeTokens: number
              afterTokens: number
              usage: unknown
            }
            this.emit({
              conversationId: id,
              kind: 'compact',
              compact: {
                id: `compact:${result.id}`,
                role: 'compact',
                beforeTokens: result.beforeTokens,
                afterTokens: result.afterTokens,
                status: result.usage ? 'completed' : 'skipped',
                attachments: [],
              },
            })
          }
        }
      }
      const pending = await this.rawPending(id)
      if (pending) this.emit({ conversationId: id, kind: 'pending', pending })
      this.db
        .prepare('UPDATE agent_conversations SET updated_at = ? WHERE id = ?')
        .run(Date.now(), id)
      this.emit({ conversationId: id, kind: 'usage', usage: (await this.readHistory(id)).usage })
      this.emit({ conversationId: id, kind: 'done' })
    } catch (error) {
      this.archive.partial(id, partialId, partialText)
      if (controller.signal.aborted) {
        try {
          await this.recordCancelledTools(id)
        } catch (checkpointError) {
          console.error('保存已取消的工具调用失败', checkpointError)
        }
      }
      const message = controller.signal.aborted
        ? '已停止回复'
        : error instanceof Error
          ? error.message
          : String(error)
      this.emit({ conversationId: id, kind: 'error', text: message })
      if (!controller.signal.aborted) throw error
    }
  }

  private async recordCancelledTools(id: string): Promise<void> {
    const thread = { configurable: { thread_id: id } }
    const snapshot = await this.graph.getState(thread)
    const messages = (snapshot.values?.messages ?? []) as BaseMessage[]
    let agentIndex = messages.length - 1
    while (agentIndex >= 0 && !(messages[agentIndex] instanceof AIMessage)) agentIndex--
    if (agentIndex < 0) return
    const calls = (messages[agentIndex] as AIMessage).tool_calls ?? []
    const completed = new Set(
      messages
        .slice(agentIndex + 1)
        .filter((message): message is ToolMessage => message instanceof ToolMessage)
        .map((message) => message.tool_call_id),
    )
    const missing = calls.filter((call) => call.id && !completed.has(call.id))
    if (!missing.length) return
    await this.graph.updateState(
      thread,
      {
        messages: missing.map(
          (call) =>
            new ToolMessage({
              name: call.name,
              tool_call_id: call.id!,
              status: 'error',
              content: '用户已停止此工具调用；执行结果未知，请先读取当前数据再判断。',
            }),
        ),
      },
      'tools',
    )
    this.archive.sync(
      id,
      ((await this.graph.getState(thread)).values?.messages ?? []) as BaseMessage[],
    )
  }

  async close(): Promise<void> {
    this.closing = true
    for (const controller of this.running.values()) controller.abort()
    await Promise.allSettled([...this.inFlight])
    await this.mcp.close()
  }
}
