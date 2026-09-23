// @vitest-environment jsdom

import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { i18n } from '../src/renderer/i18n'
import AgentComposerEditor from '../src/renderer/components/AgentComposerEditor.vue'
import AgentMarkdown from '../src/renderer/components/AgentMarkdown.vue'
import AgentMessageBody from '../src/renderer/components/AgentMessageBody.vue'
import AgentView from '../src/renderer/views/AgentView.vue'
import type {
  AgentAttachment,
  AgentDraftPart,
  AgentEvent,
  AgentMessage,
  AgentPending,
  Company,
  Industry,
  Opportunity,
  ResumeVersion,
} from '../src/shared/types'

const global = { plugins: [i18n] }

describe('agent markdown', () => {
  it('renders common Markdown, removes unsafe HTML, and opens only validated links', async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window, 'zhijiApi', {
      value: { system: { openExternal } },
      configurable: true,
    })
    const wrapper = mount(AgentMarkdown, {
      props: {
        text: [
          '**vivo**',
          '',
          '- 智能手机',
          '- 移动互联网服务',
          '',
          '[招聘官网](https://hr.vivo.com/)',
          '',
          '<script>alert(1)</script>',
          '<img src="https://tracker.example/pixel">',
          '<a href="https://example.com" aria-label="x" data-track="x" style="color:red" onclick="alert(1)">安全链接</a>',
        ].join('\n'),
      },
    })

    expect(wrapper.find('strong').text()).toBe('vivo')
    expect(wrapper.findAll('li').map((item) => item.text())).toEqual(['智能手机', '移动互联网服务'])
    expect(wrapper.find('script').exists()).toBe(false)
    expect(wrapper.find('img').exists()).toBe(false)
    const hardenedLink = wrapper.findAll('a')[1]
    expect(hardenedLink.attributes()).toEqual({ href: 'https://example.com' })
    await wrapper.find('a').trigger('click')
    expect(openExternal).toHaveBeenCalledWith('https://hr.vivo.com/')
  })
})

describe('agent attachments', () => {
  it('opens documents with the system and previews images in the chat', async () => {
    const conversation = { id: 'attachment-chat', title: '附件', createdAt: 1, updatedAt: 1 }
    const documentAttachment: AgentAttachment = {
      id: 'document-1',
      conversationId: conversation.id,
      name: '说明.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      sizeBytes: 10,
    }
    const imageAttachment: AgentAttachment = {
      id: 'image-1',
      conversationId: conversation.id,
      name: '截图.png',
      mimeType: 'image/png',
      sizeBytes: 10,
    }
    const openAttachment = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window, 'zhijiApi', {
      configurable: true,
      value: {
        agent: {
          list: async () => [conversation],
          history: async () => ({
            messages: [
              {
                id: 'message-1',
                role: 'user',
                parts: [{ kind: 'text', text: '附件' }],
                attachments: [documentAttachment, imageAttachment],
              },
            ],
            pending: null,
            running: false,
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: null,
              contextTokens: null,
              contextEstimated: true,
              contextWindowTokens: 256000,
            },
          }),
          preview: async () => 'data:image/png;base64,iVBORw0KGgo=',
          openAttachment,
          onEvent: () => () => {},
        },
      },
    })
    const host = document.createElement('div')
    document.body.appendChild(host)
    const wrapper = mount(AgentView, {
      attachTo: host,
      props: {
        mcpEnabled: false,
        multimodal: true,
        dark: false,
        resumes: [],
        opportunities: [],
        companies: [],
        industries: [],
      },
      global,
    })
    try {
      await flushPromises()
      const cards = wrapper.findAll('.agent-attachment-open')
      expect(cards).toHaveLength(2)
      await cards[0].trigger('click')
      expect(openAttachment).toHaveBeenCalledWith(conversation.id, documentAttachment.id)
      await cards[1].trigger('click')
      await flushPromises()
      expect(document.querySelector<HTMLImageElement>('.agent-image-preview')?.src).toMatch(
        /^data:image\/png/,
      )
    } finally {
      wrapper.unmount()
      host.remove()
    }
  })

  it('clears the composer and attachment tray as soon as sending starts', async () => {
    const conversation = { id: 'send-chat', title: '发送', createdAt: 1, updatedAt: 1 }
    const attachment: AgentAttachment = {
      id: 'send-image',
      conversationId: conversation.id,
      name: '待发送.png',
      mimeType: 'image/png',
      sizeBytes: 10,
    }
    let resolveSend!: () => void
    const send = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSend = resolve
        }),
    )
    let sendResolved = false
    Object.defineProperty(window, 'zhijiApi', {
      configurable: true,
      value: {
        agent: {
          list: async () => [conversation],
          history: async () => ({
            messages: [],
            pending: null,
            running: false,
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: null,
              contextTokens: null,
              contextEstimated: true,
              contextWindowTokens: 256000,
            },
          }),
          upload: async () => attachment,
          preview: async () => 'data:image/png;base64,iVBORw0KGgo=',
          send,
          onEvent: () => () => {},
        },
      },
    })
    const wrapper = mount(AgentView, {
      props: {
        mcpEnabled: false,
        multimodal: true,
        dark: false,
        resumes: [],
        opportunities: [],
        companies: [],
        industries: [],
      },
      global,
    })
    try {
      await flushPromises()
      const uploadButton = wrapper
        .findAll('.agent-actions button')
        .find((button) => button.text().includes('上传'))
      await uploadButton?.trigger('click')
      await flushPromises()
      expect(wrapper.find('.agent-compose-attachments').exists()).toBe(true)
      const editor = wrapper.find('[role="textbox"]').element as HTMLElement
      typeAtCaret(editor, '立即清空')
      editor.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      )
      await flushPromises()
      expect(send).toHaveBeenCalledOnce()
      expect(editor.textContent).toBe('')
      expect(wrapper.find('.agent-compose-attachments').exists()).toBe(false)
      resolveSend()
      sendResolved = true
      await flushPromises()
    } finally {
      if (!sendResolved) resolveSend?.()
      wrapper.unmount()
    }
  })
})

