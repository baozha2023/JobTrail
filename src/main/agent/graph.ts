import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import { ChatOpenAI } from '@langchain/openai'
import {
  AIMessage,
  HumanMessage,
  RemoveMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages'
import { tool } from '@langchain/core/tools'
import { toJsonSchema } from '@langchain/core/utils/json_schema'
import {
  END,
  MessagesValue,
  START,
  StateGraph,
  StateSchema,
  getConfig,
  interrupt,
} from '@langchain/langgraph'
import { ToolNode, toolsCondition } from '@langchain/langgraph/prebuilt'
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite'
import { z } from 'zod'
import type { ConfigService } from '../config'
import { MCP_TOOLS } from '../mcp-contracts'
import type { Services } from '../service-container'
import { AppServiceError } from '../services/errors'
import { extractDocument, type DocumentVisual } from './document'
import { AgentFileStore, ATTACHMENT_MARKER } from './files'
import { AgentMcpClient } from './mcp-client'
import { AgentArchive } from './archive'
import { buildAgentSystemPrompt } from './prompt'

const CompactResult = z.object({
  id: z.string(),
  beforeTokens: z.number(),
  afterTokens: z.number(),
  usage: z.tuple([z.number().nullable(), z.number().nullable(), z.number().nullable()]).nullable(),
})
const AskQuestion = z.object({
  question: z.string().trim().min(1).max(1_000),
  options: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(100),
        description: z.string().trim().min(1).max(300),
        recommended: z.boolean().optional(),
      }),
    )
    .min(2)
    .max(3)
    .refine((options) => options.filter((option) => option.recommended).length <= 1)
    .optional(),
})
const State = new StateSchema({
  messages: MessagesValue,
  summary: z.string().default(''),
  mode: z.enum(['chat', 'compact']).default('chat'),
  needsCompact: z.boolean().default(false),
  contextTokens: z.number().default(0),
  lastCompact: CompactResult.nullable().default(null),
})

interface ResumeDocumentArtifact {
  kind: 'resume-document'
  resumeId: number
  textField: 'text' | 'resumeText'
}

type ModelContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

function imageTokenEstimate(messages: BaseMessage[]): number {
  // ChatOpenAI's local counter skips image_url blocks; actual usage replaces this estimate after the call.
  return messages.reduce(
    (total, message) =>
      total +
      (Array.isArray(message.content)
        ? message.content.filter((part) => typeof part === 'object' && part.type === 'image_url')
            .length * 2048
        : 0),
    0,
  )
}

function skillInstructions(): string {
  const file = app.isPackaged
    ? path.join(process.resourcesPath, 'skills', 'resume-match', 'SKILL.md')
    : path.join(app.getAppPath(), 'src', 'main', 'agent', 'skills', 'resume-match', 'SKILL.md')
  return fs.readFileSync(file, 'utf8').replace(/^---[\s\S]*?---\s*/, '')
}

export function createAgentGraph(
  config: ConfigService,
  services: Services,
  files: AgentFileStore,
  mcp: AgentMcpClient,
  saver: SqliteSaver,
  archive: AgentArchive,
) {
  return new AgentGraphFactory(config, services, files, mcp, saver, archive).makeGraph()
}

class AgentGraphFactory {
  constructor(
    private readonly config: ConfigService,
    private readonly services: Services,
    private readonly files: AgentFileStore,
    private readonly mcp: AgentMcpClient,
    private readonly saver: SqliteSaver,
    private readonly archive: AgentArchive,
  ) {}

