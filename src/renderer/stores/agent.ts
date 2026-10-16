import { useExamsStore } from './exams'
import { isExamTool } from '../../shared/exam-tools'
import { defineStore } from 'pinia'
import { reactive, ref } from 'vue'
import { type DiscoveryRecoveryTarget } from '../../shared/job-discovery'
import type {
  AgentAttachment,
  AgentQueueSnapshot,
  AgentQueueEdit,
  AgentJobSnapshot,
  AgentConversation,
  AgentDraftPart,
  AgentEvent,
  AgentHistory,
  AgentMessage,
  AgentPending,
  AgentUsage,
} from '../../shared/types'
import { errorCode, getErrorMessage } from '../utils/errors'
import { i18n } from '../i18n'
import { reportRendererFault } from '../diagnostics'

type AgentActivity = NonNullable<AgentConversation['activity']>
interface SubmittedMessage {
  jobId: string
  parts: AgentDraftPart[]
  attachments: AgentAttachment[]
}
export interface AgentSession {
  queue: AgentQueueSnapshot
  enqueueing: boolean
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
    queue: { revision: 0, internal: [], external: [], failed: [], blocked: null },
    enqueueing: false,
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
  const retiredJobs = new Map<string, Set<string>>()
  let unsubscribe: (() => void) | undefined
  let unsubscribeExternal: (() => void) | undefined
  let started: Promise<void> | undefined

  function session(id: string): AgentSession {
    sessions[id] ??= emptySession()
    return sessions[id]
  }

  async function start(): Promise<void> {
    if (started) return started
    unsubscribe = window.zhijiApi.agent.onEvent(receiveEvent)
    unsubscribeExternal = window.zhijiApi.data.onExternalChange(() => {
      if (currentId.value)
        void loadHistory(currentId.value).catch((cause) =>
          reportRendererFault('exam.history-refresh', cause),
        )
    })
    started = refreshList().catch((cause) => {
      stop()
      throw cause
    })
    return started
  }

