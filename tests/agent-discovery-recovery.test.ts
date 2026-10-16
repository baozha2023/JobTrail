// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NButton, NModal } from 'naive-ui'
import AgentDiscoveryRecovery from '../src/renderer/components/AgentDiscoveryRecovery.vue'
import DiscoveryLoginDialog from '../src/renderer/components/DiscoveryLoginDialog.vue'
import { i18n } from '../src/renderer/i18n'
import type { AgentMessage } from '../src/shared/types'
import type {
  PlatformStatus,
  QrLoginState,
  SearchRun,
  SourceState,
} from '../src/shared/job-discovery'

let wrapper: VueWrapper | undefined
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  i18n.global.locale.value = 'zh-CN'
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.useRealTimers()
  vi.unstubAllGlobals()
  i18n.global.locale.value = 'zh-CN'
})
function search(state: SourceState): SearchRun {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    requestId: 'test',
    query: { keyword: 'QA', city: '', platforms: ['boss'] },
    state: state === 'running' ? 'running' : 'partial',
    createdAt: 1,
    updatedAt: 1,
    sources: [
      {
        platform: 'boss',
        state,
        count: 2,
        batches: 1,
        sourcePage: 1,
        rawCount: 2,
        validCount: 2,
        duplicateCount: 0,
        rejectedCount: 0,
        salaryExcluded: { out_of_range: 0, day: 0, hour: 0, foreign: 0, unknown: 0 },
        cursor: null,
        generation: 1,
        remote: { keyword: 'QA', city: '', cityCode: '' },
        message: state,
        cachedAt: null,
      },
    ],
  }
}
function tool(
  name: string,
  args: Record<string, unknown>,
  result: unknown,
  id = 'tool',
): AgentMessage {
  return {
    id,
    role: 'tool',
    toolCallId: id,
    name,
    args: JSON.stringify(args),
    result: JSON.stringify(result),
    status: 'completed',
    attachments: [],
  }
}
const waiting: QrLoginState = {
  platform: 'boss',
  attemptId: '22222222-2222-4222-8222-222222222222',
  method: 'website',
  methods: [{ id: 'website', label: { 'zh-CN': '扫码', 'en-US': 'Scan' } }],
  scanHint: { 'zh-CN': '扫码确认', 'en-US': 'Scan to confirm' },
  state: 'waiting',
  image: 'data:image/png;base64,aGVsbG8=',
  expiresAt: Date.now() + 60000,
  reason: null,
  verification: { available: false, window: 'closed', error: null },
}
async function fixture(state: SourceState = 'challenge', messages?: AgentMessage[]) {
  const run = search(state)
  const account: PlatformStatus = {
    platform: 'boss',
    state: state === 'challenge' ? 'challenge' : 'authenticated',
    checkedAt: 1,
    generation: 1,
    evidence: 'synthetic',
    capabilities: { cities: [], remoteFilters: [], qr: 'website' },
    limitations: [],
  }
  const api = {
    run: vi.fn(async () => run),
    status: vi.fn(async () => [account]),
    verification: vi.fn(
      async (_input: unknown) =>
        null as { runId: string | null; platform: 'boss'; phase: 'open' | 'checking' } | null,
    ),
    qrLogin: vi.fn(async (_input: unknown): Promise<QrLoginState | null> => waiting),
    region: vi.fn(async () => {}),
    detail: vi.fn(),
  }
  Object.defineProperty(window, 'zhijiApi', { configurable: true, value: { discovery: api } })
  wrapper = mount(AgentDiscoveryRecovery, {
    props: {
      conversationId: 'chat',
      enabled: true,
      messages: messages ?? [tool('get_job_search', { runId: run.id }, { item: run })],
    },
    global: { plugins: [i18n], stubs: { Teleport: true } },
  })
  await flushPromises()
  return { api, run, account }
}
const clickCard = async () => {
  wrapper!.find('.agent-discovery-card').findComponent(NButton).vm.$emit('click')
  await flushPromises()
}
const tick = async () => {
  await vi.advanceTimersByTimeAsync(1700)
  await flushPromises()
}

