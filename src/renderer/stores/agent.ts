import { defineStore } from 'pinia'
import { reactive, ref } from 'vue'
import type {
  AgentAttachment,
  AgentConversation,
  AgentDraftPart,
  AgentEvent,
  AgentHistory,
  AgentMessage,
  AgentPending,
  AgentUsage,
} from '../../shared/types'
import { getErrorMessage } from '../utils/errors'
import { i18n } from '../i18n'
import { reportRendererFault } from '../diagnostics'

type AgentActivity = NonNullable<AgentConversation['activity']>
interface SubmittedMessage {
  jobId: string
  parts: AgentDraftPart[]
  attachments: AgentAttachment[]
}
export interface AgentSession {
  messages: AgentMessage[]
  usage: AgentUsage | null
  pending: AgentPending | null
  uploads: AgentAttachment[]
  draftParts: AgentDraftPart[]
  draftVersion: number
  activity: AgentActivity
  queuePosition?: number
  compacting: boolean
  error: string
  jobId: string | null
  sequence: number
  submitted: SubmittedMessage | null
  unverified: boolean
  verifying: boolean
  historyRequest: number
  answerSelection: (number | null)[]
  answerText: string[]
  questionStep: number
}

function emptySession(): AgentSession {
  return {
    messages: [],
    usage: null,
    pending: null,
    uploads: [],
    draftParts: [],
    draftVersion: 0,
    activity: 'idle',
    compacting: false,
    error: '',
    jobId: null,
    sequence: 0,
    submitted: null,
    unverified: false,
    verifying: false,
    historyRequest: 0,
    answerSelection: [],
    answerText: [],
    questionStep: 0,
  }
}

function showPending(session: AgentSession, pending: AgentPending | null): void {
  session.pending = pending
  session.questionStep = 0
  session.answerSelection =
    pending?.kind === 'question'
      ? pending.questions.map((question) => {
          const recommended = question.options?.findIndex((option) => option.recommended)
          return recommended !== undefined && recommended >= 0 ? recommended : null
        })
      : []
  session.answerText = pending?.kind === 'question' ? pending.questions.map(() => '') : []
}