  makeGraph() {
    const askUser = tool(
      async ({ questions }) => {
        const answers = interrupt({ kind: 'question', questions }) as string[]
        return JSON.stringify(
          questions.map(({ question }, index) => ({ question, answer: answers[index] })),
        )
      },
      {
        name: 'ask_user',
        description:
          '仅在缺少关键条件时向用户提出 1–3 个具体问题。每题可提供 2–3 个互斥选项，每个选项包含简短标签和说明；有明确推荐时给其中一项设置 recommended:true。界面始终提供“其他”自定义答案，无需将它写入选项。没有合理备选项时省略 options，使用自由输入。等待所有答案后继续。',
        schema: z.object({ questions: z.array(AskQuestion).min(1).max(3) }),
      },
    )

    const loadResume = (resumeId: number) => {
      const resume = this.services.resumes.get(resumeId)
      return { resumeId: resume.id, name: resume.name, note: resume.note }
    }
    const resumeDocumentResult = async (
      resumeId: number,
      textField: ResumeDocumentArtifact['textField'],
      payload: Record<string, unknown>,
    ): Promise<[string, ResumeDocumentArtifact]> => {
      const document = await extractDocument(
        this.services.resumes.getPath(resumeId),
        this.config.get().ai.multimodal,
      )
      payload[textField] = document.text
      if (!document.text && !document.visuals.length)
        payload.documentNotice = '没有提取到可用的文字或视觉内容，不得猜测文档内容。'
      if (document.omittedVisuals)
        payload.visualNotice = `另有 ${document.omittedVisuals} 页或图片未加入模型上下文。`
      return [JSON.stringify(payload), { kind: 'resume-document', resumeId, textField }]
    }
    const readResume = tool(
      async ({ resumeId }) => resumeDocumentResult(resumeId, 'text', loadResume(resumeId)),
      {
        name: 'read_resume',
        description:
          '按简历 ID 读取用户已导入职迹的简历名称、备注、可提取正文，以及多模态开启时可读取的页面或内嵌图片。用户要求查看、概括、评价、润色或回答简历内容问题时调用；这些单份简历任务不需要岗位或 JD。只有用户明确要求简历与岗位匹配时才使用 match_resume。',
        schema: z.object({ resumeId: z.number().int().positive() }),
        responseFormat: 'content_and_artifact',
      },
    )

    const matchResume = tool(
      async ({ resumeId, opportunityId, jd }) => {
        const resume = loadResume(resumeId)
        const storedDescription = opportunityId
          ? this.services.opportunities.get(opportunityId).description
          : undefined
        const description = storedDescription?.trim() ? storedDescription : jd
        if (!description?.trim()) return ['请先提供岗位 JD 或选择有岗位说明的求职记录。', null]
        return resumeDocumentResult(resumeId, 'resumeText', {
          skill: skillInstructions(),
          resumeName: resume.name,
          jd: description,
        })
      },
      {
        name: 'match_resume',
        description:
          '读取选定的已导入简历与岗位 JD，并加载简历相似度匹配技能。仅在 MCP 已启用且用户明确请求简历与岗位匹配、适配度或相似度分析时调用；单独引用简历或要求查看简历不属于匹配请求。',
        schema: z.object({
          resumeId: z.number().int().positive(),
          opportunityId: z.number().int().positive().optional(),
          jd: z.string().optional(),
        }),
        responseFormat: 'content_and_artifact',
      },
    )

    const mcpTools = MCP_TOOLS.map((descriptor) =>
      tool(
        async (args) =>
          this.mcp.call(descriptor.name, args as Record<string, unknown>, getConfig().signal),
        {
          name: descriptor.name,
          description: descriptor.description,
          schema: descriptor.inputSchema,
        },
      ),
    )
    const allTools = [askUser, readResume, matchResume, ...mcpTools]
    const toolNode = new ToolNode(allTools)
    const parallelReadTools = new Set([
      'match_resume',
      'read_resume',
      ...MCP_TOOLS.filter((descriptor) => descriptor.readOnly).map((descriptor) => descriptor.name),
    ])
    const pendingTools = (state: typeof State.State) => {
      let agentIndex = state.messages.length - 1
      while (agentIndex >= 0 && !(state.messages[agentIndex] instanceof AIMessage)) agentIndex--
      if (agentIndex < 0) return []
      const lastAgent = state.messages[agentIndex] as AIMessage
      const completed = new Set(
        state.messages
          .slice(agentIndex + 1)
          .filter((message): message is ToolMessage => message instanceof ToolMessage)
          .map((message) => message.tool_call_id),
      )
      return (lastAgent.tool_calls ?? []).filter((call) => !completed.has(call.id ?? ''))
    }
    const runTool = async (state: typeof State.State) => {
      const calls = pendingTools(state)
      if (!calls.length) throw new Error('没有待执行的工具调用')
      // ToolNode executes independent reads concurrently. Confirmation-producing
      // calls stay ordered so an interrupted write cannot replay another write.
      const batch = [] as typeof calls
      for (const call of calls) {
        if (batch.length && !parallelReadTools.has(call.name)) break
        batch.push(call)
        if (!parallelReadTools.has(call.name)) break
      }
      return toolNode.invoke(
        { messages: [new AIMessage({ content: '', tool_calls: batch })] },
        getConfig(),
      )
    }
    const modelNode = async (state: typeof State.State) => {
      const settings = this.config.reload()
      const model = this.model()
      const availableTools = settings.mcp.enabled ? allTools : [askUser]
      const conversationId = String(getConfig()?.configurable?.thread_id ?? '')
      const recent = await this.prepareMessages(state.messages, conversationId)
      const response = await model
        .bindTools(availableTools)
        .invoke([this.system(settings.mcp.enabled, state.summary), ...recent])
      const ids = response.tool_calls?.map((call) => call.id)
      if (ids?.some((id) => !id) || (ids && new Set(ids).size !== ids.length))
        throw new Error('模型返回了缺少或重复 ID 的工具调用')
      return { messages: [response] }
    }
    const archiveNode = async (state: typeof State.State) => {
      this.archive.sync(String(getConfig()?.configurable?.thread_id ?? ''), state.messages)
      return {}
    }
    const preflight = async (state: typeof State.State) => {
      const settings = this.config.reload()
      const model = this.model()
      const conversationId = String(getConfig()?.configurable?.thread_id ?? '')
      const prepared = await this.prepareMessages(state.messages, conversationId)
      const availableTools = settings.mcp.enabled ? allTools : [askUser]
      const tokens = await this.countContext(
        model,
        this.system(settings.mcp.enabled, state.summary),
        prepared,
        availableTools,
      )
      const limit = settings.ai.contextWindowK * 1000
      const hasOlderTurn =
        state.messages.filter((message) => message instanceof HumanMessage).length > 1
      if (!hasOlderTurn && tokens >= limit)
        throw new AppServiceError(
          'VALIDATION_ERROR',
          '当前单轮内容超出上下文窗口，请缩短输入或附件',
        )
      return {
        contextTokens: tokens,
        needsCompact: hasOlderTurn && tokens >= (limit * settings.ai.compactThresholdPercent) / 100,
      }
    }
    const compactNode = async (state: typeof State.State) => {
      const conversationId = String(getConfig()?.configurable?.thread_id ?? '')
      const settings = this.config.reload()
      return this.compact(state, conversationId, settings.mcp.enabled ? allTools : [askUser])
    }
    const archiveCompact = async (state: typeof State.State) => {
      const result = state.lastCompact
      if (!result) throw new Error('压缩结果缺失')
      this.archive.compact(
        String(getConfig()?.configurable?.thread_id ?? ''),
        result.id,
        result.beforeTokens,
        result.afterTokens,
        result.usage ?? undefined,
      )
      return { lastCompact: result }
    }
    return new StateGraph(State)
      .addNode('archive_input', archiveNode)
      .addNode('preflight', preflight)
      .addNode('compact', compactNode)
      .addNode('archive_compact', archiveCompact)
      .addNode('agent', modelNode)
      .addNode('archive_agent', archiveNode)
      .addNode('tools', runTool)
      .addNode('archive_tools', archiveNode)
      .addEdge(START, 'archive_input')
      .addEdge('archive_input', 'preflight')
      .addConditionalEdges(
        'preflight',
        (state) => (state.mode === 'compact' || state.needsCompact ? 'compact' : 'agent'),
        {
          compact: 'compact',
          agent: 'agent',
        },
      )
      .addEdge('compact', 'archive_compact')
      .addConditionalEdges(
        'archive_compact',
        (state) => (state.mode === 'compact' ? END : 'agent'),
        {
          [END]: END,
          agent: 'agent',
        },
      )
      .addEdge('agent', 'archive_agent')
      .addConditionalEdges('archive_agent', toolsCondition, { tools: 'tools', [END]: END })
      .addEdge('tools', 'archive_tools')
      .addConditionalEdges(
        'archive_tools',
        (state) => (pendingTools(state).length ? 'tools' : 'preflight'),
        {
          tools: 'tools',
          preflight: 'preflight',
        },
      )
      .compile({ checkpointer: this.saver })
  }

