// @vitest-environment jsdom
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { useExamsStore } from '../src/renderer/stores/exams'
import type { ExamPaper } from '../src/shared/exams'
import { i18n } from '../src/renderer/i18n'
const paper: ExamPaper = {
  id: 'paper',
  conversationId: 'chat',
  taskId: 'job',
  title: 'Exam',
  topic: 'TS',
  difficulty: 'Medium',
  counts: { single_choice: 0, true_false: 0, short_answer: 2 },
  status: 'generating',
  resetVersion: 0,
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
  questions: [
    {
      id: 'q1',
      position: 1,
      content: { type: 'short_answer', prompt: 'Explain' },
      answer: {
        value: null,
        version: 0,
        submitted: false,
        result: null,
        gradeRequestId: null,
        gradeStatus: 'idle',
      },
    },
  ],
}
beforeEach(() => {
  setActivePinia(createPinia())
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})
it('merges appended questions without overwriting unsaved typing and ignores old revisions', () => {
  const store = useExamsStore()
  store.merge(structuredClone(paper))
  store.edit('paper', 'q1', 'still typing')
  const next = structuredClone(paper)
  next.revision = 2
  next.questions.push({ ...structuredClone(next.questions[0]), id: 'q2', position: 2 })
  store.merge(next)
  store.merge(structuredClone(paper))
  expect(store.papers.paper.questions).toHaveLength(2)
  expect(store.drafts.q1).toMatchObject({ dirty: true, value: 'still typing' })
})
it('does not restore a stale save after a reset, and invalidates existing grading results', async () => {
  let resolve!: (value: ExamPaper) => void
  const old = structuredClone(paper)
  old.revision = 2
  old.questions[0].answer.value = 'old'
  old.questions[0].answer.version = 1
  const reset = structuredClone(paper)
  reset.revision = 3
  reset.resetVersion = 1
  Object.defineProperty(window, 'zhijiApi', {
    configurable: true,
    value: {
      exams: {
        save: () =>
          new Promise<ExamPaper>((r) => {
            resolve = r
          }),
        reset: async () => reset,
      },
    },
  })
  const store = useExamsStore()
  store.merge(structuredClone(paper))
  store.edit('paper', 'q1', 'old')
  const saving = store.save('paper', 'q1')
  await store.reset('paper')
  resolve(old)
  await saving
  expect(store.papers.paper.resetVersion).toBe(1)
  expect(store.drafts.q1).toMatchObject({ value: null, dirty: false })
})
it('keeps the newest paper selected when loads resolve out of order, and cancels pending opens on close', async () => {
  let resolveFirst!: (value: ExamPaper) => void
  const second = { ...structuredClone(paper), id: 'paper-2', questions: [] }
  const get = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<ExamPaper>((resolve) => {
          resolveFirst = resolve
        }),
    )
    .mockResolvedValue(second)
  Object.defineProperty(window, 'zhijiApi', {
    configurable: true,
    value: {
      exams: { get, onChanged: () => () => {} },
      data: { onExternalChange: () => () => {} },
    },
  })
  const store = useExamsStore()
  const firstOpen = store.open({ paperId: paper.id, conversationId: paper.conversationId })
  await store.open({ paperId: second.id, conversationId: second.conversationId })
  resolveFirst(structuredClone(paper))
  await firstOpen
  expect(store.selected?.paperId).toBe(second.id)

  get.mockImplementationOnce(
    () =>
      new Promise<ExamPaper>((resolve) => {
        resolveFirst = resolve
      }),
  )
  const reopening = store.open({ paperId: paper.id, conversationId: paper.conversationId })
  await store.close()
  resolveFirst(structuredClone(paper))
  await reopening
  expect(store.selected).toBeNull()
})
it('does not close a newer paper while an older paper is flushing its draft', async () => {
  let resolveSave!: (value: ExamPaper) => void
  const second = { ...structuredClone(paper), id: 'paper-2', questions: [] }
  Object.defineProperty(window, 'zhijiApi', {
    configurable: true,
    value: {
      exams: {
        get: async ({ paperId }: { paperId: string }) =>
          paperId === second.id ? second : structuredClone(paper),
        save: () =>
          new Promise<ExamPaper>((resolve) => {
            resolveSave = resolve
          }),
        onChanged: () => () => {},
      },
      data: { onExternalChange: () => () => {} },
    },
  })
  const store = useExamsStore()
  await store.open({ paperId: paper.id, conversationId: paper.conversationId })
  store.edit(paper.id, 'q1', 'draft')
  const closing = store.close()
  await store.open({ paperId: second.id, conversationId: second.conversationId })
  const saved = structuredClone(paper)
  saved.questions[0].answer.value = 'draft'
  resolveSave(saved)
  await closing
  expect(store.selected?.paperId).toBe(second.id)
})
it('forgets deleted conversations, cancels autosave and ignores their late load/save replies', async () => {
  let resolveLoad!: (value: ExamPaper) => void
  let resolveSave!: (value: ExamPaper) => void
  const save = vi.fn(
    () =>
      new Promise<ExamPaper>((resolve) => {
        resolveSave = resolve
      }),
  )
  const get = vi.fn(
    () =>
      new Promise<ExamPaper>((resolve) => {
        resolveLoad = resolve
      }),
  )
  Object.defineProperty(window, 'zhijiApi', { configurable: true, value: { exams: { get, save } } })
  const store = useExamsStore()
  store.merge(structuredClone(paper))
  store.edit(paper.id, 'q1', 'draft')
  const saving = store.save(paper.id, 'q1')
  const loading = store.load({ paperId: paper.id, conversationId: paper.conversationId })
  store.forgetConversation(paper.conversationId)
  resolveLoad(structuredClone(paper))
  resolveSave(structuredClone(paper))
  await Promise.all([saving, loading])
  await vi.advanceTimersByTimeAsync(1000)
  expect(store.papers).toEqual({})
  expect(store.drafts).toEqual({})
  expect(save).toHaveBeenCalledOnce()
})
it.each([
  [
    'EXAM_CONFLICT',
    'The answer has changed. Refresh the paper and retry.',
    '答案已变化，请刷新试卷后重试',
  ],
  ['AI_API_KEY_EMPTY', 'The current API Key is empty.', '当前 API Key 为空'],
])('localizes %s without revealing the backend message', (code, english, chinese) => {
  const store = useExamsStore(),
    locale = i18n.global.locale.value
  const notify = vi.fn()
  const unsubscribe = store.onError(notify)
  try {
    i18n.global.locale.value = 'en-US'
    store.failure({ name: 'IpcClientError', code, message: 'secret answer' })
    expect(notify).toHaveBeenLastCalledWith(english)
    i18n.global.locale.value = 'zh-CN'
    store.failure({ name: 'IpcClientError', code, message: 'secret answer' })
    expect(notify).toHaveBeenLastCalledWith(chinese)
  } finally {
    unsubscribe()
    i18n.global.locale.value = locale
  }
})
it('reports unexpected failures through diagnostics and unsubscribes message listeners', () => {
  const report = vi.fn()
  window.diagnosticsApi = { report }
  const store = useExamsStore()
  const notify = vi.fn()
  const unsubscribe = store.onError(notify)
  store.failure(new Error('private answer'))
  expect(notify).toHaveBeenCalledWith(i18n.global.t('error.generic'))
  expect(report).toHaveBeenCalledWith({
    source: 'renderer',
    operation: 'exam.request',
    code: 'INTERNAL_ERROR',
  })
  unsubscribe()
  store.failure({ name: 'IpcClientError', code: 'AI_API_KEY_EMPTY' })
  expect(notify).toHaveBeenCalledTimes(1)
  expect(report).toHaveBeenCalledTimes(1)
})
