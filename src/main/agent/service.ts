import { randomUUID } from 'node:crypto'
import { captureError } from '../diagnostics'
import { app } from 'electron'
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
import { AppServiceError, errorShape } from '../services/errors'
import { assertUpdateWritable, isUpdateFrozen } from '../update-freeze'
import { AgentFileStore } from './files'
import { createAgentGraph } from './graph'
import { AgentArchive } from './archive'
import { AgentMcpClient } from './mcp-client'
import { prepareUserMessage } from './message'
import type { AgentRuntimeInfo } from './runtime'

type SqliteDatabase = InstanceType<typeof Database>
const UNKNOWN_TOOL_RESULT = {
  'zh-CN': {
    crashed: '执行进程意外退出；工具调用结果未知，请先读取当前数据再判断。',
    cancelled: '用户已停止此工具调用；执行结果未知，请先读取当前数据再判断。',
  },
  'en-US': {
    crashed:
      'The agent process exited unexpectedly. The tool result is unknown; read the current data before deciding what happened.',
    cancelled:
      'The user stopped this tool call. The result is unknown; read the current data before deciding what happened.',
  },
} as const

export class AgentService {
  readonly files: AgentFileStore
  private readonly saver: SqliteSaver
  private readonly mcp: AgentMcpClient
  private readonly graph: ReturnType<typeof createAgentGraph>
  private readonly archive: AgentArchive
  private readonly running = new Map<string, AbortController>()
  private readonly inFlight = new Set<Promise<unknown>>()
  private readonly inFlightByConversation = new Map<string, Set<Promise<unknown>>>()
  private closing = false
  private updateSuspended = false

  constructor(
    private readonly paths: AppPaths,
    private readonly db: SqliteDatabase,
    private readonly config: ConfigService,
    private readonly services: Services,
    connection: ConstructorParameters<typeof AgentMcpClient>[1],
    private readonly emit: (event: AgentEvent) => void,
    runtime: AgentRuntimeInfo = {
      packaged: app?.isPackaged ?? false,
      appPath: app?.getAppPath?.() ?? process.cwd(),
      resourcesPath: process.resourcesPath ?? process.cwd(),
      appVersion: app?.getVersion?.() ?? '1.0.0',
    },
  ) {
    this.files = new AgentFileStore(paths, db)
    this.archive = new AgentArchive(db, this.files)
    this.saver = new SqliteSaver(db)
    this.mcp = new AgentMcpClient(config, connection, runtime.appVersion)
    this.graph = createAgentGraph(
      config,
      services,
      this.files,
      this.mcp,
      this.saver,
      this.archive,
      runtime,
    )
  }

  list(): AgentConversation[] {
    this.assertOpen()
    return this.db
      .prepare(
        'SELECT id, title, created_at AS createdAt, updated_at AS updatedAt FROM agent_conversations WHERE deleting = 0 ORDER BY updated_at DESC',
      )
      .all() as AgentConversation[]
  }