it('deduplicates search cards, keeps them outside tool details and notifies only after Main recovery ends', async () => {
  const run = search('challenge')
  const f = await fixture('challenge', [
    tool('start_job_search', {}, { item: run }),
    tool('get_job_search', { runId: run.id }, { item: run }, 'later'),
  ])
  expect(wrapper!.findAll('.agent-discovery-card')).toHaveLength(1)
  f.api.verification.mockImplementation(async (input) =>
    (input as { action: string }).action === 'open'
      ? { runId: run.id, platform: 'boss', phase: 'open' }
      : null,
  )
  await clickCard()
  expect(f.api.verification).toHaveBeenCalledWith({
    action: 'open',
    runId: run.id,
    platform: 'boss',
  })
  expect(f.api.qrLogin).not.toHaveBeenCalled()
  await tick()
  expect(wrapper!.emitted('recovered')).toBeUndefined()
  expect(wrapper!.find('.agent-discovery-card').exists()).toBe(true)
  f.api.run.mockResolvedValue(search('completed'))
  await tick()
  expect(wrapper!.find('.agent-discovery-card').exists()).toBe(false)
  expect(wrapper!.emitted('recovered')).toEqual([
    [expect.objectContaining({ runId: run.id, platform: 'boss' })],
  ])
  await tick()
  expect(wrapper!.emitted('recovered')).toHaveLength(1)
})

it.each(['login_required', 'session_expired'] as const)(
  'closes QR on official confirmation for %s and passes its attemptId before notifying AI',
  async (state) => {
    const f = await fixture(state)
    await clickCard()
    expect(wrapper!.findComponent(NModal).props('show')).toBe(true)
    expect(f.api.qrLogin).toHaveBeenCalledWith({ action: 'start', platform: 'boss' })
    f.api.qrLogin.mockResolvedValue({ ...waiting, state: 'authenticated', image: null })
    f.api.verification.mockImplementation(async (input) =>
      (input as { action: string }).action === 'recheck'
        ? { runId: f.run.id, platform: 'boss', phase: 'checking' }
        : null,
    )
    await tick()
    expect(wrapper!.findComponent(NModal).props('show')).toBe(false)
    expect(f.api.verification).toHaveBeenCalledWith({
      action: 'recheck',
      runId: f.run.id,
      platform: 'boss',
      attemptId: waiting.attemptId,
    })
    expect(wrapper!.emitted('recovered')).toBeUndefined()
    f.api.run.mockResolvedValue(search('completed'))
    await tick()
    expect(wrapper!.emitted('recovered')).toHaveLength(1)
  },
)

it.each(['header', 'footer'] as const)(
  'does not notify AI when QR is cancelled from the %s close button',
  async (button) => {
    const f = await fixture('session_expired')
    await clickCard()
    await wrapper!
      .get('.agent-discovery-login')
      .get(button === 'header' ? '.n-card-header__close' : '.discovery-account-footer button')
      .trigger('click')
    await flushPromises()
    f.api.qrLogin.mockResolvedValue({ ...waiting, state: 'authenticated' })
    await tick()
    expect(wrapper!.emitted('recovered')).toBeUndefined()
    expect(
      f.api.verification.mock.calls.some(
        ([input]) => (input as { action: string }).action === 'recheck',
      ),
    ).toBe(false)
    expect(wrapper!.find('.agent-discovery-card').exists()).toBe(true)
  },
)

it.each(['verify', 'retry'] as const)(
  'handles official confirmation returned directly by the QR %s action',
  async (action) => {
    const f = await fixture('session_expired')
    await clickCard()
    f.api.qrLogin.mockResolvedValue({ ...waiting, state: 'authenticated', image: null })
    f.api.verification.mockImplementation(async (input) =>
      (input as { action: string }).action === 'recheck'
        ? { runId: f.run.id, platform: 'boss', phase: 'checking' }
        : null,
    )
    wrapper!.findComponent(DiscoveryLoginDialog).vm.$emit('verify', action)
    await flushPromises()
    expect(wrapper!.findComponent(NModal).props('show')).toBe(false)
    expect(f.api.verification).toHaveBeenCalledWith({
      action: 'recheck',
      runId: f.run.id,
      platform: 'boss',
      attemptId: waiting.attemptId,
    })
    f.api.run.mockResolvedValue(search('completed'))
    await tick()
    expect(wrapper!.emitted('recovered')).toHaveLength(1)
  },
)

