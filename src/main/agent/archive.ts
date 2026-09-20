import type Database from 'better-sqlite3'
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages'
import type { AgentMessage, AgentUsage } from '../../shared/types'
import { ATTACHMENT_MARKER, AgentFileStore } from './files'

type SqliteDatabase = InstanceType<typeof Database>
type StoredMessage = AgentMessage & { attachmentIds?: string[] }

function usageValues(message: AIMessage): [number | null, number | null, number | null] {
  const usage = message.usage_metadata
  return [
    usage?.input_tokens ?? null,
    usage?.output_tokens ?? null,
    usage?.input_token_details?.cache_read ?? null,
  ]
}

export class AgentArchive {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly files: AgentFileStore,
  ) {}

  private insert(id: string, conversationId: string, message: StoredMessage): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO agent_chat_events (id, conversation_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, conversationId, message.role, JSON.stringify(message), Date.now())
  }

  private recordUsage(
    id: string,
    conversationId: string,
    kind: 'agent' | 'compact',
    values: [number | null, number | null, number | null],
  ): void {
    const [input, output, cached] = values
    const inserted = this.db
      .prepare(
        'INSERT OR IGNORE INTO agent_model_usage (id, conversation_id, kind, input_tokens, output_tokens, cache_read_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, conversationId, kind, input, output, cached, Date.now())
    if (inserted.changes)
      this.db
        .prepare(
          'UPDATE agent_conversations SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, cache_read_tokens = cache_read_tokens + ? WHERE id = ?',
        )
        .run(input ?? 0, output ?? 0, cached ?? 0, conversationId)
  }

  sync(conversationId: string, messages: BaseMessage[]): void {
    this.db.transaction(() => {
      for (const message of messages) {
        if (!message.id) throw new Error('LangGraph 消息缺少 ID，无法归档')
        if (message instanceof HumanMessage) {
          if (typeof message.content !== 'string') throw new Error('用户消息正文格式无效')
          const parts = message.additional_kwargs?.jobtrailParts
          if (!Array.isArray(parts)) throw new Error('用户消息缺少结构化正文')
          const attachmentIds = [...message.content.matchAll(ATTACHMENT_MARKER)].map(
            (match) => match[1],
          )
          this.insert(`user:${message.id}`, conversationId, {
            id: message.id,
            role: 'user',
            parts,
            attachments: [],
            attachmentIds,
          })
        } else if (message instanceof AIMessage) {
          const content =
            typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
          if (content.trim())
            this.insert(`assistant:${message.id}`, conversationId, {
              id: `${message.id}:text`,
              role: 'assistant',
              text: content,
              attachments: [],
            })
          for (const call of message.tool_calls ?? []) {
            if (!call.id) throw new Error('工具调用缺少 ID，无法归档')
            this.insert(`tool:${call.id}`, conversationId, {
              id: `tool:${call.id}`,
              role: 'tool',
              toolCallId: call.id,
              name: call.name,
              args: JSON.stringify(call.args ?? {}),
              result: null,
              status: 'running',
              attachments: [],
            })
          }
          this.recordUsage(`agent:${message.id}`, conversationId, 'agent', usageValues(message))
        } else if (message instanceof ToolMessage) {
          const row = this.db
            .prepare('SELECT payload FROM agent_chat_events WHERE id = ? AND conversation_id = ?')
            .get(`tool:${message.tool_call_id}`, conversationId) as { payload: string } | undefined
          if (!row) throw new Error('工具结果缺少对应的归档调用')
          const tool = JSON.parse(row.payload) as Extract<AgentMessage, { role: 'tool' }>
          tool.result =
            typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
          tool.status = message.status === 'error' ? 'error' : 'completed'
          this.db
            .prepare(
              'UPDATE agent_chat_events SET payload = ? WHERE id = ? AND conversation_id = ?',
            )
            .run(JSON.stringify(tool), `tool:${message.tool_call_id}`, conversationId)
        }
      }
    })()
  }

  compact(
    conversationId: string,
    id: string,
    beforeTokens: number,
    afterTokens: number,
    usage?: [number | null, number | null, number | null],
  ): AgentMessage {
    const message: Extract<AgentMessage, { role: 'compact' }> = {
      id: `compact:${id}`,
      role: 'compact',
      beforeTokens,
      afterTokens,
      status: usage ? 'completed' : 'skipped',
      attachments: [],
    }
    this.insert(message.id, conversationId, message)
    return message
  }

  compactCall(conversationId: string, id: string, response: AIMessage): void {
    this.db.transaction(() => {
      this.recordUsage(`compact-call:${id}`, conversationId, 'compact', usageValues(response))
    })()
  }

  partial(conversationId: string, id: string, text: string): void {
    if (!text.trim()) return
    this.insert(`partial:${id}`, conversationId, {
      id: `partial:${id}`,
      role: 'assistant',
      text,
      incomplete: true,
      attachments: [],
    })
  }

  messages(conversationId: string): AgentMessage[] {
    const rows = this.db
      .prepare('SELECT payload FROM agent_chat_events WHERE conversation_id = ? ORDER BY seq')
      .all(conversationId) as { payload: string }[]
    return rows.map(({ payload }) => {
      const message = JSON.parse(payload) as StoredMessage
      if (message.role === 'user') {
        message.attachments = (message.attachmentIds ?? []).map((id) =>
          this.files.get(id, conversationId),
        )
        delete message.attachmentIds
      }
      return message
    })
  }

  usage(
    conversationId: string,
    contextWindowTokens: number,
    contextTokens: number | null,
    contextEstimated: boolean,
  ): AgentUsage {
    const row = this.db
      .prepare(
        'SELECT input_tokens AS inputTokens, output_tokens AS outputTokens, cache_read_tokens AS cacheReadTokens FROM agent_conversations WHERE id = ?',
      )
      .get(conversationId) as { inputTokens: number; outputTokens: number; cacheReadTokens: number }
    const missing = this.db
      .prepare(
        'SELECT COUNT(*) AS calls, SUM(input_tokens IS NULL) AS inputMissing, SUM(output_tokens IS NULL) AS outputMissing, SUM(cache_read_tokens IS NULL) AS cacheMissing FROM agent_model_usage WHERE conversation_id = ?',
      )
      .get(conversationId) as {
      calls: number
      inputMissing: number | null
      outputMissing: number | null
      cacheMissing: number | null
    }
    return {
      inputTokens: missing.inputMissing ? null : row.inputTokens,
      outputTokens: missing.outputMissing ? null : row.outputTokens,
      cacheReadTokens: missing.cacheMissing ? null : row.cacheReadTokens,
      contextTokens,
      contextEstimated,
      contextWindowTokens,
    }
  }

  latestAgentInput(conversationId: string): number | null {
    const row = this.db
      .prepare(
        "SELECT input_tokens AS inputTokens FROM agent_model_usage WHERE conversation_id = ? AND kind = 'agent' ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .get(conversationId) as { inputTokens: number | null } | undefined
    return row?.inputTokens ?? null
  }

  lastEventKind(conversationId: string): string | null {
    const row = this.db
      .prepare(
        "SELECT kind FROM agent_chat_events WHERE conversation_id = ? AND kind IN ('assistant', 'tool', 'compact') ORDER BY seq DESC LIMIT 1",
      )
      .get(conversationId) as { kind: string } | undefined
    return row?.kind ?? null
  }

  usesAttachment(conversationId: string, attachmentId: string): boolean {
    const rows = this.db
      .prepare("SELECT payload FROM agent_chat_events WHERE conversation_id = ? AND kind = 'user'")
      .all(conversationId) as { payload: string }[]
    return rows.some(({ payload }) =>
      (JSON.parse(payload) as StoredMessage).attachmentIds?.includes(attachmentId),
    )
  }

  delete(conversationId: string): void {
    this.db.prepare('DELETE FROM agent_chat_events WHERE conversation_id = ?').run(conversationId)
    this.db.prepare('DELETE FROM agent_model_usage WHERE conversation_id = ?').run(conversationId)
  }
}
