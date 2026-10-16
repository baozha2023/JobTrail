// @vitest-environment jsdom

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentStore } from '../src/renderer/stores/agent'
import { i18n } from '../src/renderer/i18n'
import { getErrorMessage } from '../src/renderer/utils/errors'
import type { AgentEvent, AgentHistory, AgentJobSnapshot, AgentMessage } from '../src/shared/types'

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

it('submits internal notifications to Main while running, preserves drafts, and never calls ordinary send', async () => {
  const notifyDiscovery = vi.fn().mockResolvedValue({ status: 'queued' })
  const send = vi.fn()
  Object.defineProperty(window, 'zhijiApi', {
    configurable: true,
    value: { agent: { notifyDiscovery, send } },
  })
  const store = useAgentStore(),
    state = store.session('chat-a')
  state.activity = 'running'
  state.draftParts = [{ kind: 'text', text: 'keep draft' }]
  const card = { platform: 'boss' as const, state: 'challenge', reason: 'visible UI only' }
  await store.queueDiscoveryContinuation('chat-a', card)
  expect(notifyDiscovery).toHaveBeenCalledWith('chat-a', { platform: 'boss' }, expect.any(String))
  expect(send).not.toHaveBeenCalled()
  expect(state.draftParts).toEqual([{ kind: 'text', text: 'keep draft' }])
})

it('retains drafts on a rejected notification without retrying or reconciling ordinary submissions', async () => {
  const notifyDiscovery = vi.fn().mockRejectedValue({ code: 'VALIDATION_ERROR' })
  const history = vi.fn()
  Object.defineProperty(window, 'zhijiApi', {
    configurable: true,
    value: { agent: { notifyDiscovery, history } },
  })
  const store = useAgentStore(),
    state = store.session('chat-a')
  state.draftParts = [{ kind: 'text', text: 'keep' }]
  await store.queueDiscoveryContinuation('chat-a', { platform: 'boss' })
  expect(notifyDiscovery).toHaveBeenCalledOnce()
  expect(history).not.toHaveBeenCalled()
  expect(state.draftParts).toEqual([{ kind: 'text', text: 'keep' }])
})

it('reconciles a lost discovery notification receipt without sending a duplicate or clearing the draft', async () => {
  const notifyDiscovery = vi.fn().mockRejectedValue(new Error('receipt lost'))
  const submission = vi.fn(async (id: string, jobId: string) => ({
    conversationId: id,
    jobId,
    status: 'queued',
  }))
  const history = vi.fn(async () => ({ messages: [], pending: null, usage, running: false }))
  Object.defineProperty(window, 'zhijiApi', {
    configurable: true,
    value: { agent: { notifyDiscovery, submission, history } },
  })
  const store = useAgentStore(),
    state = store.session('chat-a')
  state.draftParts = [{ kind: 'text', text: 'keep' }]
  await store.queueDiscoveryContinuation('chat-a', { platform: 'boss' })
  expect(notifyDiscovery).toHaveBeenCalledOnce()
  expect(submission).toHaveBeenCalledWith('chat-a', notifyDiscovery.mock.calls[0][2])
  expect(history).toHaveBeenCalledOnce()
  expect(state.error).toBe('')
  expect(state.draftParts).toEqual([{ kind: 'text', text: 'keep' }])
})

