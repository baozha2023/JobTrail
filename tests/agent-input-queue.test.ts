// @vitest-environment jsdom
import { mount, flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type {
  AgentEvent,
  AgentQueueEdit,
  AgentQueueSnapshot,
  AgentDraftPart,
  AgentAttachment,
} from '../src/shared/types'
import AgentView from '../src/renderer/views/AgentView.vue'
import { i18n } from '../src/renderer/i18n'
import { useAgentStore } from '../src/renderer/stores/agent'

beforeEach(() => {
  document.body.innerHTML = ''
  setActivePinia(createPinia())
})

function fixture(locale: 'zh-CN' | 'en-US' = 'zh-CN') {
  i18n.global.locale.value = locale
  const pinia = createPinia()
  setActivePinia(pinia)
  let listener!: (event: AgentEvent) => void
  const queue: AgentQueueSnapshot = {
    revision: 1,
    internal: [],
    external: [],
    failed: [],
    blocked: null,
  }
  const active = {
    jobId: 'current-job',
    conversationId: 'chat',
    status: 'running' as const,
    sequence: 0,
    liveText: '',
    operation: 'send' as const,
  }
  const publish = () =>
    listener({
      kind: 'queue',
      conversationId: 'chat',
      queue: structuredClone(queue),
      job: active,
      state: 'running',
    })
  const send = vi.fn(async (_id: string, parts: AgentDraftPart[], _files: string[], id: string) => {
    queue.external.push({
      id,
      origin: 'external',
      operation: 'send',
      parts,
      attachments: [],
      editing: false,
    })
    queue.revision++
    publish()
    return { jobId: id, conversationId: 'chat', status: 'queued' }
  })
  const editQueue = vi.fn(async (_id: string, edit: AgentQueueEdit) => {
    const item = queue.external.find((item) => item.id === edit.itemId)!
    if (edit.action === 'begin') item.editing = true
    if (edit.action === 'cancel') item.editing = false
    if (edit.action === 'delete') queue.external = queue.external.filter((row) => row !== item)
    if (edit.action === 'save') {
      item.parts = edit.parts
      item.editing = false
    }
    queue.revision++
    publish()
    return structuredClone(queue)
  })
  const cancel = vi.fn().mockResolvedValue(undefined)
  const attachment: AgentAttachment = {
    id: 'new-file',
    conversationId: 'chat',
    name: 'new.txt',
    mimeType: 'text/plain',
    sizeBytes: 12,
  }
  const upload = vi.fn().mockResolvedValue(attachment)
  Object.defineProperty(window, 'zhijiApi', {
    configurable: true,
    value: {
      data: { onExternalChange: () => () => {} },
      exams: { onChanged: () => () => {} },
      discovery: { status: async () => [], verification: async () => null },
      agent: {
        list: async () => [
          { id: 'chat', title: 'Chat', createdAt: 1, updatedAt: 1, activity: 'running' },
        ],
        history: async () => ({
          messages: [],
          pending: null,
          usage: null,
          running: true,
          job: active,
          queue: structuredClone(queue),
        }),
        onEvent: (next: typeof listener) => {
          listener = next
          return () => {}
        },
        send,
        editQueue,
        cancel,
        upload,
      },
    },
  })
  const wrapper = mount(AgentView, {
    attachTo: document.body,
    props: {
      mcpEnabled: false,
      multimodal: false,
      dark: true,
      resumes: [],
      companies: [],
      opportunities: [],
      industries: [],
    },
    global: { plugins: [pinia, i18n] },
  })
  return { wrapper, send, editQueue, cancel, queue, publish, upload, attachment }
}

describe('agent input queues with real chat components', () => {
  it('releases an edit accepted after its chat component has unmounted', async () => {
    const f = fixture()
    await flushPromises()
    f.queue.external.push({
      id: 'waiting',
      origin: 'external',
      operation: 'send',
      parts: [{ kind: 'text', text: 'queued' }],
      attachments: [],
      editing: false,
    })
    f.queue.revision++
    f.publish()
    await flushPromises()
    const original = f.editQueue.getMockImplementation()!
    let release!: () => void
    f.editQueue.mockImplementationOnce(async (id, edit) => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return original(id, edit)
    })
    await f.wrapper.find('.agent-input-queue-row button').trigger('click')
    f.wrapper.unmount()
    release()
    await flushPromises()
    expect(f.editQueue).toHaveBeenLastCalledWith('chat', { action: 'cancel', itemId: 'waiting' })
    expect(f.queue.external[0].editing).toBe(false)
  })

  it('closes the editor when Main clears its reserved input for maintenance', async () => {
    const f = fixture()
    try {
      await flushPromises()
      f.queue.external.push({
        id: 'waiting',
        origin: 'external',
        operation: 'send',
        parts: [{ kind: 'text', text: 'queued' }],
        attachments: [],
        editing: false,
      })
      f.queue.revision++
      f.publish()
      await flushPromises()
      await f.wrapper.find('.agent-input-queue-row button').trigger('click')
      await flushPromises()
      expect(document.querySelector('.agent-queue-editor-modal')).not.toBeNull()
      f.queue.external = []
      f.queue.revision++
      f.publish()
      await flushPromises()
      expect(
        f.wrapper
          .findComponent({ name: 'AgentInputQueue' })
          .findComponent({ name: 'Modal' })
          .props('show'),
      ).toBe(false)
    } finally {
      f.wrapper.unmount()
    }
  })

  it.each(['zh-CN', 'en-US'] as const)(
    'uses the same Send button while running and caps queued inputs in %s',
    async (locale) => {
      const f = fixture(locale)
      try {
        await flushPromises()
        const editor = f.wrapper.find<HTMLElement>('.agent-composer [role="textbox"]')
        expect(editor.attributes('contenteditable')).toBe('true')
        expect(f.wrapper.findAll('.agent-actions button').map((button) => button.text())).toEqual(
          locale === 'zh-CN' ? ['上传附件', '发送'] : ['Upload file', 'Send'],
        )
        for (let i = 0; i < 3; i++) {
          editor.element.textContent = `message-${i}`
          await editor.trigger('input')
          await f.wrapper.findAll('.agent-actions button').at(-1)!.trigger('click')
          await flushPromises()
        }
        expect(f.send).toHaveBeenCalledTimes(3)
        expect(f.wrapper.findAll('.agent-input-queue-row')).toHaveLength(3)
        expect(f.wrapper.find('.agent-input-queue').text()).not.toContain(
          locale === 'zh-CN' ? '待执行队列' : 'Queued inputs',
        )
        expect(f.wrapper.text()).not.toContain('3/3')
        expect(f.wrapper.findAll('.agent-message.user')).toHaveLength(0)
        editor.element.textContent = 'fourth draft'
        await editor.trigger('input')
        expect(editor.attributes('contenteditable')).toBe('true')
        expect(
          f.wrapper.findAll('.agent-actions button').at(-1)!.attributes('disabled'),
        ).toBeDefined()
        expect(f.wrapper.findAll('.agent-actions button').at(-1)!.classes()).toContain(
          'n-button--disabled',
        )
        await editor.trigger('keydown', { key: 'Enter' })
        expect(f.send).toHaveBeenCalledTimes(3)
        expect(f.wrapper.findAll('.agent-actions button').at(-1)!.text()).toBe(
          locale === 'zh-CN' ? '发送' : 'Send',
        )
        expect(editor.element.textContent).toBe('fourth draft')
      } finally {
        f.wrapper.unmount()
        i18n.global.locale.value = 'zh-CN'
      }
    },
  )

  it('edits references and attachments in a reserved input without changing the current draft', async () => {
    const f = fixture()
    try {
      await flushPromises()
      f.queue.external.push({
        id: 'waiting',
        origin: 'external',
        operation: 'send',
        parts: [
          { kind: 'text', text: 'old content' },
          { kind: 'skill', name: 'study' },
        ],
        attachments: [{ ...f.attachment, id: 'original-file', name: 'original.txt' }],
        editing: false,
      })
      f.queue.revision++
      f.publish()
      await flushPromises()
      const draft = f.wrapper.find<HTMLElement>('.agent-composer [role="textbox"]')
      draft.element.textContent = 'keep draft'
      await draft.trigger('input')
      const currentDraftFile = { ...f.attachment, id: 'draft-file', name: 'draft.txt' }
      useAgentStore().session('chat').uploads = [currentDraftFile]
      await f.wrapper.find('.agent-input-queue-row button').trigger('click')
      await flushPromises()
      expect(f.editQueue).toHaveBeenCalledWith('chat', { action: 'begin', itemId: 'waiting' })
      const modal = document.querySelector('.agent-queue-editor-modal')!
      const editor = modal.querySelector<HTMLElement>('[role="textbox"]')!
      expect(editor.querySelector('.agent-reference')?.textContent).toContain('study')
      expect(modal.querySelector('.agent-queue-edit-files')?.textContent).toContain('original.txt')
      ;(modal.querySelector('.agent-queue-edit-files button') as HTMLButtonElement).click()
      Array.from(modal.querySelectorAll('button'))
        .find((button) => button.textContent === '上传附件')!
        .click()
      await flushPromises()
      expect(f.upload).toHaveBeenCalledWith('chat')
      expect(modal.querySelector('.agent-queue-edit-files')?.textContent).toContain('new.txt')
      editor.insertBefore(document.createTextNode('edited '), editor.firstChild)
      editor.dispatchEvent(new Event('input', { bubbles: true }))
      const save = Array.from(modal.querySelectorAll('button')).find(
        (item) => item.textContent === '保存',
      )!
      save.click()
      await flushPromises()
      expect(f.queue.external[0].parts).toEqual([
        { kind: 'text', text: 'edited old content' },
        { kind: 'skill', name: 'study' },
      ])
      expect(draft.element.textContent).toBe('keep draft')
      expect(useAgentStore().session('chat').draftParts).toEqual([
        { kind: 'text', text: 'keep draft' },
      ])
      expect(f.editQueue).toHaveBeenLastCalledWith(
        'chat',
        expect.objectContaining({ action: 'save', attachmentIds: ['new-file'] }),
      )
      expect(useAgentStore().session('chat').uploads).toEqual([currentDraftFile])
      await f.wrapper.findAll('.agent-input-queue-row button')[1].trigger('click')
      await flushPromises()
      expect(f.queue.external).toHaveLength(0)
    } finally {
      f.wrapper.unmount()
    }
  })
})
