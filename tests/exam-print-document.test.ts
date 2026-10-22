// @vitest-environment jsdom
import { shallowRef } from 'vue'
import { mount } from '@vue/test-utils'
import { expect, it } from 'vitest'
import ExamPrintDocument from '../src/renderer/components/ExamPrintDocument.vue'
import type { ExamPrintDocument as PrintDocument } from '../src/shared/exams'
function document(answerPlacement: PrintDocument['answerPlacement']): PrintDocument {
  return {
    jobId: 'job',
    locale: 'zh-CN',
    answerPlacement,
    paper: {
      title: '导出卷',
      topic: 'TS',
      difficulty: '中等',
      counts: { single_choice: 1, true_false: 1, short_answer: 2 },
      status: 'interrupted',
      questions: [
        {
          position: 1,
          content: {
            type: 'single_choice',
            prompt: '**First question**',
            options: ['One', 'Two', 'Three', 'Four'],
            correct: 'B',
            explanation: 'First explanation',
          },
          defaultAnswer: null,
        },
        {
          position: 2,
          content: {
            type: 'true_false',
            prompt: 'Second question',
            correct: false,
            explanation: 'Second explanation',
          },
          defaultAnswer: null,
        },
        {
          position: 3,
          content: { type: 'short_answer', prompt: 'Legacy question' },
          defaultAnswer: null,
        },
        {
          position: 4,
          content: {
            type: 'short_answer',
            prompt: 'New question\n\n<script>bad()</script>\n\n![image](https://example.com/a.png)',
          },
          defaultAnswer: '```ts\nconst answer = 42\n```',
        },
      ],
    },
  }
}
it('renders English labels using the captured export locale', () => {
  const value = document('at_end')
  value.locale = 'en-US'
  const wrapper = mount(ExamPrintDocument, { props: { documentData: shallowRef(value) } })
  expect(wrapper.text()).toContain('Incomplete')
  expect(wrapper.text()).toContain('Answers and explanations')
  expect(wrapper.text()).toContain('Reference answer')
  wrapper.unmount()
})
it.each(['after_each', 'at_end'] as const)(
  'renders real Markdown, legacy blanks and %s answer order',
  (answerPlacement) => {
    const wrapper = mount(ExamPrintDocument, {
      props: { documentData: shallowRef(document(answerPlacement)) },
    })
    expect(wrapper.text()).toContain('未完成')
    expect(wrapper.text()).toContain('4 / 4')
    expect(wrapper.find('.print-question .agent-markdown strong').text()).toBe('First question')
    expect(wrapper.findAll('.print-option')).toHaveLength(4)
    expect(wrapper.find('.blank-answer').exists()).toBe(true)
    expect(wrapper.findAll('script,img')).toHaveLength(0)
    expect(wrapper.find('pre code').text()).toContain('const answer = 42')
    const sections = wrapper.findAll('.print-question')
    if (answerPlacement === 'after_each') {
      expect(sections[0].text()).toContain('First explanation')
      expect(wrapper.find('.print-answer-section').exists()).toBe(false)
    } else {
      expect(sections[0].text()).not.toContain('First explanation')
      expect(wrapper.find('.print-answer-section').text()).toContain('First explanation')
    }
    wrapper.unmount()
  },
)