export const useAgentStore = defineStore('agent', () => {
  const conversations = ref<AgentConversation[]>([])
  const currentId = ref<string | null>(null)
  const sessions = reactive<Record<string, AgentSession>>({})
  let unsubscribe: (() => void) | undefined
  let started: Promise<void> | undefined

  function session(id: string): AgentSession {
    return (sessions[id] ??= emptySession())
  }

  async function start(): Promise<void> {
    if (started) return started
    unsubscribe = window.zhijiApi.agent.onEvent(receiveEvent)
    started = refreshList().catch((cause) => {
      unsubscribe?.()
      unsubscribe = undefined
      started = undefined
      throw cause
    })
    return started
  }

  function stop(): void {
    unsubscribe?.()
    unsubscribe = undefined
    started = undefined
  }

  async function refreshList(): Promise<void> {
    const rows = await window.zhijiApi.agent.list()
    conversations.value = rows.map((row) => {
      const known = sessions[row.id]
      if (!known || !known.jobId) {
        session(row.id).activity = row.activity ?? 'idle'
        session(row.id).queuePosition = row.queuePosition
      }
      return row
    })
  }

  function applyHistory(id: string, history: AgentHistory): void {
    const state = session(id)
    const job = history.job
    if (job && state.jobId === job.jobId && state.sequence > job.sequence) return
    const messages = [...history.messages]
    if (job?.submittedParts && !messages.some((message) => message.id === job.jobId)) {
      state.submitted = {
        jobId: job.jobId,
        parts: job.submittedParts,
        attachments: job.submittedAttachments ?? [],
      }
      messages.push({
        id: `optimistic:${job.jobId}`,
        role: 'user',
        parts: job.submittedParts,
        attachments: job.submittedAttachments ?? [],
      })
    }
    if (job?.liveText)
      messages.push({
        id: `live:${job.jobId}`,
        role: 'assistant',
        text: job.liveText,
        attachments: [],
      })
    state.messages = messages
    state.usage = history.usage
    if (JSON.stringify(state.pending) !== JSON.stringify(history.pending))
      showPending(state, history.pending)
    state.jobId = job?.jobId ?? null
    state.sequence = job?.sequence ?? 0
    state.activity =
      job?.status === 'queued' || job?.status === 'running'
        ? job.status
        : history.pending
          ? 'waiting'
          : 'idle'
    state.queuePosition = job?.queuePosition
    if (!job) state.compacting = false
    if (
      !job &&
      state.submitted &&
      messages.some((message) => message.id === state.submitted!.jobId)
    ) {
      state.submitted = null
      state.unverified = false
    }
  }

  async function loadHistory(id: string): Promise<void> {
    const state = session(id)
    const request = ++state.historyRequest
    const jobAtRequest = state.jobId
    const history = await window.zhijiApi.agent.history(id)
    if (state.historyRequest !== request || state.jobId !== jobAtRequest) return
    applyHistory(id, history)
  }

  async function select(id: string): Promise<void> {
    currentId.value = id
    await loadHistory(id)
  }

  async function create(): Promise<string> {
    const conversation = await window.zhijiApi.agent.create()
    session(conversation.id)
    await refreshList()
    await select(conversation.id)
    return conversation.id
  }

  async function remove(id: string): Promise<void> {
    await window.zhijiApi.agent.delete(id)
    delete sessions[id]
    await refreshList()
    if (currentId.value === id) {
      currentId.value = conversations.value[0]?.id ?? null
      if (currentId.value) await loadHistory(currentId.value)
    }
  }

  function restoreSubmission(id: string, submitted: SubmittedMessage): void {
    const state = session(id)
    state.messages = state.messages.filter(
      (message) => message.id !== `optimistic:${submitted.jobId}`,
    )
    state.uploads = submitted.attachments
    state.draftParts = submitted.parts
    state.draftVersion++
    state.submitted = null
    state.unverified = false
    state.activity = 'idle'
    state.jobId = null
  }

  async function verifySubmission(id: string): Promise<void> {
    const state = session(id)
    const submitted = state.submitted
    if (!submitted || state.verifying) return
    state.verifying = true
    try {
      const history = await window.zhijiApi.agent.history(id)
      if (
        history.messages.some(
          (message) => message.role === 'user' && message.id === submitted.jobId,
        )
      ) {
        state.submitted = null
        state.unverified = false
        applyHistory(id, history)
        state.error = ''
      } else if (history.job?.jobId !== submitted.jobId) {
        restoreSubmission(id, submitted)
        state.error = i18n.global.t('agent.sendNotSaved')
      } else state.unverified = true
    } catch (cause) {
      if (state.sequence === 0) state.activity = 'idle'
      state.unverified = true
      state.error = i18n.global.t('agent.sendUnverified')
      reportRendererFault('agent.verify-submission', cause)
    } finally {
      state.verifying = false
    }
  }

  async function send(
    id: string,
    parts: AgentDraftPart[],
    attachments: AgentAttachment[],
  ): Promise<void> {
    const state = session(id)
    if (
      state.activity === 'running' ||
      state.activity === 'queued' ||
      state.pending ||
      state.unverified
    )
      return
    const jobId = crypto.randomUUID()
    state.submitted = { jobId, parts, attachments }
    state.messages.push({
      id: `optimistic:${jobId}`,
      role: 'user',
      parts,
      attachments,
    })
    state.uploads = []
    state.draftParts = []
    state.activity = 'queued'
    state.jobId = jobId
    state.sequence = 0
    state.error = ''
    let receipt
    try {
      receipt = await window.zhijiApi.agent.send(
        id,
        parts,
        attachments.map((attachment) => attachment.id),
        jobId,
      )
    } catch (cause) {
      state.error = getErrorMessage(cause, i18n.global.t)
      await verifySubmission(id)
      return
    }
    if (state.jobId === jobId && state.sequence === 0)
      state.activity = receipt.status === 'running' ? 'running' : 'queued'
    void refreshList().catch((cause) => reportRendererFault('agent.refresh-list', cause))
  }

  async function compact(id: string, parts: AgentDraftPart[]): Promise<void> {
    const state = session(id)
    if (state.activity === 'running' || state.activity === 'queued') return
    const jobId = crypto.randomUUID()
    state.activity = 'queued'
    state.compacting = true
    state.jobId = jobId
    state.sequence = 0
    state.draftParts = []
    state.error = ''
    try {
      await window.zhijiApi.agent.compact(id, jobId)
    } catch (cause) {
      state.activity = 'idle'
      state.compacting = false
      state.jobId = null
      state.draftParts = parts
      state.draftVersion++
      state.error = getErrorMessage(cause, i18n.global.t)
    }
  }

  async function resume(id: string, answer: string[] | boolean): Promise<void> {
    const state = session(id)
    if (!state.pending || state.activity === 'running' || state.activity === 'queued') return
    const prior = state.pending
    const jobId = crypto.randomUUID()
    state.pending = null
    state.activity = 'queued'
    state.jobId = jobId
    state.sequence = 0
    state.error = ''
    try {
      await window.zhijiApi.agent.resume(id, answer, jobId)
    } catch (cause) {
      state.pending = prior
      state.activity = 'waiting'
      state.jobId = null
      state.error = getErrorMessage(cause, i18n.global.t)
    }
  }

  async function cancel(id: string): Promise<void> {
    try {
      await window.zhijiApi.agent.cancel(id)
    } catch (cause) {
      session(id).error = getErrorMessage(cause, i18n.global.t)
    }
  }

  function receiveEvent(event: AgentEvent): void {
    const state = session(event.conversationId)
    if (event.jobId) {
      if (state.jobId && state.jobId !== event.jobId && state.activity !== 'idle') return
      if (state.jobId !== event.jobId) {
        state.jobId = event.jobId
        state.sequence = 0
      }
      if (event.sequence !== undefined) {
        if (event.sequence <= state.sequence) return
        if (state.sequence && event.sequence !== state.sequence + 1)
          void loadHistory(event.conversationId).catch((cause) =>
            reportRendererFault('agent.load-history', cause),
          )
        state.sequence = event.sequence
      }
    }
    if (event.kind === 'title' && event.text) {
      const conversation = conversations.value.find((item) => item.id === event.conversationId)
      if (conversation) conversation.title = event.text
    } else if (event.kind === 'token' && event.text) {
      const last = state.messages.at(-1)
      if (last?.role === 'assistant' && last.id.startsWith(`live:${event.jobId}`))
        last.text += event.text
      else
        state.messages.push({
          id: `live:${event.jobId}:${event.sequence ?? Date.now()}`,
          role: 'assistant',
          text: event.text,
          attachments: [],
        })
    } else if (event.kind === 'tool-start' && event.toolCallId) {
      if (
        !state.messages.some(
          (message) => message.role === 'tool' && message.toolCallId === event.toolCallId,
        )
      )
        state.messages.push({
          id: `tool:${event.toolCallId}`,
          role: 'tool',
          toolCallId: event.toolCallId,
          name: event.toolName ?? '',
          args: event.toolArgs ?? '{}',
          result: null,
          status: 'running',
          attachments: [],
        })
    } else if (event.kind === 'tool-end' && event.toolCallId) {
      const tool = [...state.messages]
        .reverse()
        .find((message) => message.role === 'tool' && message.toolCallId === event.toolCallId)
      if (tool?.role === 'tool') {
        tool.status = event.toolStatus ?? 'completed'
        tool.result = event.toolResult ?? ''
      }
    } else if (event.kind === 'pending') {
      showPending(state, event.pending ?? null)
    } else if (event.kind === 'usage' && event.usage) {
      state.usage = event.usage
    } else if (event.kind === 'compact' && event.compact) {
      state.compacting = false
      state.messages.push(event.compact)
    } else if (event.kind === 'error') {
      state.error = i18n.global.t(`error.${event.errorCode ?? 'generic'}`)
      if (event.submissionState === 'not-saved' && state.submitted)
        restoreSubmission(event.conversationId, state.submitted)
      else if (event.submissionState === 'unknown') state.unverified = true
    } else if (event.kind === 'state') {
      state.activity = event.state ?? 'idle'
      state.queuePosition = event.queuePosition
      if (event.submissionState === 'not-saved' && state.submitted) {
        restoreSubmission(event.conversationId, state.submitted)
        state.error = i18n.global.t('agent.sendNotSaved')
      } else if (event.submissionState === 'unknown' && state.submitted) state.unverified = true
      if (event.state === 'idle' || event.state === 'waiting') {
        state.compacting = false
        void loadHistory(event.conversationId)
          .then(() => refreshList())
          .catch((cause) => {
            state.error = getErrorMessage(cause, i18n.global.t)
          })
      }
    }
    const conversation = conversations.value.find((item) => item.id === event.conversationId)
    if (conversation) {
      conversation.activity = state.activity
      conversation.queuePosition = state.queuePosition
    }
  }

  return {
    conversations,
    currentId,
    sessions,
    session,
    start,
    stop,
    refreshList,
    loadHistory,
    select,
    create,
    remove,
    send,
    compact,
    resume,
    cancel,
    verifySubmission,
  }
})
