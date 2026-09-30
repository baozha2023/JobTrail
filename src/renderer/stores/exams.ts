import { i18n } from '../i18n'
import { errorCode, getErrorMessage } from '../utils/errors'
import { reportRendererFault } from '../diagnostics'
import { defineStore } from 'pinia'
import { reactive, ref } from 'vue'
import type { ExamIdentity, ExamPaper, SaveExamAnswerInput } from '../../shared/exams'
export const useExamsStore = defineStore('exams', () => {
  const papers = reactive<Record<string, ExamPaper>>({})
  const drafts = reactive<
    Record<string, { value: string | boolean | null; dirty: boolean; generation: number }>
  >({})
  const errorListeners = new Set<(message: string) => void>()
  const selected = ref<ExamIdentity | null>(null)
  const pending = new Map<string, Promise<void>>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const loadRequests = new Map<string, { request: number; conversationId: string }>()
  let requestSequence = 0
  let selectionVersion = 0
  let subscriptions: (() => void)[] = []
  function merge(paper: ExamPaper) {
    const old = papers[paper.id]
    if (old && old.revision > paper.revision) return
    papers[paper.id] = paper
    for (const q of paper.questions) {
      const draft = drafts[q.id]
      if (!draft || !draft.dirty || (old && old.resetVersion !== paper.resetVersion))
        drafts[q.id] = {
          value: q.answer.value,
          dirty: false,
          generation: (draft?.generation ?? 0) + 1,
        }
    }
  }
  async function load(identity: ExamIdentity) {
    const request = ++requestSequence
    loadRequests.set(identity.paperId, { request, conversationId: identity.conversationId })
    const paper = await window.zhijiApi.exams.get({
      conversationId: identity.conversationId,
      paperId: identity.paperId,
    })
    if (loadRequests.get(identity.paperId)?.request === request) merge(paper)
  }
  function forgetPaper(paperId: string) {
    loadRequests.delete(paperId)
    for (const q of papers[paperId]?.questions ?? []) {
      const timer = timers.get(q.id)
      if (timer) clearTimeout(timer)
      timers.delete(q.id)
      delete drafts[q.id]
    }
    delete papers[paperId]
    if (selected.value?.paperId === paperId) {
      selectionVersion++
      selected.value = null
    }
  }
  function forgetConversation(conversationId: string) {
    selectionVersion++
    for (const [paperId, request] of loadRequests)
      if (request.conversationId === conversationId) loadRequests.delete(paperId)
    for (const paper of Object.values(papers))
      if (paper.conversationId === conversationId) forgetPaper(paper.id)
  }
  async function refresh(identity: ExamIdentity) {
    try {
      await load(identity)
    } catch (error) {
      if (errorCode(error) === 'EXAM_NOT_FOUND') forgetPaper(identity.paperId)
      else failure(error)
    }
  }
  function identity(id: string): ExamIdentity {
    return { paperId: id, conversationId: papers[id].conversationId }
  }
  function onError(listener: (message: string) => void) {
    errorListeners.add(listener)
    return () => {
      errorListeners.delete(listener)
    }
  }
  function failure(error: unknown) {
    reportRendererFault('exam.request', error)
    const message = getErrorMessage(error, i18n.global.t)
    for (const listener of errorListeners) listener(message)
  }
  function start() {
    if (subscriptions.length) return
    subscriptions = [
      window.zhijiApi.exams.onChanged((i) => {
        void refresh(i)
      }),
      window.zhijiApi.data.onExternalChange(() => {
        for (const paper of Object.values(papers)) void refresh(identity(paper.id))
      }),
    ]
  }
  async function open(i: ExamIdentity) {
    start()
    const version = ++selectionVersion
    await load(i)
    if (version === selectionVersion) selected.value = i
  }
  function edit(paperId: string, questionId: string, value: string | boolean | null) {
    const draft = drafts[questionId]
    draft.value = value
    draft.dirty = true
    draft.generation++
    const timer = timers.get(questionId)
    if (timer) clearTimeout(timer)
    if (
      typeof value === 'string' &&
      papers[paperId].questions.find((q) => q.id === questionId)?.content.type === 'short_answer'
    )
      timers.set(
        questionId,
        setTimeout(() => {
          void save(paperId, questionId).catch((e) => failure(e))
        }, 300),
      )
    else void save(paperId, questionId).catch((e) => failure(e))
  }
  function input(paperId: string, questionId: string): SaveExamAnswerInput {
    const paper = papers[paperId],
      q = paper.questions.find((q) => q.id === questionId)!
    return {
      ...identity(paperId),
      questionId,
      resetVersion: paper.resetVersion,
      expectedVersion: q.answer.version,
      value: drafts[questionId].value,
    }
  }
  async function save(paperId: string, questionId: string): Promise<void> {
    const timer = timers.get(questionId)
    if (timer) {
      clearTimeout(timer)
      timers.delete(questionId)
    }
    while (pending.has(questionId)) await pending.get(questionId)
    if (!drafts[questionId]?.dirty) return
    const draft = drafts[questionId],
      generation = draft.generation,
      reset = papers[paperId].resetVersion
    const promise = (async () => {
      const paper = await window.zhijiApi.exams.save(input(paperId, questionId))
      if (!papers[paperId] || reset !== papers[paperId].resetVersion) return
      if (drafts[questionId].generation === generation) drafts[questionId].dirty = false
      merge(paper)
    })()
    pending.set(questionId, promise)
    try {
      await promise
    } finally {
      if (pending.get(questionId) === promise) pending.delete(questionId)
    }
    if (drafts[questionId]?.dirty) await save(paperId, questionId)
  }
  async function flush(paperId: string) {
    await Promise.all(papers[paperId]?.questions.map((q) => save(paperId, q.id)) ?? [])
  }
  async function close() {
    const version = ++selectionVersion
    const current = selected.value
    if (current) {
      await flush(current.paperId)
      if (version === selectionVersion) selected.value = null
    }
  }
  async function submit(paperId: string, questionId: string) {
    try {
      await save(paperId, questionId)
      const q = papers[paperId].questions.find((q) => q.id === questionId)!
      merge(
        await window.zhijiApi.exams[q.content.type === 'short_answer' ? 'grade' : 'submit'](
          input(paperId, questionId),
        ),
      )
    } catch (e) {
      failure(e)
    }
  }
  async function reset(paperId: string) {
    for (const q of papers[paperId].questions) {
      const timer = timers.get(q.id)
      if (timer) clearTimeout(timer)
      timers.delete(q.id)
    }
    try {
      merge(await window.zhijiApi.exams.reset(identity(paperId)))
    } catch (e) {
      failure(e)
    }
  }
  return {
    papers,
    drafts,
    onError,
    selected,
    start,
    merge,
    load,
    open,
    close,
    edit,
    save,
    flush,
    submit,
    reset,
    forgetConversation,
    failure,
  }
})