it('detects a later challenge after start returned running, without starting another search', async () => {
  const f = await fixture('running', [tool('start_job_search', {}, { item: search('running') })])
  expect(wrapper!.find('.agent-discovery-card').exists()).toBe(false)
  f.api.run.mockResolvedValue(search('challenge'))
  await tick()
  expect(wrapper!.find('.agent-discovery-card').text()).toContain('需要网站验证')
  expect(
    f.api.verification.mock.calls.every(
      ([input]) => (input as { action: string }).action === 'get',
    ),
  ).toBe(true)
})

it('ignores late responses after switching chats and releases the owned verification', async () => {
  const f = await fixture()
  f.api.verification.mockImplementation(async (input) =>
    (input as { action: string }).action !== 'close'
      ? { runId: f.run.id, platform: 'boss', phase: 'open' }
      : null,
  )
  await clickCard()
  let resolve!: (run: SearchRun) => void
  f.api.run.mockImplementation(
    () =>
      new Promise<SearchRun>((done) => {
        resolve = done
      }),
  )
  await vi.advanceTimersByTimeAsync(1700)
  await wrapper!.setProps({ conversationId: 'other', messages: [] })
  resolve(search('completed'))
  await flushPromises()
  expect(wrapper!.find('.agent-discovery-card').exists()).toBe(false)
  expect(wrapper!.emitted('recovered')).toBeUndefined()
  expect(f.api.verification).toHaveBeenCalledWith({ action: 'close' })
})

it('uses the desktop-only account window for a status challenge without a search', async () => {
  const f = await fixture('challenge', [tool('get_job_platform_status', {}, { items: [] })])
  await clickCard()
  expect(f.api.verification).toHaveBeenCalledWith({ action: 'account', platform: 'boss' })
  expect(wrapper!.emitted('recovered')).toBeUndefined()
  f.account.state = 'authenticated'
  await tick()
  expect(wrapper!.emitted('recovered')).toHaveLength(1)
})

it.each(['cancelled', 'interrupted'] as const)(
  'does not resume chat for a search that became %s during verification',
  async (state) => {
    const f = await fixture('challenge')
    await clickCard()
    f.api.run.mockResolvedValue({ ...search('completed'), state })
    await tick()
    expect(wrapper!.emitted('recovered')).toBeUndefined()
    expect(wrapper!.find('.agent-discovery-card').exists()).toBe(false)
  },
)

it('localizes cards and never checks discovery while MCP is disabled', async () => {
  const f = await fixture()
  i18n.global.locale.value = 'en-US'
  await flushPromises()
  expect(wrapper!.find('.agent-discovery-card').text()).toContain('Website verification required')
  const statusReads = f.api.status.mock.calls.length
  await wrapper!.setProps({ enabled: false })
  const reads = f.api.run.mock.calls.length
  await tick()
  expect(wrapper!.find('.agent-discovery-card').exists()).toBe(false)
  expect(f.api.run).toHaveBeenCalledTimes(reads)
  expect(f.api.status).toHaveBeenCalledTimes(statusReads)
})

it('recovers a failed detail through its original run and ignores unrelated malformed tools', async () => {
  const f = await fixture('challenge', [
    tool(
      'get_discovered_job',
      { jobId: 'synthetic', runId: search('challenge').id },
      { ok: false, error: { code: 'DISCOVERY_FAILED' } },
    ),
  ])
  expect(wrapper!.find('.agent-discovery-card').exists()).toBe(true)
  expect(f.api.detail).not.toHaveBeenCalled()
  await wrapper!.setProps({
    conversationId: 'other',
    messages: [tool('read_web_page', {}, { item: search('challenge') })],
  })
  expect(wrapper!.find('.agent-discovery-card').exists()).toBe(false)
})
