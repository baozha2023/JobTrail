// @vitest-environment jsdom
import { createPinia } from 'pinia'
import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import ExamPaperModal from '../src/renderer/components/ExamPaperModal.vue'
import { useExamsStore } from '../src/renderer/stores/exams'
import { i18n } from '../src/renderer/i18n'
import type { ExamPaper } from '../src/shared/exams'
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})
it('uses real controls for placement, prevents duplicates, handles cancellation/errors and keeps drafts', async () => {
  let finish!: (value: 'exported' | 'cancelled') => void
  const exportPdf = vi.fn(
    () =>
      new Promise<'exported' | 'cancelled'>((resolve) => {
        finish = resolve
      }),
  )
  vi.stubGlobal('zhijiApi', { exams: { exportPdf } })
  const pinia = createPinia()
  const store = useExamsStore(pinia)
  const paper: ExamPaper = {
    id: 'paper',
    conversationId: 'chat',
    taskId: 'task',
    title: '导出测试',
    topic: 'TS',
    difficulty: '中等',
    counts: { single_choice: 0, true_false: 0, short_answer: 1 },
    status: 'generating',
    resetVersion: 0,
    revision: 0,
    createdAt: 1,
    updatedAt: 1,
    questions: [
      {
        id: 'question',
        position: 1,
        content: { type: 'short_answer', prompt: 'Question' },
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
  store.merge(paper)
  store.selected = { paperId: paper.id, conversationId: paper.conversationId }
  store.drafts.question = { value: 'Unsaved attempt', dirty: true, generation: 1 }
  const failure = vi.spyOn(store, 'failure').mockImplementation(() => {})
  const wrapper = mount(ExamPaperModal, {
    attachTo: document.body,
    global: { plugins: [pinia, i18n] },
  })
  await flushPromises()
  const button = (selector: string, text: string) =>
    [...document.querySelectorAll<HTMLButtonElement>(selector)].find(
      (node) => node.textContent?.trim() === text,
    )!
  const headerButtons = [
    ...document.querySelectorAll('.exam-modal .n-card-header__extra button'),
  ].map((node) => node.textContent?.trim())
  expect(headerButtons).toEqual(['重置', '导出'])
  button('.exam-modal button', '导出').click()
  await flushPromises()
  expect(
    document.querySelector<HTMLInputElement>('.exam-export-options input[value="after_each"]')
      ?.checked,
  ).toBe(true)
  button('.exam-export-options button', '导出').click()
  button('.exam-export-options button', '导出').click()
  await flushPromises()
  expect(exportPdf).toHaveBeenCalledOnce()
  expect(exportPdf).toHaveBeenLastCalledWith({
    paperId: 'paper',
    conversationId: 'chat',
    answerPlacement: 'after_each',
  })
  finish('cancelled')
  await flushPromises()
  button('.exam-modal button', '导出').click()
  await flushPromises()
  document.querySelector<HTMLInputElement>('.exam-export-options input[value="at_end"]')!.click()
  await flushPromises()
  exportPdf.mockRejectedValueOnce(new Error('Export failed'))
  button('.exam-export-options button', '导出').click()
  await flushPromises()
  expect(exportPdf).toHaveBeenLastCalledWith({
    paperId: 'paper',
    conversationId: 'chat',
    answerPlacement: 'at_end',
  })
  expect(failure).toHaveBeenCalledOnce()
  expect(button('.exam-export-options button', '导出').disabled).toBe(false)
  expect(store.drafts.question).toMatchObject({ value: 'Unsaved attempt', dirty: true })
  expect(paper.questions[0].answer.value).toBeNull()
  exportPdf.mockResolvedValueOnce('exported')
  button('.exam-export-options button', '导出').click()
  await flushPromises()
  expect(wrapper.emitted('exported')).toHaveLength(1)
  store.merge({ ...paper, revision: 1, questions: [] })
  await flushPromises()
  expect(button('.exam-modal button', '导出').disabled).toBe(true)
  wrapper.unmount()
})
