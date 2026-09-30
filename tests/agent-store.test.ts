// @vitest-environment jsdom

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentStore } from '../src/renderer/stores/agent'
import { i18n } from '../src/renderer/i18n'
import { getErrorMessage } from '../src/renderer/utils/errors'
import type { AgentEvent, AgentHistory, AgentJobSnapshot } from '../src/shared/types'

const eventSubscriptions = {
  data: { onExternalChange: () => () => {} },
}

const conversations = [
  { id: 'chat-a', title: 'A', createdAt: 1, updatedAt: 1 },
  { id: 'chat-b', title: 'B', createdAt: 2, updatedAt: 2 },
]
const usage: AgentHistory['usage'] = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: null,
  contextTokens: null,
  contextEstimated: true,
  contextWindowTokens: 256000,
}

beforeEach(() => setActivePinia(createPinia()))

describe('agent session store', () => {
  it('releases both event subscriptions when startup fails before retrying', async () => {
    const stopAgent = vi.fn()
    const stopExternal = vi.fn()
    const list = vi.fn().mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue([])
    const onEvent = vi.fn(() => stopAgent)
    const onExternalChange = vi.fn(() => stopExternal)
    Object.defineProperty(window, 'zhijiApi', {
      configurable: true,
      value: { agent: { list, onEvent }, data: { onExternalChange } },
    })
    const store = useAgentStore()
    await expect(store.start()).rejects.toThrow('unavailable')
    expect(stopAgent).toHaveBeenCalledOnce()
    expect(stopExternal).toHaveBeenCalledOnce()
    await store.start()
    expect(onEvent).toHaveBeenCalledTimes(2)
    expect(onExternalChange).toHaveBeenCalledTimes(2)
    store.stop()
    expect(stopExternal).toHaveBeenCalledTimes(2)
  })
  it.each([
    {
      code: 'AGENT_WORKER_EXITED' as const,
      zh: '智能体执行进程意外退出，请重试',
      en: 'The agent process exited unexpectedly. Please try again.',
    },
    {
      code: 'AI_API_KEY_EMPTY' as const,
      zh: '当前 API Key 为空',
      en: 'The current API Key is empty.',
    },
  ])('renders $code in the selected language', async ({ code, zh, en }) => {
    let listener: ((event: AgentEvent) => void) | undefined
    Object.defineProperty(window, 'zhijiApi', {
      configurable: true,
      value: {
        ...eventSubscriptions,
        agent: {
          list: async () => conversations.map((conversation) => ({ ...conversation })),
          onEvent: (next: (event: AgentEvent) => void) => {
            listener = next
            return () => undefined
          },
        },
      },
    })
    const store = useAgentStore()
    await store.start()
    const originalLocale = i18n.global.locale.value
    try {
      i18n.global.locale.value = 'zh-CN'
      listener?.({
        conversationId: 'chat-a',
        jobId: 'worker-job',
        sequence: 1,
        kind: 'error',
        errorCode: code,
      })
      expect(store.session('chat-a').error).toBe(zh)
      i18n.global.locale.value = 'en-US'
      listener?.({
        conversationId: 'chat-a',
        jobId: 'worker-job',
        sequence: 2,
        kind: 'error',
        errorCode: code,
      })
      expect(store.session('chat-a').error).toBe(en)
      if (code === 'AI_API_KEY_EMPTY') {
        expect(getErrorMessage({ code, message: 'raw diagnostics' }, i18n.global.t)).toBe(en)
      }
    } finally {
      i18n.global.locale.value = originalLocale
      store.stop()
    }
  })

  it('accepts the first event of a new job before the previous history refresh finishes', async () => {
    let listener: ((event: AgentEvent) => void) | undefined
    const api = {
      list: vi.fn(async () => conversations.map((conversation) => ({ ...conversation }))),
      history: vi.fn(async () => ({
        messages: [],
        pending: null,
        usage,
        running: false,
        job: null,
      })),
      send: vi.fn(async (id: string, _parts: unknown, _attachments: unknown, jobId: string) => ({
        jobId,
        conversationId: id,
        status: 'queued' as const,
      })),
      onEvent: vi.fn((next: (event: AgentEvent) => void) => {
        listener = next
        return () => undefined
      }),
    }
    Object.defineProperty(window, 'zhijiApi', {
      configurable: true,
      value: { ...eventSubscriptions, agent: api },
    })
    const store = useAgentStore()
    await store.start()
    const state = store.session('chat-a')
    state.sequence = 9
    state.activity = 'idle'
    await store.send('chat-a', [{ kind: 'text', text: '新消息' }], [])
    listener?.({
      conversationId: 'chat-a',
      jobId: state.jobId!,
      sequence: 1,
      kind: 'token',
      text: '新回复',
    })
    expect(state.sequence).toBe(1)
    expect(state.messages.at(-1)).toMatchObject({ role: 'assistant', text: '新回复' })
    store.stop()
  })

  it('restores an unsaved draft from the terminal receipt even without an error event', async () => {
    let listener: ((event: AgentEvent) => void) | undefined
    const api = {
      list: vi.fn(async () => conversations.map((conversation) => ({ ...conversation }))),
      history: vi.fn(async () => ({
        messages: [],
        pending: null,
        usage,
        running: false,
        job: null,
      })),
      send: vi.fn(async (id: string, _parts: unknown, _attachments: unknown, jobId: string) => ({
        jobId,
        conversationId: id,
        status: 'running' as const,
      })),
      onEvent: vi.fn((next: (event: AgentEvent) => void) => {
        listener = next
        return () => undefined
      }),
    }
    Object.defineProperty(window, 'zhijiApi', {
      configurable: true,
      value: { ...eventSubscriptions, agent: api },
    })
    const store = useAgentStore()
    await store.start()
    const parts = [{ kind: 'text' as const, text: '未保存' }]
    await store.send('chat-a', parts, [])
    expect(api.send).toHaveBeenCalledOnce()
    expect(store.session('chat-a').submitted).toMatchObject({ parts })
    const jobId = store.session('chat-a').jobId!
    listener?.({
      conversationId: 'chat-a',
      jobId,
      sequence: 1,
      kind: 'state',
      state: 'idle',
      submissionState: 'not-saved',
    })
    expect(store.session('chat-a').draftParts).toEqual(parts)
    expect(store.session('chat-a').messages).toEqual([])
    expect(store.session('chat-a').error).toBeTruthy()
    store.stop()
  })

  it('restores an unsaved queued submission after renderer reload and cancellation', async () => {
    const jobId = '10000000-0000-4000-8000-000000000001'
    const parts = [{ kind: 'text' as const, text: '排队草稿' }]
    let listener: ((event: AgentEvent) => void) | undefined
    const api = {
      list: vi.fn(async () => [{ ...conversations[0], activity: 'queued' as const }]),
      history: vi.fn(async () => ({
        messages: [],
        pending: null,
        usage,
        running: true,
        job: {
          jobId,
          conversationId: 'chat-a',
          status: 'queued' as const,
          sequence: 1,
          liveText: '',
          submittedParts: parts,
          submittedAttachments: [],
        },
      })),
      onEvent: vi.fn((next: (event: AgentEvent) => void) => {
        listener = next
        return () => undefined
      }),
    }
    Object.defineProperty(window, 'zhijiApi', {
      configurable: true,
      value: { ...eventSubscriptions, agent: api },
    })
    const store = useAgentStore()
    await store.start()
    await store.select('chat-a')
    expect(store.session('chat-a').messages.at(-1)).toMatchObject({ role: 'user', parts })
    listener?.({
      conversationId: 'chat-a',
      jobId,
      sequence: 2,
      kind: 'error',
      errorCode: 'AGENT_CANCELLED',
      submissionState: 'not-saved',
    })
    expect(store.session('chat-a').draftParts).toEqual(parts)
    expect(store.session('chat-a').uploads).toEqual([])
    expect(store.session('chat-a').messages).toEqual([])
    store.stop()
  })

  it('keeps two chats independent while navigating and restores live output after reload', async () => {
    const jobs = new Map<string, AgentJobSnapshot>()
    let listener: ((event: AgentEvent) => void) | undefined
    const api = {
      list: vi.fn(async () => conversations.map((conversation) => ({ ...conversation }))),
      history: vi.fn(async (id: string) => ({
        messages: [],
        pending: null,
        usage,
        running: jobs.has(id),
        job: jobs.get(id) ?? null,
      })),
      send: vi.fn(async (id: string, _parts: unknown, _attachments: unknown, jobId: string) => {
        jobs.set(id, { jobId, conversationId: id, status: 'running', sequence: 1, liveText: '' })
        return { jobId, conversationId: id, status: 'running' }
      }),
      onEvent: vi.fn((next: (event: AgentEvent) => void) => {
        listener = next
        return () => {
          if (listener === next) listener = undefined
        }
      }),
    }
    Object.defineProperty(window, 'zhijiApi', {
      configurable: true,
      value: { ...eventSubscriptions, agent: api },
    })

    const store = useAgentStore()
    await store.start()
    await store.select('chat-a')
    store.session('chat-a').draftParts = [{ kind: 'text', text: 'A 草稿' }]
    await store.send('chat-a', [{ kind: 'text', text: 'A 消息' }], [])
    const aJobId = store.session('chat-a').jobId!
    await store.select('chat-b')
    store.session('chat-b').draftParts = [{ kind: 'text', text: 'B 草稿' }]
    await store.send('chat-b', [{ kind: 'text', text: 'B 消息' }], [])
    const bJobId = store.session('chat-b').jobId!

    listener?.({
      conversationId: 'chat-a',
      jobId: aJobId,
      sequence: 2,
      kind: 'token',
      text: '后台继续',
    })
    listener?.({
      conversationId: 'chat-b',
      jobId: bJobId,
      sequence: 2,
      kind: 'token',
      text: 'B 回复',
    })
    listener?.({
      conversationId: 'chat-a',
      jobId: aJobId,
      sequence: 1,
      kind: 'token',
      text: '过期',
    })
    expect(store.currentId).toBe('chat-b')
    expect(store.session('chat-a').messages.at(-1)).toMatchObject({ text: '后台继续' })
    expect(store.session('chat-b').messages.at(-1)).toMatchObject({ text: 'B 回复' })
    expect(store.session('chat-a').draftParts).toEqual([])
    expect(store.session('chat-b').draftParts).toEqual([])

    jobs.get('chat-a')!.sequence = 2
    jobs.get('chat-a')!.liveText = '后台继续'
    await store.select('chat-a')
    expect(store.session('chat-a').messages.at(-1)).toMatchObject({ text: '后台继续' })
    store.stop()

    setActivePinia(createPinia())
    const reloaded = useAgentStore()
    await reloaded.start()
    await reloaded.select('chat-a')
    expect(reloaded.session('chat-a').activity).toBe('running')
    expect(reloaded.session('chat-a').messages.at(-1)).toMatchObject({ text: '后台继续' })
    reloaded.stop()
  })
})