describe('agent send recovery', () => {
  const conversation = { id: 'send-recovery', title: '发送核对', createdAt: 1, updatedAt: 1 }
  const attachment: AgentAttachment = {
    id: 'pending-image',
    conversationId: conversation.id,
    name: '待发送.png',
    mimeType: 'image/png',
    sizeBytes: 10,
  }
  const emptyHistory = () => ({
    messages: [] as AgentMessage[],
    pending: null,
    running: false,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: null,
      contextTokens: null,
      contextEstimated: true,
      contextWindowTokens: 256000,
    },
  })
  function mountChat() {
    return mount(AgentView, {
      props: {
        mcpEnabled: false,
        multimodal: true,
        dark: false,
        resumes: [],
        opportunities: [],
        companies: [],
        industries: [],
      },
      global,
    })
  }
  function enterMessage(wrapper: ReturnType<typeof mountChat>, text: string): void {
    const editor = wrapper.find('[role="textbox"]').element as HTMLElement
    typeAtCaret(editor, text)
    editor.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )
  }

  it('locks resending until history confirms the message was not saved', async () => {
    const history = vi
      .fn()
      .mockResolvedValueOnce(emptyHistory())
      .mockRejectedValueOnce(new Error('history unavailable'))
      .mockResolvedValueOnce({ ...emptyHistory(), running: true })
      .mockRejectedValueOnce(new Error('history still unavailable'))
      .mockResolvedValueOnce(emptyHistory())
    const send = vi.fn().mockRejectedValue(new Error('send failed'))
    Object.defineProperty(window, 'zhijiApi', {
      configurable: true,
      value: {
        agent: {
          list: async () => [conversation],
          history,
          upload: async () => attachment,
          preview: async () => 'data:image/png;base64,iVBORw0KGgo=',
          send,
          onEvent: () => () => {},
        },
      },
    })
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const wrapper = mountChat()
    try {
      await flushPromises()
      await wrapper.find('.agent-actions button').trigger('click')
      await flushPromises()
      enterMessage(wrapper, '请查看附件')
      await flushPromises()
      expect(send).toHaveBeenCalledOnce()
      expect(wrapper.find('[role="textbox"]').element.textContent).toBe('')
      expect(wrapper.find('.agent-compose-attachments').exists()).toBe(false)
      expect(wrapper.find('.agent-send-unverified').text()).toContain('核对当前对话')
      expect(wrapper.find('.agent-actions').text()).toContain('发送')
      expect(wrapper.find('.agent-actions button:last-child').attributes('disabled')).toBeDefined()

      await wrapper.find('.agent-send-unverified button').trigger('click')
      await flushPromises()
      expect(wrapper.find('.agent-send-unverified').exists()).toBe(true)
      expect(send).toHaveBeenCalledOnce()

      await wrapper.find('.agent-send-unverified button').trigger('click')
      await flushPromises()
      expect(wrapper.find('.agent-send-unverified').exists()).toBe(true)
      expect(wrapper.find('[role="textbox"]').element.textContent).toBe('')

      await wrapper.find('.agent-send-unverified button').trigger('click')
      await flushPromises()
      expect(wrapper.find('.agent-send-unverified').exists()).toBe(false)
      expect(wrapper.find('[role="textbox"]').element.textContent).toBe('请查看附件')
      expect(wrapper.find('.agent-compose-attachments').exists()).toBe(true)
    } finally {
      wrapper.unmount()
      log.mockRestore()
    }
  })

  it('keeps the draft cleared when history confirms the message was saved', async () => {
    const saved = {
      ...emptyHistory(),
      messages: [
        {
          id: 'saved-user',
          role: 'user' as const,
          parts: [{ kind: 'text' as const, text: '只发送一次' }],
          attachments: [],
        },
      ],
    }
    const history = vi
      .fn()
      .mockResolvedValueOnce(emptyHistory())
      .mockRejectedValueOnce(new Error('history unavailable'))
      .mockResolvedValueOnce(saved)
    const send = vi.fn().mockRejectedValue(new Error('send failed'))
    Object.defineProperty(window, 'zhijiApi', {
      configurable: true,
      value: {
        agent: { list: async () => [conversation], history, send, onEvent: () => () => {} },
      },
    })
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const wrapper = mountChat()
    try {
      await flushPromises()
      enterMessage(wrapper, '只发送一次')
      await flushPromises()
      await wrapper.find('.agent-send-unverified button').trigger('click')
      await flushPromises()
      expect(wrapper.find('.agent-send-unverified').exists()).toBe(false)
      expect(wrapper.find('[role="textbox"]').element.textContent).toBe('')
      expect(wrapper.findAll('.agent-message.user')).toHaveLength(1)
      expect(send).toHaveBeenCalledOnce()
    } finally {
      wrapper.unmount()
      log.mockRestore()
    }
  })

  it('does not restore a draft when sending succeeded but refreshing history failed', async () => {
    const history = vi
      .fn()
      .mockResolvedValueOnce(emptyHistory())
      .mockRejectedValueOnce(new Error('history unavailable'))
    const send = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window, 'zhijiApi', {
      configurable: true,
      value: {
        agent: { list: async () => [conversation], history, send, onEvent: () => () => {} },
      },
    })
    const wrapper = mountChat()
    try {
      await flushPromises()
      enterMessage(wrapper, '已经发送')
      await flushPromises()
      expect(wrapper.find('[role="textbox"]').element.textContent).toBe('')
      expect(wrapper.find('.agent-send-unverified').exists()).toBe(false)
      expect(wrapper.find('.agent-error').text()).toContain('消息已发送')
      expect(history).toHaveBeenCalledTimes(2)
      expect(send).toHaveBeenCalledOnce()
    } finally {
      wrapper.unmount()
    }
  })
})