describe('agent session store', () => {
  it('restores the running operation from history after a Renderer reload', async () => {
    const job: AgentJobSnapshot = {
      jobId: 'compact-job',
      conversationId: 'chat-a',
      status: 'running',
      operation: 'compact',
      sequence: 0,
      liveText: '',
    }
    Object.defineProperty(window, 'zhijiApi', {
      configurable: true,
      value: {
        agent: { history: async () => ({ messages: [], pending: null, usage, job }) },
      },
    })
    const store = useAgentStore()
    await store.select('chat-a')
    expect(store.session('chat-a').compacting).toBe(true)
    job.operation = 'send'
    await store.loadHistory('chat-a')
    expect(store.session('chat-a').compacting).toBe(false)
  })

  it('updates a direct notification bubble from the execution snapshot without showing it in the queue or duplicating it', async () => {
    let listener!: (event: AgentEvent) => void
    Object.defineProperty(window, 'zhijiApi', {
      configurable: true,
      value: {
        ...eventSubscriptions,
        agent: {
          list: async () => conversations,
          onEvent: (next: typeof listener) => {
            listener = next
            return () => {}
          },
        },
      },
    })
    const store = useAgentStore()
    await store.start()
    const job: AgentJobSnapshot = {
      jobId: 'direct-notification',
      conversationId: 'chat-a',
      status: 'running',
      operation: 'send',
      sequence: 0,
      liveText: '',
      submittedParts: [{ kind: 'text', text: 'preview language' }],
    }
    listener({
      conversationId: 'chat-a',
      kind: 'queue',
      job,
      state: 'running',
      queue: { revision: 1, internal: [], external: [], failed: [], blocked: null },
    })
    listener({
      conversationId: 'chat-a',
      kind: 'queue',
      job: { ...job, sequence: 1, submittedParts: [{ kind: 'text', text: 'execution language' }] },
      state: 'running',
      queue: { revision: 2, internal: [], external: [], failed: [], blocked: null },
    })
    const state = store.session('chat-a')
    expect(state.queue.internal).toEqual([])
    expect(state.queue.external).toEqual([])
    expect(state.messages).toEqual([
      {
        id: 'optimistic:direct-notification',
        role: 'user',
        parts: [{ kind: 'text', text: 'execution language' }],
        attachments: [],
      },
    ])
    store.stop()
  })

  it('refreshes history again when only the queue position changes during the read', async () => {
    let listener!: (event: AgentEvent) => void
    let resolveHistory!: (history: AgentHistory) => void
    const messages: AgentMessage[] = [
      { id: 'saved', role: 'assistant', text: 'saved history', attachments: [] },
    ]
    const queue = { revision: 2, internal: [], external: [], failed: [], blocked: null }
    const history = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<AgentHistory>((resolve) => {
            resolveHistory = resolve
          }),
      )
      .mockResolvedValue({ messages, pending: null, usage, running: false, job: null, queue })
    Object.defineProperty(window, 'zhijiApi', {
      configurable: true,
      value: {
        ...eventSubscriptions,
        agent: {
          list: async () => conversations,
          onEvent: (next: typeof listener) => {
            listener = next
            return () => {}
          },
          history,
        },
      },
    })
    const store = useAgentStore()
    await store.start()
    const reading = store.select('chat-a')
    listener({ kind: 'queue', conversationId: 'chat-a', state: 'queued', job: null, queue })
    resolveHistory({
      messages,
      pending: null,
      usage,
      running: false,
      job: null,
      queue: { ...queue, revision: 1 },
    })
    await reading
    expect(history).toHaveBeenCalledTimes(2)
    expect(store.session('chat-a').messages).toEqual(messages)
    store.stop()
  })

  it('refreshes committed history after the terminal queue snapshot retires the running cursor', async () => {
    let listener!: (event: AgentEvent) => void
    const messages: AgentMessage[] = [
      { id: 'saved-reply', role: 'assistant', text: 'committed reply', attachments: [] },
    ]
    Object.defineProperty(window, 'zhijiApi', {
      configurable: true,
      value: {
        ...eventSubscriptions,
        agent: {
          list: async () => conversations,
          onEvent: (next: typeof listener) => {
            listener = next
            return () => {}
          },
          history: async () => ({
            messages,
            pending: null,
            usage,
            running: false,
            job: null,
            queue: { revision: 2, internal: [], external: [], failed: [], blocked: null },
          }),
        },
      },
    })
    const store = useAgentStore()
    await store.start()
    const state = store.session('chat-a')
    state.jobId = 'finishing-job'
    state.sequence = 10
    state.activity = 'running'
    listener({
      conversationId: 'chat-a',
      jobId: 'finishing-job',
      sequence: 11,
      kind: 'state',
      state: 'idle',
    })
    listener({
      conversationId: 'chat-a',
      kind: 'queue',
      job: null,
      state: 'idle',
      queue: { revision: 2, internal: [], external: [], failed: [], blocked: null },
    })
    await vi.waitFor(() => expect(state.messages).toEqual(messages))
    expect(state.jobId).toBeNull()
    listener({
      conversationId: 'chat-a',
      jobId: 'finishing-job',
      sequence: 12,
      kind: 'token',
      text: 'stale reply',
    })
    expect(state.messages).toEqual(messages)
    store.stop()
  })

  it.each(['send', 'compact'] as const)(
    'reconciles an uncertain %s receipt once without resending or replacing a new draft',
    async (operation) => {
      let release!: () => void
      const submit = vi.fn(async () => {
        throw new Error('receipt lost')
      })
      const submission = vi.fn(async (_id: string, jobId: string) => {
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return { jobId, conversationId: 'chat-a', status: 'completed' as const }
      })
      Object.defineProperty(window, 'zhijiApi', {
        configurable: true,
        value: {
          agent: {
            [operation]: submit,
            history: async () => ({ messages: [], pending: null, usage, running: false }),
            submission,
          },
        },
      })
      const store = useAgentStore(),
        state = store.session('chat-a')
      const parts =
        operation === 'compact'
          ? [{ kind: 'command' as const, name: 'compact' as const }]
          : [{ kind: 'text' as const, text: 'original' }]
      state.draftParts = parts
      const pending =
        operation === 'compact' ? store.compact('chat-a', parts) : store.send('chat-a', parts, [])
      await vi.waitFor(() => expect(submission).toHaveBeenCalledOnce())
      state.draftParts = [{ kind: 'text', text: 'new draft' }]
      release()
      expect(await pending).toBe(true)
      expect(submit).toHaveBeenCalledOnce()
      expect(state.draftParts).toEqual([{ kind: 'text', text: 'new draft' }])
      expect(state.unverified).toBe(false)
    },
  )

  it('applies history fetched to recover an event sequence gap', async () => {
    let listener!: (event: AgentEvent) => void
    const recovered: AgentHistory = {
      messages: [{ id: 'saved', role: 'assistant', text: '完整回复', attachments: [] }],
      pending: null,
      usage,
      running: true,
      job: {
        jobId: 'active-job',
        conversationId: 'chat-a',
        status: 'running',
        sequence: 4,
        liveText: '',
      },
    }
    const history = vi.fn(async () => recovered)
    Object.defineProperty(window, 'zhijiApi', {
      configurable: true,
      value: {
        ...eventSubscriptions,
        agent: {
          list: async () => conversations.map((conversation) => ({ ...conversation })),
          onEvent: (next: typeof listener) => {
            listener = next
            return () => {}
          },
          history,
        },
      },
    })
    const store = useAgentStore()
    await store.start()
    const state = store.session('chat-a')
    state.jobId = 'active-job'
    state.sequence = 2
    state.activity = 'running'
    listener({
      conversationId: 'chat-a',
      jobId: 'active-job',
      sequence: 4,
      kind: 'usage',
      usage,
    })
    await vi.waitFor(() => expect(state.messages).toEqual(recovered.messages))
    expect(history).toHaveBeenCalledOnce()
    expect(state.sequence).toBe(4)
    store.stop()
  })
  it('does not overwrite newer usage with a history request started before the event', async () => {
    let listener!: (event: AgentEvent) => void
    let resolveHistory!: (history: AgentHistory) => void
    Object.defineProperty(window, 'zhijiApi', {
      configurable: true,
      value: {
        ...eventSubscriptions,
        agent: {
          list: async () => conversations.map((conversation) => ({ ...conversation })),
          onEvent: (next: typeof listener) => {
            listener = next
            return () => {}
          },
          history: () =>
            new Promise<AgentHistory>((resolve) => {
              resolveHistory = resolve
            }),
        },
      },
    })
    const store = useAgentStore()
    await store.start()
    const state = store.session('chat-a')
    state.jobId = 'active-job'
    state.sequence = 2
    state.activity = 'running'
    const loading = store.select('chat-a')
    const currentUsage = { ...usage, contextTokens: 36000 }
    listener({
      conversationId: 'chat-a',
      jobId: 'active-job',
      sequence: 3,
      kind: 'usage',
      usage: currentUsage,
    })
    resolveHistory({
      messages: [],
      pending: null,
      usage: { ...usage, contextTokens: 20000 },
      running: true,
      job: {
        jobId: 'active-job',
        conversationId: 'chat-a',
        status: 'running',
        sequence: 3,
        liveText: '',
      },
    })
    await loading
    expect(state.usage).toEqual(currentUsage)
    expect(state.sequence).toBe(3)
    store.stop()
  })
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
      jobId: api.send.mock.calls[0][3],
      sequence: 1,
      kind: 'token',
      text: '新回复',
    })
    expect(state.sequence).toBe(1)
    expect(state.messages.at(-1)).toMatchObject({ role: 'assistant', text: '新回复' })
    store.stop()
  })

  it('retains unsaved inputs in Main snapshots without overwriting new drafts, and ignores stale queue snapshots', async () => {
    let listener!: (event: AgentEvent) => void
    Object.defineProperty(window, 'zhijiApi', {
      configurable: true,
      value: {
        ...eventSubscriptions,
        agent: {
          list: async () => conversations,
          onEvent: (next: typeof listener) => {
            listener = next
            return () => {}
          },
          history: async () => ({ messages: [], pending: null, usage, running: false }),
        },
      },
    })
    const store = useAgentStore()
    await store.start()
    const state = store.session('chat-a')
    state.draftParts = [{ kind: 'text', text: 'next draft' }]
    const item = {
      id: 'failed-input',
      origin: 'external' as const,
      operation: 'send' as const,
      parts: [{ kind: 'text' as const, text: 'not saved' }],
      attachments: [],
      editing: false,
    }
    listener({
      kind: 'queue',
      conversationId: 'chat-a',
      state: 'idle',
      job: null,
      queue: { revision: 3, internal: [], external: [], failed: [item], blocked: null },
    })
    listener({
      kind: 'queue',
      conversationId: 'chat-a',
      state: 'idle',
      job: null,
      queue: { revision: 2, internal: [], external: [], failed: [], blocked: null },
    })
    expect(state.queue.failed).toEqual([item])
    expect(state.draftParts).toEqual([{ kind: 'text', text: 'next draft' }])
    expect(state.messages).toEqual([])
    expect(getErrorMessage({ code: 'AGENT_CANCELLED' }, (key) => key)).toBe('error.AGENT_CANCELLED')
    store.stop()
  })

  it('restores queued inputs after Renderer reload, then blocks on uncertain submissions until Main reconciliation', async () => {
    const item = {
      id: 'uncertain-input',
      origin: 'external' as const,
      operation: 'send' as const,
      parts: [{ kind: 'text' as const, text: 'original' }],
      attachments: [],
      editing: false,
    }
    const snapshot = {
      revision: 3,
      internal: [],
      external: [item],
      failed: [],
      blocked: null as typeof item | null,
    }
    const reconcileQueue = vi.fn(async () => ({ ...snapshot, revision: 5, blocked: null }))
    const history = vi.fn(async () => ({
      messages: [],
      pending: null,
      usage,
      running: false,
      queue: structuredClone(snapshot),
    }))
    Object.defineProperty(window, 'zhijiApi', {
      configurable: true,
      value: {
        ...eventSubscriptions,
        agent: {
          list: async () => conversations,
          onEvent: () => () => {},
          history,
          reconcileQueue,
        },
      },
    })
    const store = useAgentStore()
    await store.start()
    await store.select('chat-a')
    expect(store.session('chat-a').queue.external).toEqual([item])
    expect(store.session('chat-a').messages).toEqual([])
    snapshot.blocked = item
    snapshot.revision = 4
    await store.loadHistory('chat-a')
    expect(store.session('chat-a').unverified).toBe(true)
    snapshot.blocked = null
    snapshot.revision = 5
    await store.verifySubmission('chat-a')
    expect(reconcileQueue).toHaveBeenCalledOnce()
    expect(store.session('chat-a').unverified).toBe(false)
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
        listener?.({
          kind: 'queue',
          conversationId: id,
          state: 'running',
          job: jobs.get(id),
          queue: { revision: 1, internal: [], external: [], failed: [], blocked: null },
        })
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