  function stop(): void {
    unsubscribe?.()
    unsubscribeExternal?.()
    unsubscribeExternal = undefined
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

  function applyQueue(id: string, queue: AgentQueueSnapshot): void {
    const state = session(id)
    if (queue.revision < state.queue.revision) return
    state.queue = queue
    const failed = new Set(queue.failed.map((item) => `optimistic:${item.id}`))
    state.messages = state.messages.filter((item) => !failed.has(item.id))
    state.unverified = !!queue.blocked || !!state.submitted
  }

  function activeJob(id: string, job: AgentJobSnapshot | null): void {
    const state = session(id)
    if (state.jobId && state.jobId !== job?.jobId) {
      const retired = retiredJobs.get(id) ?? new Set<string>()
      retired.add(state.jobId)
      retiredJobs.set(id, retired)
    }
    if (!job) {
      state.jobId = null
      state.sequence = 0
      state.compacting = false
      return
    }
    if (state.jobId !== job.jobId) {
      state.jobId = job.jobId
      state.sequence = job.sequence
    }
    state.compacting = job.operation === 'compact'
    const optimistic = state.messages.find((message) => message.id === `optimistic:${job.jobId}`)
    if (job.submittedParts && optimistic?.role === 'user') {
      optimistic.parts = job.submittedParts
      optimistic.attachments = job.submittedAttachments ?? []
    }
    if (
      job.submittedParts &&
      !state.messages.some(
        (message) => message.id === job.jobId || message.id === `optimistic:${job.jobId}`,
      )
    )
      state.messages.push({
        id: `optimistic:${job.jobId}`,
        role: 'user',
        parts: job.submittedParts,
        attachments: job.submittedAttachments ?? [],
      })
  }

  function applyHistory(id: string, history: AgentHistory): void {
    const state = session(id)
    if (history.queue && history.queue.revision < state.queue.revision) return
    if (history.queue) applyQueue(id, history.queue)
    const job = history.job
    if (job && state.jobId === job.jobId && state.sequence > job.sequence) return
    const messages = [...history.messages]
    if (job?.submittedParts && !messages.some((message) => message.id === job.jobId)) {
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
          : state.queue.internal.length || state.queue.external.length
            ? 'queued'
            : 'idle'
    state.queuePosition = job?.queuePosition
    state.compacting = job?.operation === 'compact'
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
    const sequenceAtRequest = state.sequence
    const history = await window.zhijiApi.agent.history(id)
    if (
      state.historyRequest !== request ||
      state.jobId !== jobAtRequest ||
      state.sequence !== sequenceAtRequest
    )
      return
    // Queue position changes also advance its revision without emitting a new
    // job event. Fetch again so selecting a queued chat cannot leave history blank.
    if (history.queue && history.queue.revision < state.queue.revision) return loadHistory(id)
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
    useExamsStore().forgetConversation(id)
    delete sessions[id]
    await refreshList()
    if (currentId.value === id) {
      currentId.value = conversations.value[0]?.id ?? null
      if (currentId.value) await loadHistory(currentId.value)
    }
  }

  async function verifySubmission(id: string): Promise<boolean> {
    const state = session(id)
    if (state.verifying) return false
    state.verifying = true
    try {
      if (state.queue.blocked) applyQueue(id, await window.zhijiApi.agent.reconcileQueue(id))
      const history = await window.zhijiApi.agent.history(id)
      const submitted = state.submitted
      let received = false
      if (submitted) {
        const receipt = await window.zhijiApi.agent.submission(id, submitted.jobId)
        received =
          !!receipt ||
          history.job?.jobId === submitted.jobId ||
          history.messages.some((message) => message.id === submitted.jobId) ||
          [
            ...(history.queue?.internal ?? []),
            ...(history.queue?.external ?? []),
            ...(history.queue?.failed ?? []),
            ...(history.queue?.blocked ? [history.queue.blocked] : []),
          ].some((item) => item.id === submitted.jobId)
        state.submitted = null
        if (
          received &&
          JSON.stringify(state.draftParts) === JSON.stringify(submitted.parts) &&
          JSON.stringify(state.uploads.map((file) => file.id)) ===
            JSON.stringify(submitted.attachments.map((file) => file.id))
        ) {
          state.draftParts = []
          state.uploads = []
          state.draftVersion++
        }
        if (!received) state.error = i18n.global.t('agent.sendNotSaved')
      }
      state.unverified = !!history.queue?.blocked
      applyHistory(id, history)
      return received
    } catch (cause) {
      state.unverified = true
      state.error = i18n.global.t('agent.sendUnverified')
      reportRendererFault('agent.verify-submission', cause)
      return false
    } finally {
      state.verifying = false
    }
  }

  async function send(
    id: string,
    parts: AgentDraftPart[],
    attachments: AgentAttachment[],
  ): Promise<boolean> {
    const state = session(id)
    if (state.enqueueing || state.unverified || state.verifying) return false
    const jobId = crypto.randomUUID()
    state.enqueueing = true
    state.error = ''
    try {
      await window.zhijiApi.agent.send(
        id,
        parts,
        attachments.map((attachment) => attachment.id),
        jobId,
      )
      state.uploads = []
      state.draftParts = []
      return true
    } catch (cause) {
      state.error = getErrorMessage(cause, i18n.global.t)
      if (errorCode(cause)) return false
      // A failed transport may have hidden an accepted receipt. Query Main before allowing a retry.
      state.submitted = { jobId, parts, attachments }
      return await verifySubmission(id)
    } finally {
      state.enqueueing = false
    }
  }

  async function queueDiscoveryContinuation(
    id: string,
    target: DiscoveryRecoveryTarget,
  ): Promise<void> {
    const jobId = crypto.randomUUID()
    try {
      await window.zhijiApi.agent.notifyDiscovery(
        id,
        {
          platform: target.platform,
          ...(target.runId ? { runId: target.runId } : {}),
        },
        jobId,
      )
    } catch (cause) {
      if (!errorCode(cause)) {
        try {
          if (await window.zhijiApi.agent.submission(id, jobId)) {
            await loadHistory(id)
            return
          }
        } catch (verificationError) {
          reportRendererFault('agent.verify-discovery-notification', verificationError)
        }
      }
      session(id).error = getErrorMessage(cause, i18n.global.t)
    }
  }

  async function editQueue(id: string, edit: AgentQueueEdit): Promise<void> {
    applyQueue(id, await window.zhijiApi.agent.editQueue(id, edit))
  }

  async function compact(id: string, parts: AgentDraftPart[]): Promise<boolean> {
    const state = session(id)
    if (state.enqueueing || state.unverified || state.verifying) return false
    state.enqueueing = true
    const jobId = crypto.randomUUID()
    try {
      await window.zhijiApi.agent.compact(id, jobId)
      state.draftParts = []
      return true
    } catch (cause) {
      state.error = getErrorMessage(cause, i18n.global.t)
      if (errorCode(cause)) return false
      state.submitted = { jobId, parts, attachments: [] }
      return await verifySubmission(id)
    } finally {
      state.enqueueing = false
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

  function receiveEvent(event: AgentEvent): void {
    const state = session(event.conversationId)
    if (event.kind === 'queue' && event.queue) {
      if (event.queue.revision < state.queue.revision) return
      const previousJob = state.jobId
      applyQueue(event.conversationId, event.queue)
      activeJob(event.conversationId, event.job ?? null)
      state.activity = event.state ?? 'idle'
      state.queuePosition = event.queuePosition
      const conversation = conversations.value.find((item) => item.id === event.conversationId)
      if (conversation) {
        conversation.activity = state.activity
        conversation.queuePosition = state.queuePosition
      }
      // The terminal queue snapshot retires the previous event cursor. Refresh
      // after that transition so its committed history is not discarded as stale.
      if (previousJob && !state.jobId)
        void loadHistory(event.conversationId).catch((cause) =>
          reportRendererFault('agent.queue-history', cause),
        )
      return
    }
    if (event.jobId) {
      if (retiredJobs.get(event.conversationId)?.has(event.jobId)) return
      if (state.jobId && state.jobId !== event.jobId && state.activity !== 'idle') return
      if (state.jobId !== event.jobId) {
        state.jobId = event.jobId
        state.sequence = 0
      }
      if (event.sequence !== undefined) {
        if (event.sequence <= state.sequence) return
        const missedEvents = state.sequence > 0 && event.sequence !== state.sequence + 1
        state.sequence = event.sequence
        if (missedEvents)
          void loadHistory(event.conversationId).catch((cause) =>
            reportRendererFault('agent.load-history', cause),
          )
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
      if (isExamTool(event.toolName) && event.toolResult) {
        try {
          const result = JSON.parse(event.toolResult)
          const paper = result.paper
          if (paper?.id && paper.conversationId === event.conversationId) {
            void useExamsStore()
              .load({ paperId: paper.id, conversationId: paper.conversationId })
              .catch((cause) => reportRendererFault('exam.refresh', cause))
            if (
              paper.questionCount > 0 &&
              !state.messages.some((m) => m.role === 'exam-paper' && m.paperId === paper.id)
            )
              state.messages.push({
                id: `exam:${paper.id}`,
                role: 'exam-paper',
                paperId: paper.id,
                attachments: [],
              })
          }
        } catch {
          /* Failed tools do not create cards. */
        }
      }
    } else if (event.kind === 'pending') {
      showPending(state, event.pending ?? null)
    } else if (event.kind === 'usage' && event.usage) {
      state.usage = event.usage
    } else if (event.kind === 'compact' && event.compact) {
      state.compacting = false
      state.messages.push(event.compact)
    } else if (event.kind === 'error') {
      state.error = getErrorMessage(
        { code: event.errorCode, diagnostic: event.diagnostic },
        i18n.global.t,
      )
      if (event.submissionState === 'unknown') state.unverified = true
    } else if (event.kind === 'state') {
      state.activity = event.state ?? 'idle'
      state.queuePosition = event.queuePosition
      if (event.submissionState === 'unknown') state.unverified = true
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
    queueDiscoveryContinuation,
    editQueue,
    verifySubmission,
  }
})