  private model(maxTokens?: number): ChatOpenAI {
    const ai = this.config.reload().ai
    if (!ai.modelId) throw new AppServiceError('VALIDATION_ERROR', '请先在设置中填写 AI 模型 ID')
    const endpoint = new URL(ai.baseUrl)
    if (!['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname) && !ai.apiKey)
      throw new AppServiceError('VALIDATION_ERROR', '远程 AI 服务需要 API Key')
    return new ChatOpenAI({
      model: ai.modelId,
      apiKey: ai.apiKey || 'local',
      useResponsesApi: false,
      streamUsage: true,
      maxTokens,
      configuration: { baseURL: ai.baseUrl },
    })
  }

  private system(mcpEnabled: boolean, summary: string): SystemMessage {
    return new SystemMessage(buildAgentSystemPrompt({ mcpEnabled, summary }))
  }

  private async countContext(
    model: ChatOpenAI,
    system: SystemMessage,
    messages: BaseMessage[],
    tools: unknown[],
  ): Promise<number> {
    const messageTokens = (await model.getNumTokensFromMessages([system, ...messages])).totalCount
    const toolTokens = await model.getNumTokens(
      JSON.stringify(
        tools.map((item) => {
          const candidate = item as {
            name: string
            description: string
            schema?: Parameters<typeof toJsonSchema>[0]
          }
          return {
            name: candidate.name,
            description: candidate.description,
            schema: candidate.schema ? toJsonSchema(candidate.schema) : undefined,
          }
        }),
      ),
    )
    return messageTokens + toolTokens + imageTokenEstimate(messages)
  }

  private async compact(
    state: typeof State.State,
    conversationId: string,
    availableTools: unknown[],
  ) {
    const settings = this.config.reload()
    const windowTokens = settings.ai.contextWindowK * 1000
    const model = this.model()
    const fixedContextTokens = await this.countContext(
      model,
      this.system(settings.mcp.enabled, state.summary),
      [],
      availableTools,
    )
    const keepBudget = Math.max(0, Math.floor(windowTokens * 0.5) - fixedContextTokens)
    const turns: BaseMessage[][] = []
    for (const message of state.messages) {
      if (message instanceof HumanMessage) turns.push([])
      if (turns.length) turns.at(-1)!.push(message)
    }
    const keep: BaseMessage[][] = []
    let keepTokens = 0
    for (let index = turns.length - 1; index >= 0; index--) {
      if (state.mode === 'compact' && keep.length) break
      const prepared = await this.prepareMessages(turns[index], conversationId)
      const tokens =
        (await model.getNumTokensFromMessages(prepared)).totalCount + imageTokenEstimate(prepared)
      if (keepTokens + tokens > keepBudget) {
        // Automatic compaction runs after the new user turn has entered the graph, so
        // that unanswered turn must remain intact and the final budget check should
        // report when it cannot fit. A manual compaction has no unfinished turn and
        // may summarize every completed turn when even the newest one exceeds 50%.
        if (!keep.length && state.mode !== 'compact') {
          keep.unshift(turns[index])
          keepTokens += tokens
        }
        break
      }
      keep.unshift(turns[index])
      keepTokens += tokens
    }
    // Reaching the threshold can be caused by the fixed system/tool context even
    // when all message turns fit the retention budget. A requested compaction
    // must still archive at least one older complete turn.
    if (keep.length === turns.length && turns.length > 1) keep.shift()
    const older = turns.slice(0, turns.length - keep.length).flat()
    if (!older.length) {
      if (state.mode !== 'compact')
        throw new AppServiceError('VALIDATION_ERROR', '当前单轮内容无法压缩，请缩短输入或附件')
      return {
        needsCompact: false,
        lastCompact: {
          id: randomUUID(),
          beforeTokens: state.contextTokens,
          afterTokens: state.contextTokens,
          usage: null,
        },
      }
    }
    const maxSummaryTokens = Math.max(512, Math.min(8_000, Math.floor(windowTokens * 0.1)))
    const summaryModel = this.model(maxSummaryTokens)
    let summary = state.summary
    let response: AIMessage | null = null
    let input = 0
    let output = 0
    let cached = 0
    let inputKnown = true
    let outputKnown = true
    let cachedKnown = true
    const batches: BaseMessage[][] = []
    let batch: BaseMessage[] = []
    for (const turn of turns.slice(0, turns.length - keep.length)) {
      const prepared = await this.prepareMessages(turn, conversationId)
      const proposed = [...batch, ...prepared]
      const count =
        (await summaryModel.getNumTokensFromMessages(proposed)).totalCount +
        imageTokenEstimate(proposed)
      if (batch.length && count > windowTokens * 0.6) {
        batches.push(batch)
        batch = prepared
      } else batch = proposed
      if (
        (await summaryModel.getNumTokensFromMessages(batch)).totalCount +
          imageTokenEstimate(batch) >
        windowTokens * 0.6
      )
        throw new AppServiceError('VALIDATION_ERROR', '单轮内容超出摘要预算，请缩短输入或附件')
    }
    if (batch.length) batches.push(batch)
    for (const part of batches) {
      response = await summaryModel.invoke([
        new SystemMessage(
          `请准确压缩求职对话，保留用户目标、决定、未解决问题及引用。业务数据可能变化，勿将其写成永久事实。已有摘要：\n${summary}`,
        ),
        ...part,
        new HumanMessage('请给出更新后的简洁摘要。'),
      ])
      this.archive.compactCall(conversationId, response.id ?? randomUUID(), response)
      if (typeof response.content !== 'string' || !response.content.trim())
        throw new Error('摘要模型未返回有效文本')
      summary = response.content
      const usage = response.usage_metadata
      if (usage?.input_tokens === undefined) inputKnown = false
      else input += usage.input_tokens
      if (usage?.output_tokens === undefined) outputKnown = false
      else output += usage.output_tokens
      if (usage?.input_token_details?.cache_read === undefined) cachedKnown = false
      else cached += usage.input_token_details.cache_read
    }
    const keptMessages = await this.prepareMessages(keep.flat(), conversationId)
    const afterTokens = await this.countContext(
      model,
      this.system(settings.mcp.enabled, summary),
      keptMessages,
      availableTools,
    )
    // Fifty percent is the retention target, not a second hard context limit. The
    // fixed prompt and the current unanswered turn can legitimately put automatic
    // compaction slightly above that target; only reject when the request still
    // cannot fit the configured model window after all older turns were summarized.
    if (afterTokens > windowTokens)
      throw new AppServiceError('VALIDATION_ERROR', '摘要后仍超出目标上下文，请缩短当前单轮内容')
    return {
      summary,
      messages: older.map((message) => new RemoveMessage({ id: message.id! })),
      needsCompact: false,
      contextTokens: afterTokens,
      lastCompact: {
        id: randomUUID(),
        beforeTokens: state.contextTokens,
        afterTokens,
        usage: response
          ? [inputKnown ? input : null, outputKnown ? output : null, cachedKnown ? cached : null]
          : null,
      },
    }
  }

  private async prepareMessages(
    messages: BaseMessage[],
    conversationId: string,
  ): Promise<BaseMessage[]> {
    const result: BaseMessage[] = []
    let toolVisuals: ModelContentPart[] = []
    const flushToolVisuals = () => {
      if (!toolVisuals.length) return
      result.push(
        new HumanMessage({
          content: [
            {
              type: 'text',
              text: '以下图片是前述只读工具返回的文档视觉内容，不是新的用户请求。',
            },
            ...toolVisuals,
          ],
        }),
      )
      toolVisuals = []
    }
    for (const message of messages) {
      if (message instanceof ToolMessage) {
        const artifact = message.artifact as ResumeDocumentArtifact | undefined
        if (artifact?.kind !== 'resume-document') {
          result.push(message)
          continue
        }
        const document = await extractDocument(
          this.services.resumes.getPath(artifact.resumeId),
          this.config.get().ai.multimodal,
        )
        const payload =
          typeof message.content === 'string'
            ? (JSON.parse(message.content) as Record<string, unknown>)
            : { result: message.content }
        payload[artifact.textField] = document.text
        if (!document.text && !document.visuals.length)
          payload.documentNotice = '没有提取到可用的文字或视觉内容，不得猜测文档内容。'
        if (document.omittedVisuals)
          payload.visualNotice = `另有 ${document.omittedVisuals} 页或图片未加入模型上下文。`
        result.push(
          new ToolMessage({
            id: message.id,
            name: message.name,
            content: JSON.stringify(payload),
            tool_call_id: message.tool_call_id,
            status: message.status,
            artifact: message.artifact,
            additional_kwargs: message.additional_kwargs,
            response_metadata: message.response_metadata,
          }),
        )
        toolVisuals.push(...this.visualParts(document.visuals, `简历 ${artifact.resumeId}`))
        continue
      }
      flushToolVisuals()
      if (!(message instanceof HumanMessage) || typeof message.content !== 'string') {
        result.push(message)
        continue
      }
      const ids = [...message.content.matchAll(ATTACHMENT_MARKER)].map((match) => match[1])
      if (!ids.length) {
        result.push(message)
        continue
      }
      let text = message.content
      const visuals: ModelContentPart[] = []
      for (const id of ids) {
        try {
          const content = await this.files.content(
            id,
            conversationId,
            this.config.get().ai.multimodal,
          )
          if (content.kind === 'document') {
            if (content.document.text) text += `\n\n[附件 ${id} 提取文字]\n${content.document.text}`
            if (!content.document.text && !content.document.visuals.length)
              text += `\n\n[附件 ${id} 未提取到可用内容，请勿猜测其内容]`
            if (content.document.omittedVisuals)
              text += `\n[附件 ${id} 另有 ${content.document.omittedVisuals} 页或图片未加入模型上下文]`
            visuals.push(...this.visualParts(content.document.visuals, `附件 ${id}`))
          } else if (this.config.get().ai.multimodal)
            visuals.push({ type: 'image_url', image_url: { url: content.dataUrl } })
        } catch {
          text += `\n[附件 ${id} 未提取到可用内容，请勿猜测其内容]`
        }
      }
      result.push(
        new HumanMessage({
          id: message.id,
          content: visuals.length ? [{ type: 'text', text }, ...visuals] : text,
        }),
      )
    }
    flushToolVisuals()
    return result
  }

  private visualParts(visuals: DocumentVisual[], source: string): ModelContentPart[] {
    return visuals.flatMap((visual) => [
      { type: 'text', text: `[${source} · ${visual.label}]` },
      {
        type: 'image_url',
        image_url: { url: `data:${visual.mimeType};base64,${visual.data.toString('base64')}` },
      },
    ])
  }
}