function typeAtCaret(editor: HTMLElement, text: string): void {
  let node = editor.firstChild
  if (!node || node.nodeType !== Node.TEXT_NODE) {
    node = document.createTextNode('')
    editor.replaceChildren(node)
  }
  node.textContent = text
  const selection = window.getSelection()
  const range = document.createRange()
  range.setStart(node, text.length)
  range.collapse(true)
  selection?.removeAllRanges()
  selection?.addRange(range)
  editor.dispatchEvent(new Event('input', { bubbles: true }))
}

function chooseOption(index: number): void {
  const options = document.querySelectorAll('.agent-command-option')
  expect(options[index]).toBeTruthy()
  options[index].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
}

describe('agent composer', () => {
  it('restores a running reply after remount and clears it on completion', async () => {
    const conversation = { id: 'running-chat', title: '回复中', createdAt: 1, updatedAt: 1 }
    let onAgentEvent: ((event: AgentEvent) => void) | undefined
    Object.defineProperty(window, 'zhijiApi', {
      value: {
        agent: {
          list: async () => [conversation],
          history: async () => ({
            messages: [],
            pending: null,
            running: true,
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: null,
              contextTokens: null,
              contextEstimated: true,
              contextWindowTokens: 256000,
            },
          }),
          cancel: vi.fn().mockResolvedValue(undefined),
          onEvent: (listener: (event: AgentEvent) => void) => {
            onAgentEvent = listener
            return () => {}
          },
        },
      },
      configurable: true,
    })
    const wrapper = mount(AgentView, {
      props: {
        mcpEnabled: false,
        multimodal: false,
        dark: false,
        resumes: [],
        opportunities: [],
        companies: [],
        industries: [],
      },
      global,
    })
    try {
      await flushPromises()
      expect(wrapper.find('.agent-actions').text()).toContain('停止')
      onAgentEvent?.({ conversationId: conversation.id, kind: 'done' })
      await wrapper.vm.$nextTick()
      expect(wrapper.find('.agent-actions').text()).toContain('发送')
    } finally {
      wrapper.unmount()
    }
  })

  it('does not preselect an option when the model did not recommend one', async () => {
    const conversation = { id: 'neutral-question', title: '待选择', createdAt: 1, updatedAt: 1 }
    Object.defineProperty(window, 'zhijiApi', {
      value: {
        agent: {
          list: async () => [conversation],
          history: async () => ({
            messages: [],
            pending: {
              kind: 'question',
              questions: [
                {
                  question: '选择方向',
                  options: [
                    { label: '后端', description: '服务端开发' },
                    { label: '前端', description: 'Web 开发' },
                  ],
                },
              ],
            },
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: null,
              contextTokens: null,
              contextEstimated: true,
              contextWindowTokens: 256000,
            },
          }),
          onEvent: () => () => {},
        },
      },
      configurable: true,
    })
    const wrapper = mount(AgentView, {
      props: {
        mcpEnabled: false,
        multimodal: false,
        dark: false,
        resumes: [],
        opportunities: [],
        companies: [],
        industries: [],
      },
      global,
    })
    try {
      await flushPromises()
      expect(
        wrapper
          .findAll<HTMLInputElement>('.agent-question input[type="radio"]')
          .map((input) => input.element.checked),
      ).toEqual([false, false, false])
      expect(wrapper.find('.agent-question-next').attributes('disabled')).toBeDefined()
    } finally {
      wrapper.unmount()
    }
  })

  it('replaces the composer with a pending question and dismisses it immediately on resume', async () => {
    const conversation = { id: 'pending-chat', title: '待补充', createdAt: 1, updatedAt: 1 }
    let activePending: AgentPending | null = {
      kind: 'question',
      questions: [
        {
          question: '请说明目标岗位',
          options: [
            { label: 'Java 后端', description: '服务端开发', recommended: true },
            { label: '前端', description: 'Web 开发' },
          ],
        },
        { question: '目标城市？' },
      ],
    }
    let rejectResume!: (reason: Error) => void
    const resume = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectResume = reject
          }),
      )
      .mockImplementationOnce(async () => {
        activePending = null
      })
    const send = vi.fn()
    Object.defineProperty(window, 'zhijiApi', {
      value: {
        agent: {
          list: async () => [conversation],
          history: async () => ({
            messages: [],
            pending: activePending,
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: null,
              contextTokens: null,
              contextEstimated: true,
              contextWindowTokens: 256000,
            },
          }),
          resume,
          send,
          onEvent: () => () => {},
        },
      },
      configurable: true,
    })
    const wrapper = mount(AgentView, {
      props: {
        mcpEnabled: false,
        multimodal: false,
        dark: false,
        resumes: [],
        opportunities: [],
        companies: [],
        industries: [],
      },
      global,
    })
    try {
      await flushPromises()
      expect(wrapper.find('.agent-main > .agent-pending').exists()).toBe(true)
      expect(wrapper.find('.agent-composer').exists()).toBe(false)
      expect(wrapper.find('.agent-actions').exists()).toBe(false)
      expect(wrapper.findAll('.agent-question')).toHaveLength(1)
      expect(wrapper.find('.agent-question').text()).toContain('请说明目标岗位')
      expect(wrapper.find('.agent-question').text()).not.toContain('目标城市')
      expect(wrapper.find('.agent-pending-heading').text()).toContain('第 1 / 2 题')
      expect(wrapper.find('.agent-question-next').text()).toBe('下一步')
      expect(wrapper.find('.agent-question').text()).toContain('推荐')
      expect(wrapper.findAll('.agent-question input[type="radio"]')).toHaveLength(3)
      await wrapper.findAll('.agent-question input[type="radio"]')[2].trigger('change')
      expect(wrapper.find('.agent-question-next').attributes('disabled')).toBeDefined()
      await wrapper.find('.agent-question textarea').setValue('数据分析')
      await wrapper.find('.agent-question-next').trigger('click')
      expect(resume).not.toHaveBeenCalled()
      expect(wrapper.findAll('.agent-question')).toHaveLength(1)
      expect(wrapper.find('.agent-question').text()).toContain('目标城市？')
      expect(wrapper.find('.agent-question').text()).not.toContain('请说明目标岗位')
      expect(wrapper.find('.agent-pending-heading').text()).toContain('第 2 / 2 题')
      expect(wrapper.find('.agent-question-next').text()).toBe('提交')
      await wrapper.find('.agent-question textarea').setValue('上海')
      await wrapper.find('.agent-question-next').trigger('click')
      expect(resume).toHaveBeenCalledWith(conversation.id, ['数据分析', '上海'])
      expect(wrapper.find('.agent-pending').exists()).toBe(false)
      expect(wrapper.find('.agent-composer [role="textbox"]').attributes('contenteditable')).toBe(
        'false',
      )
      expect(send).not.toHaveBeenCalled()
      rejectResume(new Error('恢复失败'))
      await flushPromises()
      expect(wrapper.find('.agent-pending-heading').text()).toContain('第 2 / 2 题')
      expect(wrapper.find('.agent-question textarea').element).toHaveProperty('value', '上海')
      await wrapper.find('.agent-question-back').trigger('click')
      expect(wrapper.find('.agent-question textarea').element).toHaveProperty('value', '数据分析')
      await wrapper.find('.agent-question input[type="radio"]').trigger('change')
      await wrapper.find('.agent-question-next').trigger('click')
      expect(wrapper.find('.agent-question textarea').element).toHaveProperty('value', '上海')
      await wrapper.find('.agent-question-next').trigger('click')
      await flushPromises()
      expect(resume).toHaveBeenCalledTimes(2)
      expect(resume).toHaveBeenLastCalledWith(conversation.id, ['Java 后端', '上海'])
      expect(wrapper.find('.agent-pending').exists()).toBe(false)
      expect(wrapper.find('.agent-composer [role="textbox"]').attributes('contenteditable')).toBe(
        'true',
      )
    } finally {
      wrapper.unmount()
    }
  })

  it('clears /compact immediately and shows a tool-style running state', async () => {
    const conversation = { id: 'compact-chat', title: '压缩测试', createdAt: 1, updatedAt: 1 }
    let resolveCompact!: () => void
    const compact = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveCompact = resolve
        }),
    )
    Object.defineProperty(window, 'zhijiApi', {
      configurable: true,
      value: {
        agent: {
          list: async () => [conversation],
          history: async () => ({
            messages: [],
            pending: null,
            running: false,
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: null,
              contextTokens: null,
              contextEstimated: true,
              contextWindowTokens: 256000,
            },
          }),
          compact,
          onEvent: () => () => {},
        },
      },
    })
    const wrapper = mount(AgentView, {
      props: {
        mcpEnabled: false,
        multimodal: false,
        dark: false,
        resumes: [],
        opportunities: [],
        companies: [],
        industries: [],
      },
      global,
    })
    try {
      await flushPromises()
      const editor = wrapper.find<HTMLElement>('.agent-composer [role="textbox"]').element
      typeAtCaret(editor, '/compact')
      editor.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      )
      await wrapper.vm.$nextTick()

      expect(compact).toHaveBeenCalledWith(conversation.id)
      expect(editor.textContent).toBe('')
      expect(wrapper.find('.agent-compact-running').text()).toContain('compact')
      expect(wrapper.find('.agent-compact-running').text()).toContain('正在压缩')

      resolveCompact()
      await flushPromises()
      expect(wrapper.find('.agent-compact-running').exists()).toBe(false)
    } finally {
      resolveCompact?.()
      wrapper.unmount()
    }
  })

  it('renders filtered @ and / selections as inline tags, sends on Enter and pastes images', async () => {
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ left: 0, top: 0, bottom: 0, width: 0, height: 0, right: 0 }),
    })
    const conversation = { id: 'chat-1', title: '新对话', createdAt: 1, updatedAt: 1 }
    const attachment: AgentAttachment = {
      id: 'image-1',
      conversationId: conversation.id,
      name: 'clipboard.png',
      mimeType: 'image/png',
      sizeBytes: 4,
    }
    const historyMessages: AgentMessage[] = []
    const send = vi.fn().mockImplementation(async (_id: string, parts: AgentDraftPart[]) => {
      historyMessages.push({
        id: `message-${historyMessages.length}`,
        role: 'user',
        parts,
        attachments: [],
      })
    })
    const deleteConversation = vi.fn().mockResolvedValue(undefined)
    const compact = vi.fn().mockResolvedValue(undefined)
    const renameConversation = vi.fn().mockImplementation(async (_id: string, title: string) => {
      conversation.title = title
      return conversation
    })
    let onAgentEvent: ((event: AgentEvent) => void) | undefined
    const uploadBytes = vi.fn().mockResolvedValue(attachment)
    const removeUpload = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window, 'zhijiApi', {
      value: {
        agent: {
          list: async () => [conversation],
          create: async () => conversation,
          history: async () => ({
            messages: historyMessages,
            pending: null,
            usage: {
              inputTokens: 1200,
              outputTokens: 300,
              cacheReadTokens: 200,
              contextTokens: 64000,
              contextEstimated: true,
              contextWindowTokens: 256000,
            },
          }),
          rename: renameConversation,
          delete: deleteConversation,
          upload: async () => null,
          uploadBytes,
          removeUpload,
          preview: async () => 'data:image/png;base64,iVBORw0KGgo=',
          send,
          compact,
          resume: async () => {},
          cancel: async () => {},
          onEvent: (listener: (event: AgentEvent) => void) => {
            onAgentEvent = listener
            return () => {
              onAgentEvent = undefined
            }
          },
        },
      },
      configurable: true,
    })
    const host = document.createElement('div')
    document.body.appendChild(host)
    const wrapper = mount(AgentView, {
      attachTo: host,
      props: {
        mcpEnabled: true,
        multimodal: true,
        dark: false,
        resumes: [{ id: 7, name: '前端简历' } as ResumeVersion],
        opportunities: [{ id: 9, companyName: '示例公司', title: '前端工程师' } as Opportunity],
        companies: [
          {
            id: 11,
            name: '字节示例公司',
            aliases: ['示例科技'],
            industryName: '互联网',
          } as Company,
        ],
        industries: [{ id: 13, name: '互联网' } as Industry],
      },
      global,
    })
    await flushPromises()
    expect(wrapper.find('.agent-usage').text()).toContain('输入 1.2k')
    expect(wrapper.find('.agent-usage').text()).not.toContain('估算')
    expect(wrapper.find('.agent-context-ring').attributes('title')).toContain(
      '下一次模型请求后校准',
    )
    expect(wrapper.find('.agent-usage').text()).toContain('25%')
    const editor = wrapper.find('[role="textbox"]').element as HTMLElement
    typeAtCaret(editor, '@')
    await flushPromises()
    expect(
      [...document.querySelectorAll('.agent-command-option')].map((item) => item.textContent),
    ).toEqual(['简历', '求职记录', '公司', '行业'])
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    editor.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )
    await flushPromises()
    expect(document.querySelector('.agent-command-option')?.textContent).toContain('示例公司')
    document
      .querySelector('.agent-command-heading button')
      ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    await flushPromises()
    chooseOption(0)
    typeAtCaret(editor, '@前')
    await flushPromises()
    expect(document.querySelectorAll('.agent-command-option')).toHaveLength(1)
    expect(document.querySelector('.agent-command-option')?.textContent).toContain('前端简历')
    document
      .querySelector('.agent-command-heading button')
      ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    await flushPromises()
    expect(
      [...document.querySelectorAll('.agent-command-option')].map((item) => item.textContent),
    ).toEqual(['简历', '求职记录', '公司', '行业'])
    chooseOption(0)
    typeAtCaret(editor, '@前')
    await flushPromises()
    chooseOption(0)
    await flushPromises()
    expect(editor.querySelector('.agent-reference')?.textContent).toBe('@简历 / 前端简历')
    expect(editor.textContent).not.toContain('[resumeId=7]')
    editor.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    )
    expect(editor.textContent).toContain('\n')
    expect(send).not.toHaveBeenCalled()
    editor.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )
    await flushPromises()
    expect(send).toHaveBeenCalledWith(
      conversation.id,
      expect.arrayContaining([{ kind: 'resume', id: 7, name: '前端简历' }]),
      [],
    )
    expect(wrapper.find('.agent-message .agent-reference').text()).toBe('@简历 / 前端简历')

    typeAtCaret(editor, '@示例科技')
    await flushPromises()
    expect(document.querySelectorAll('.agent-command-option')).toHaveLength(1)
    expect(document.querySelector('.agent-command-option')?.textContent).toContain('字节示例公司')
    chooseOption(0)
    await flushPromises()
    expect(editor.querySelector('.agent-reference')?.textContent).toBe('@公司 / 字节示例公司')

    typeAtCaret(editor, '@')
    await flushPromises()
    chooseOption(3)
    typeAtCaret(editor, '@互')
    await flushPromises()
    expect(document.querySelectorAll('.agent-command-option')).toHaveLength(1)
    chooseOption(0)
    await flushPromises()
    expect(editor.querySelector('.agent-reference')?.textContent).toBe('@行业 / 互联网')

    let finishPendingSend!: () => void
    send.mockImplementationOnce(
      (_id: string, parts: AgentDraftPart[]) =>
        new Promise<void>((resolve) => {
          finishPendingSend = () => {
            historyMessages.push(
              { id: 'timeline-user', role: 'user', parts, attachments: [] },
              { id: 'timeline-intro', role: 'assistant', text: '先说明', attachments: [] },
              {
                id: 'tool:read-a',
                role: 'tool',
                toolCallId: 'read-a',
                name: 'list_statuses',
                args: '{}',
                result: '{}',
                status: 'completed',
                attachments: [],
              },
              {
                id: 'tool:read-b',
                role: 'tool',
                toolCallId: 'read-b',
                name: 'list_companies',
                args: '{}',
                result: '{}',
                status: 'completed',
                attachments: [],
              },
              { id: 'timeline-end', role: 'assistant', text: '后总结', attachments: [] },
            )
            resolve()
          }
        }),
    )
    typeAtCaret(editor, '工具调用测试')
    editor.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )
    await flushPromises()
    expect(wrapper.findAll('.agent-message.user').at(-1)?.text()).toContain('工具调用测试')
    expect(wrapper.text()).toContain('智能体正在思考')
    onAgentEvent?.({ conversationId: conversation.id, kind: 'title', text: '工具调用测试' })
    await flushPromises()
    expect(wrapper.find('.agent-intro strong').text()).toBe('工具调用测试')
    onAgentEvent?.({ conversationId: conversation.id, kind: 'token', text: '先说明' })
    onAgentEvent?.({
      conversationId: conversation.id,
      kind: 'tool-start',
      toolCallId: 'read-a',
      toolName: 'list_statuses',
    })
    onAgentEvent?.({
      conversationId: conversation.id,
      kind: 'tool-start',
      toolCallId: 'read-b',
      toolName: 'list_companies',
    })
    await flushPromises()
    expect(wrapper.findAll('.agent-tool-row')).toHaveLength(2)
    onAgentEvent?.({
      conversationId: conversation.id,
      kind: 'tool-end',
      toolCallId: 'read-a',
      toolResult: '{"items":[]}',
      toolStatus: 'completed',
    })
    await flushPromises()
    expect(wrapper.findAll('.agent-tool-row')[0].text()).toContain('已完成')
    expect(wrapper.findAll('.agent-tool-row')[1].text()).toContain('调用中')
    onAgentEvent?.({
      conversationId: conversation.id,
      kind: 'tool-end',
      toolCallId: 'read-b',
      toolResult: '{}',
      toolStatus: 'completed',
    })
    onAgentEvent?.({ conversationId: conversation.id, kind: 'token', text: '后总结' })
    await flushPromises()
    expect(wrapper.findAll('.agent-message.assistant').map((item) => item.text())).toEqual([
      '先说明',
      '后总结',
    ])
    expect(
      wrapper
        .findAll('.agent-message, .agent-tool-group')
        .slice(-3)
        .map((item) => item.classes()[0]),
    ).toEqual(['agent-message', 'agent-tool-group', 'agent-message'])
    expect(wrapper.find('.agent-tool-group-toggle').exists()).toBe(true)
    expect(wrapper.find('.agent-tool-group-toggle').attributes('aria-expanded')).toBe('false')
    expect(wrapper.findAll('.agent-tool-row')).toHaveLength(0)
    await wrapper.find('.agent-tool-group-toggle').trigger('click')
    expect(wrapper.findAll('.agent-tool-row')).toHaveLength(2)
    expect(wrapper.findAll('.agent-message > small')).toHaveLength(0)
    finishPendingSend()
    await flushPromises()
    expect(wrapper.findAll('.agent-tool-row')).toHaveLength(2)
    expect(wrapper.findAll('.agent-message.assistant').map((item) => item.text())).toEqual([
      '先说明',
      '后总结',
    ])

    typeAtCaret(editor, 'hello@')
    await flushPromises()
    expect(document.querySelector('.agent-command-popup')).toBeNull()
    typeAtCaret(editor, '你好@')
    await flushPromises()
    expect(document.querySelectorAll('.agent-command-option')).toHaveLength(4)

    typeAtCaret(editor, 'https://example.com/path')
    await flushPromises()
    expect(document.querySelector('.agent-command-popup')).toBeNull()

    typeAtCaret(editor, '/')
    await flushPromises()
    expect(document.querySelector('.agent-command-option.active')?.textContent).toContain(
      '/compact',
    )
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown', bubbles: true }))
    await flushPromises()
    expect(document.querySelector('.agent-command-option.active')?.textContent).toContain(
      '/resume-match',
    )
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowUp', bubbles: true }))
    await flushPromises()
    expect(document.querySelector('.agent-command-option.active')?.textContent).toContain(
      '/compact',
    )
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown', bubbles: true }))
    editor.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )
    await flushPromises()
    expect(editor.querySelector('.agent-reference')?.textContent).toBe('/简历匹配')
    editor.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }),
    )
    await flushPromises()

    typeAtCaret(editor, '/res')
    await flushPromises()
    expect(document.querySelector('.agent-command-option')?.textContent).toContain('/resume-match')
    expect(document.querySelector('.agent-command-option small')?.textContent).toBe(
      '评估简历与岗位的匹配度、优势和缺口',
    )
    editor.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    )
    expect(editor.textContent).toContain('\n')
    typeAtCaret(editor, '/res')
    await flushPromises()
    chooseOption(0)
    await flushPromises()
    expect(editor.querySelector('.agent-reference')?.textContent).toBe('/简历匹配')
    editor.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }),
    )
    await flushPromises()
    expect(editor.querySelector('.agent-reference')).toBeNull()
    typeAtCaret(editor, '/res')
    await flushPromises()
    chooseOption(0)
    await flushPromises()

    const pasteText = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(pasteText, 'clipboardData', {
      value: { items: [], getData: () => '<b>岗位描述</b>' },
    })
    editor.dispatchEvent(pasteText)
    expect(editor.querySelector('b')).toBeNull()
    expect(editor.textContent).toContain('<b>岗位描述</b>')
    editor.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )
    await flushPromises()
    expect(send).toHaveBeenLastCalledWith(
      conversation.id,
      expect.arrayContaining([{ kind: 'skill', name: 'resume-match' }]),
      [],
    )

    send.mockRejectedValueOnce(new Error('模型暂时不可用'))
    typeAtCaret(editor, '保留这段草稿')
    editor.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )
    await flushPromises()
    expect(editor.textContent).toContain('保留这段草稿')

    const file = new File([new Uint8Array([137, 80, 78, 71])], 'clipboard.png', {
      type: 'image/png',
    })
    Object.defineProperty(file, 'arrayBuffer', {
      value: async () => new Uint8Array([137, 80, 78, 71]).buffer,
    })
    const paste = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', {
      value: { items: [{ type: 'image/png', getAsFile: () => file }] },
    })
    editor.dispatchEvent(paste)
    await flushPromises()
    expect(uploadBytes).toHaveBeenCalledWith(
      conversation.id,
      expect.stringMatching(/^clipboard-.*\.png$/),
      'image/png',
      expect.any(Uint8Array),
    )
    expect(wrapper.find('.agent-compose-attachments img').attributes('src')).toMatch(
      /^data:image\/png/,
    )
    await wrapper.find('.agent-attachment-remove').trigger('click')
    await flushPromises()
    expect(removeUpload).toHaveBeenCalledWith(conversation.id, attachment.id)
    expect(wrapper.find('.agent-compose-attachments').exists()).toBe(false)
    typeAtCaret(editor, '/comp')
    await flushPromises()
    expect(document.querySelector('.agent-command-option')?.textContent).toContain('/compact')
    chooseOption(0)
    await flushPromises()
    expect(editor.querySelector('.agent-reference')?.textContent).toBe('/compact')
    editor.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )
    await flushPromises()
    expect(compact).toHaveBeenCalledWith(conversation.id)
    expect(wrapper.find('.agent-history-row').text()).not.toContain('删除')
    await wrapper.find('.agent-history-row').trigger('contextmenu', { clientX: 12, clientY: 24 })
    await flushPromises()
    expect(document.querySelector('.n-dropdown-option')?.textContent).toContain('重命名')
    document
      .querySelector('.n-dropdown-option-body')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    const renameInput = [...document.querySelectorAll('.n-card input')].find((input) =>
      (input as HTMLInputElement).placeholder.includes('对话标题'),
    ) as HTMLInputElement | undefined
    expect(renameInput).toBeTruthy()
    renameInput!.value = '求职咨询'
    renameInput!.dispatchEvent(new Event('input', { bubbles: true }))
    const saveTitle = [...document.querySelectorAll('.n-card button')].find(
      (button) => button.textContent?.trim() === '保存标题',
    )
    saveTitle?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    expect(renameConversation).toHaveBeenCalledWith(conversation.id, '求职咨询')
    expect(wrapper.find('.agent-intro strong').text()).toBe('求职咨询')
    await wrapper.find('.agent-history-row').trigger('contextmenu', { clientX: 12, clientY: 24 })
    await flushPromises()
    const deleteOption = [...document.querySelectorAll('.n-dropdown-option-body')].find((option) =>
      option.textContent?.includes('删除'),
    )
    deleteOption?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    expect(document.body.textContent).toContain('删除该对话及其附件？')
    const confirm = [...document.querySelectorAll('.n-card button')].find(
      (button) => button.textContent?.trim() === '删除',
    )
    confirm?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    expect(deleteConversation).toHaveBeenCalledWith(conversation.id)
    wrapper.unmount()
    host.remove()
  })

  it('uses the same localized reference labels in the editor and sent-message body', async () => {
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ left: 0, top: 0, bottom: 0, width: 0, height: 0, right: 0 }),
    })
    i18n.global.locale.value = 'en-US'
    const host = document.createElement('div')
    document.body.appendChild(host)
    const editorWrapper = mount(AgentComposerEditor, {
      attachTo: host,
      props: {
        modelValue: '',
        placeholder: 'Ask',
        disabled: false,
        mcpEnabled: true,
        resumes: [],
        opportunities: [],
        companies: [],
        industries: [],
        dark: false,
      },
      global,
    })
    try {
      const editor = editorWrapper.find('[role="textbox"]').element as HTMLElement
      typeAtCaret(editor, '/res')
      await flushPromises()
      expect(document.querySelector('.agent-command-option small')?.textContent).toBe(
        'Score resume–job fit, strengths, and gaps',
      )
      chooseOption(0)
      await flushPromises()
      const label = editor.querySelector('.agent-reference')?.textContent
      const parts = (editorWrapper.vm as unknown as { readParts(): AgentDraftPart[] }).readParts()
      const body = mount(AgentMessageBody, { props: { parts }, global })
      expect(body.find('.agent-reference').text()).toBe(label)
      expect(label).toBe('/Resume match')
      body.unmount()
      const plain = mount(AgentMessageBody, {
        props: { parts: [{ kind: 'text', text: '@简历「伪造」[resumeId=7]' }] },
        global,
      })
      expect(plain.find('.agent-reference').exists()).toBe(false)
      plain.unmount()
    } finally {
      editorWrapper.unmount()
      host.remove()
      i18n.global.locale.value = 'zh-CN'
    }
  })
})