  create(): AgentConversation {
    this.assertWritable()
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
    this.assertWritable()
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
      !this.db.prepare('SELECT 1 FROM agent_conversations WHERE id = ? AND deleting = 0').get(id)
    )
      throw new AppServiceError('NOT_FOUND', '对话不存在')
  }

  private assertOpen(): void {
    if (this.closing) throw new AppServiceError('VALIDATION_ERROR', '智能体正在关闭')
  }

  private assertWritable(): void {
    this.assertOpen()
    if (this.updateSuspended)
      throw new AppServiceError('VALIDATION_ERROR', '应用正在更新，请稍后重试')
    assertUpdateWritable(this.paths.root)
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
    return this.track(id, () => this.readHistory(id))
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
    const prior = [...(this.inFlightByConversation.get(id) ?? [])]
    return this.track(id, () => this.deleteConversation(id, prior))
  }

  private async deleteConversation(id: string, prior: Promise<unknown>[]): Promise<void> {
    this.ensure(id)
    if (this.running.has(id)) throw new AppServiceError('VALIDATION_ERROR', '请先停止当前回复')
    this.db.prepare('UPDATE agent_conversations SET deleting = 1 WHERE id = ?').run(id)
    await Promise.allSettled(prior)
    try {
      await this.finishDeletion(id)
    } catch (error) {
      // The durable marker hides the conversation; startup will retry cleanup.
      captureError(error, { operation: 'agent.conversation-cleanup' })
    }
  }

  private async finishDeletion(id: string): Promise<void> {
    // A newly created conversation has never initialized LangGraph's tables.
    if (
      this.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'checkpoints'")
        .get()
    )
      await this.saver.deleteThread(id)
    this.services.exams.deleteConversation(id)
    this.archive.delete(id)
    this.files.deleteConversation(id)
    this.db.prepare('DELETE FROM agent_conversations WHERE id = ?').run(id)
  }

  async recoverPendingDeletions(): Promise<void> {
    if (isUpdateFrozen(this.paths.root)) return
    const rows = this.db.prepare('SELECT id FROM agent_conversations WHERE deleting = 1').all() as {
      id: string
    }[]
    for (const row of rows) {
      try {
        await this.finishDeletion(row.id)
      } catch (error) {
        captureError(error, { operation: 'agent.conversation-recover' })
      }
    }
    this.files.recoverPendingDeletes()
  }

  upload(id: string, sourcePath: string): AgentAttachment {
    this.assertWritable()
    this.ensure(id)
    return this.files.import(id, sourcePath, this.config.get().ai.multimodal)
  }

  uploadBytes(id: string, name: string, mimeType: string, bytes: Uint8Array): AgentAttachment {
    this.assertWritable()
    this.ensure(id)
    return this.files.importBytes(id, name, mimeType, bytes, this.config.get().ai.multimodal)
  }

  preview(id: string, attachmentId: string): string | null {
    this.ensure(id)
    return this.files.preview(attachmentId, id)
  }

  getAttachmentPath(id: string, attachmentId: string): string {
    this.ensure(id)
    return this.files.getPath(attachmentId, id)
  }

  removeUpload(id: string, attachmentId: string): Promise<void> {
    const prior = [...(this.inFlightByConversation.get(id) ?? [])]
    return this.track(id, async () => {
      await Promise.allSettled(prior)
      await this.removePendingUpload(id, attachmentId)
    })
  }

  private async removePendingUpload(id: string, attachmentId: string): Promise<void> {
    this.ensure(id)
    if (this.running.has(id)) throw new AppServiceError('VALIDATION_ERROR', '请先停止当前回复')
    if (this.archive.usesAttachment(id, attachmentId))
      throw new AppServiceError('VALIDATION_ERROR', '已发送的附件不能移除')
    this.files.remove(attachmentId, id)
  }

  saveSettings(ai: AppConfig['ai']): AppConfig {
    this.assertWritable()
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
    return this.config.update({ ai })
  }

  send(
    id: string,
    inputParts: AgentDraftPart[],
    attachmentIds: string[],
    messageId?: string,
  ): Promise<void> {
    return this.track(id, () => this.sendMessage(id, inputParts, attachmentIds, messageId))
  }

  async validateSend(
    id: string,
    inputParts: AgentDraftPart[],
    attachmentIds: string[],
  ): Promise<void> {
    this.assertWritable()
    await this.prepareSend(id, inputParts, attachmentIds)
  }

  private async prepareSend(
    id: string,
    inputParts: AgentDraftPart[],
    attachmentIds: string[],
    messageId?: string,
  ): Promise<{ message: HumanMessage; title: string }> {
    this.ensure(id)
    if (await this.rawPending(id))
      throw new AppServiceError('VALIDATION_ERROR', '请先回答当前问题或确认请求')
    const prepared = prepareUserMessage(
      inputParts,
      attachmentIds,
      this.services,
      this.config.reload().mcp.enabled,
      messageId,
    )
    for (const attachmentId of attachmentIds) {
      const attachment = this.files.get(attachmentId, id)
      if (attachment.mimeType.startsWith('image/') && !this.config.get().ai.multimodal)
        throw new AppServiceError('VALIDATION_ERROR', '请先启用多模态图片输入')
    }
    return prepared
  }

  private async sendMessage(
    id: string,
    inputParts: AgentDraftPart[],
    attachmentIds: string[],
    messageId?: string,
  ): Promise<void> {
    const { message, title } = await this.prepareSend(id, inputParts, attachmentIds, messageId)
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
    return this.track(id, async () => {
      this.ensure(id)
      if (await this.rawPending(id))
        throw new AppServiceError('VALIDATION_ERROR', '请先完成当前待确认操作')
      await this.run(id, { mode: 'compact' })
    })
  }

  async validateCompact(id: string): Promise<void> {
    this.assertWritable()
    this.ensure(id)
    if (await this.rawPending(id))
      throw new AppServiceError('VALIDATION_ERROR', '请先完成当前待确认操作')
  }

  resume(id: string, answer: string[] | boolean): Promise<void> {
    return this.track(id, () => this.resumeConversation(id, answer))
  }

  async validateResume(id: string, answer: string[] | boolean): Promise<void> {
    this.assertWritable()
    await this.prepareResume(id, answer)
  }

  private async prepareResume(
    id: string,
    answer: string[] | boolean,
  ): Promise<string[] | { approved: boolean; fingerprint: string }> {
    this.ensure(id)
    const pending = await this.rawPending(id)
    if (!pending) throw new AppServiceError('VALIDATION_ERROR', '没有等待回复的请求')
    if (pending.kind === 'question') {
      if (
        !Array.isArray(answer) ||
        answer.length !== pending.questions.length ||
        answer.some((item) => typeof item !== 'string' || !item.trim() || item.length > 10_000)
      )
        throw new AppServiceError('VALIDATION_ERROR', '请回答全部问题，每项不超过 10000 字符')
      return answer.map((item) => item.trim())
    }
    if (typeof answer !== 'boolean') throw new AppServiceError('VALIDATION_ERROR', '确认结果无效')
    return { approved: answer, fingerprint: pending.fingerprint }
  }

  private async resumeConversation(id: string, answer: string[] | boolean): Promise<void> {
    const response = await this.prepareResume(id, answer)
    await this.run(id, new Command({ resume: response }))
  }

  async hasUserMessage(id: string, messageId: string): Promise<boolean> {
    this.ensure(id)
    const saved = () =>
      !!this.db
        .prepare('SELECT 1 FROM agent_chat_events WHERE id = ? AND conversation_id = ?')
        .get(`user:${messageId}`, id)
    if (saved()) return true
    await this.readHistory(id)
    return saved()
  }

  async recoverInterruptedRun(id: string, partialText: string): Promise<void> {
    if (!isUpdateFrozen(this.paths.root)) this.services.exams.interruptGeneration(id)
    this.ensure(id)
    await this.recordCancelledTools(id, true)
    if (partialText.trim()) this.archive.partial(id, randomUUID(), partialText)
  }

  cancel(id: string): void {
    this.running.get(id)?.abort()
  }

  private track<T>(id: string, action: () => Promise<T>): Promise<T> {
    try {
      this.assertWritable()
    } catch (error) {
      return Promise.reject(error)
    }
    const work = action()
    this.inFlight.add(work)
    const conversationWork = this.inFlightByConversation.get(id) ?? new Set<Promise<unknown>>()
    conversationWork.add(work)
    this.inFlightByConversation.set(id, conversationWork)
    return work.finally(() => {
      this.inFlight.delete(work)
      conversationWork.delete(work)
      if (!conversationWork.size) this.inFlightByConversation.delete(id)
    })
  }

  private async run(
    id: string,
    input: { messages?: HumanMessage[]; mode: 'chat' | 'compact' } | Command,
  ): Promise<void> {
    this.ensure(id)
    if (this.running.has(id)) throw new AppServiceError('VALIDATION_ERROR', '对话正在回复中')
    const controller = new AbortController()
    this.running.set(id, controller)
    try {
      await this.runGraph(id, input, controller)
    } finally {
      if (!isUpdateFrozen(this.paths.root)) this.services.exams.interruptGeneration(id)
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
        configurable: { thread_id: id, job_id: partialId },
        streamMode: ['messages', 'updates'],
        recursionLimit: 2048,
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
          captureError(checkpointError, { operation: 'agent.cancel-checkpoint' })
        }
      }
      this.emit({
        conversationId: id,
        kind: 'error',
        errorCode: controller.signal.aborted ? 'AGENT_CANCELLED' : errorShape(error).code,
      })
      if (!controller.signal.aborted) throw error
    }
  }

  private async recordCancelledTools(id: string, crashed = false): Promise<void> {
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
    const unknownResult =
      UNKNOWN_TOOL_RESULT[this.config.get().locale][crashed ? 'crashed' : 'cancelled']
    await this.graph.updateState(
      thread,
      {
        messages: missing.map(
          (call) =>
            new ToolMessage({
              name: call.name,
              tool_call_id: call.id!,
              status: 'error',
              content: unknownResult,
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

  async suspendForUpdate(): Promise<void> {
    this.updateSuspended = true
    for (const controller of this.running.values()) controller.abort()
    let timeout: ReturnType<typeof setTimeout> | undefined
    let expired = false
    try {
      await Promise.race([
        (async () => {
          await Promise.allSettled([...this.inFlight])
          // Promise.race does not cancel its losing branch. An expired attempt
          // must not close a client that resumeAfterUpdate has made available.
          if (expired) return
          // The built-in MCP client keeps its stdio server alive between calls.
          // Release its session lease before the updater waits for MCP processes.
          await this.mcp.close()
        })(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('agent_operations_did_not_stop')), 15_000)
        }),
      ])
    } catch (error) {
      expired = true
      throw error
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }

  resumeAfterUpdate(): void {
    this.updateSuspended = false
  }
}
