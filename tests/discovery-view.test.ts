// @vitest-environment jsdom
import { flushPromises, shallowMount, type VueWrapper } from '@vue/test-utils'
import { NButton, NCheckbox, NCheckboxGroup, NInput, NPagination, NModal, NCard } from 'naive-ui'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import JobDiscoveryView from '../src/renderer/views/JobDiscoveryView.vue'
import { i18n } from '../src/renderer/i18n'
import {
  platforms,
  type DiscoveredJob,
  type JobPlatform,
  type PlatformStatus,
  type SearchRun,
  type SourceVerificationState,
  type SourceProgress,
  type QrLoginState,
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
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 1),
  )
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function source(platform: JobPlatform, state: SourceProgress['state']): SourceProgress {
  return {
    platform,
    state,
    count: 0,
    batches: 0,
    sourcePage: 0,
    rawCount: 0,
    validCount: 0,
    duplicateCount: 0,
    rejectedCount: 0,
    salaryExcluded: { out_of_range: 0, day: 0, hour: 0, foreign: 0, unknown: 0 },
    cursor: null,
    generation: 0,
    remote: { keyword: 'Java', city: '', cityCode: '' },
    message: '',
    cachedAt: null,
  }
}

it('shows one warning beside the search buttons, opens verification directly and advances only after the source recovers', async () => {
  const f = await fixture()
  f.api.run.mockResolvedValue({
    ...f.run,
    sources: [
      source('liepin', 'challenge'),
      source('boss', 'session_expired'),
      source('wuyou', 'parse_error'),
    ],
  })
  await vi.advanceTimersByTimeAsync(1800)
  await flushPromises()
  const button = () =>
    wrapper!
      .find('.discovery-search-buttons')
      .findAllComponents(NButton)
      .find((button: VueWrapper) => button.classes().includes('discovery-verification'))!
  expect(button().text()).toBe('猎聘 · 需要网站验证')
  expect(button().props('type')).toBe('warning')
  expect(wrapper!.findAll('.discovery-verification')).toHaveLength(1)
  expect(wrapper!.find('.discovery-source-warnings').text()).toContain('前程无忧 · 页面解析未完成')
  f.api.verification.mockResolvedValue({ runId: f.run.id, platform: 'liepin', phase: 'open' })
  button().vm.$emit('click')
  await flushPromises()
  expect(f.api.verification).toHaveBeenLastCalledWith({
    action: 'open',
    runId: f.run.id,
    platform: 'liepin',
  })
  expect(wrapper!.findComponent(NModal).props('show')).toBe(false)
  f.api.verification.mockResolvedValue({ runId: f.run.id, platform: 'liepin', phase: 'checking' })
  // Reordering source payloads must not reorder the user-facing queue.
  f.api.run.mockResolvedValue({
    ...f.run,
    state: 'partial',
    sources: [source('boss', 'session_expired'), source('liepin', 'challenge')],
  })
  await vi.advanceTimersByTimeAsync(1800)
  await flushPromises()
  expect(button().text()).toBe('猎聘 · 需要网站验证')
  expect(button().props('loading')).toBe(true)
  f.api.verification.mockResolvedValue(null)
  await vi.advanceTimersByTimeAsync(1800)
  await flushPromises()
  expect(button().text()).toBe('猎聘 · 需要网站验证')
  // A new attempt succeeds: get() finishes, and a non-running run must still be refreshed.
  f.api.verification.mockResolvedValue({ runId: f.run.id, platform: 'liepin', phase: 'open' })
  button().vm.$emit('click')
  await flushPromises()
  f.api.verification.mockResolvedValue(null)
  f.api.run.mockResolvedValue({
    ...f.run,
    state: 'partial',
    sources: [source('boss', 'session_expired'), source('liepin', 'completed')],
  })
  await vi.advanceTimersByTimeAsync(1800)
  await flushPromises()
  expect(button().text()).toBe('BOSS 直聘 · 会话失效')
  f.api.verification.mockResolvedValue({ runId: f.run.id, platform: 'liepin', phase: 'resuming' })
  f.api.run.mockResolvedValue({
    ...f.run,
    state: 'running',
    sources: [source('boss', 'session_expired'), source('liepin', 'partial')],
  })
  await vi.advanceTimersByTimeAsync(1800)
  await flushPromises()
  expect(button().props('disabled')).toBe(true)
  expect(wrapper!.find('[role="status"]').text()).toContain('正在继续该平台本轮搜索')
  expect(wrapper!.find('.discovery-search-buttons').text()).toContain('取消搜索')
  // A fast completion may occur entirely between polls; refresh queued warnings too.
  f.api.verification.mockResolvedValue(null)
  f.api.run.mockResolvedValue({
    ...f.run,
    state: 'completed',
    sources: [source('boss', 'completed'), source('liepin', 'completed')],
  })
  await vi.advanceTimersByTimeAsync(1800)
  await flushPromises()
  expect(wrapper!.find('.discovery-verification').exists()).toBe(false)
})

const qrWaiting: QrLoginState = {
  platform: 'boss',
  attemptId: '22222222-2222-4222-8222-222222222222',
  state: 'waiting',
  image: 'data:image/png;base64,aGVsbG8=',
  expiresAt: Date.now() + 180000,
  reason: null,
  scanHint: { 'zh-CN': '使用官方 App 扫码', 'en-US': 'Scan with the official app' },
  verification: { available: false, window: 'closed', error: null },
}
async function openLoginWarning(state: 'login_required' | 'session_expired') {
  const f = await fixture()
  f.api.run.mockResolvedValue({ ...f.run, state: 'partial', sources: [source('boss', state)] })
  f.api.qrLogin.mockResolvedValue(qrWaiting)
  await vi.advanceTimersByTimeAsync(1800)
  wrapper!
    .findAllComponents(NButton)
    .find((button) => button.classes().includes('discovery-verification'))!
    .vm.$emit('click')
  await flushPromises()
  return f
}
it.each(['login_required', 'session_expired'] as const)(
  'opens the shared QR panel for %s and resumes only after official login succeeds',
  async (state) => {
    const f = await openLoginWarning(state)
    expect(wrapper!.findComponent(NModal).props('show')).toBe(true)
    expect(wrapper!.find('.discovery-source-login').exists()).toBe(true)
    expect(wrapper!.find('.discovery-account-left').exists()).toBe(false)
    expect(wrapper!.find('.discovery-qr-title').text()).toBe('BOSS 直聘')
    expect(wrapper!.find('.discovery-qr-image').attributes('src')).toBe(qrWaiting.image)
    // Stale authenticated account metadata cannot hide a new QR attempt.
    expect(wrapper!.find('.discovery-login-success').exists()).toBe(false)
    expect(f.api.qrLogin).toHaveBeenCalledWith({ action: 'start', platform: 'boss' })
    expect(
      f.api.verification.mock.calls.some(([v]) => (v as { action: string }).action === 'open'),
    ).toBe(false)
    expect(wrapper!.find('.discovery-verification').exists()).toBe(true)

    f.api.qrLogin.mockResolvedValue({ ...qrWaiting, state: 'authenticated', image: null })
    f.api.verification.mockResolvedValue({ runId: f.run.id, platform: 'boss', phase: 'checking' })
    await vi.advanceTimersByTimeAsync(1800)
    await flushPromises()
    expect(f.api.verification).toHaveBeenCalledWith({
      action: 'recheck',
      runId: f.run.id,
      platform: 'boss',
      attemptId: qrWaiting.attemptId,
    })
    expect(wrapper!.findComponent(NModal).props('show')).toBe(false)
    expect(wrapper!.find('.discovery-verification').exists()).toBe(true)
    f.api.verification.mockResolvedValue(null)
    f.api.run.mockResolvedValue({
      ...f.run,
      state: 'partial',
      sources: [source('boss', 'completed'), source('liepin', 'challenge')],
    })
    await vi.advanceTimersByTimeAsync(1800)
    expect(wrapper!.find('.discovery-verification').text()).toBe('猎聘 · 需要网站验证')
    expect(
      f.api.verification.mock.calls.some(([v]) => (v as { action: string }).action === 'open'),
    ).toBe(false)
  },
)
it('keeps the login warning and does not resume when the QR dialog is cancelled or fails', async () => {
  const f = await openLoginWarning('session_expired')
  f.api.qrLogin.mockResolvedValue({ ...qrWaiting, state: 'error', reason: 'network', image: null })
  await vi.advanceTimersByTimeAsync(1800)
  expect(wrapper!.findComponent(NModal).props('show')).toBe(true)
  wrapper!
    .findAllComponents(NCard)
    .find((card) => card.classes().includes('discovery-accounts'))!
    .vm.$emit('close')
  await flushPromises()
  f.api.qrLogin.mockResolvedValue({ ...qrWaiting, state: 'authenticated' })
  await vi.advanceTimersByTimeAsync(1800)
  expect(wrapper!.findComponent(NModal).props('show')).toBe(false)
  expect(wrapper!.find('.discovery-verification').text()).toBe('BOSS 直聘 · 会话失效')
  expect(
    f.api.verification.mock.calls.some(([v]) => (v as { action: string }).action === 'recheck'),
  ).toBe(false)
})

function accountStatuses(authenticated: JobPlatform[]): PlatformStatus[] {
  return platforms.map((platform) => ({
    platform,
    state: authenticated.includes(platform) ? 'authenticated' : 'unknown',
    checkedAt: null,
    generation: 0,
    evidence: '',
    capabilities: { cities: [], remoteFilters: [], qr: 'website' },
    limitations: [],
  }))
}

async function fixture(
  age: number | null = null,
  {
    authenticated = ['boss'],
    search = true,
  }: { authenticated?: JobPlatform[]; search?: boolean } = {},
) {
  const job: DiscoveredJob = {
    id: 'job-one',
    observationId: 1,
    platform: 'boss',
    url: 'https://www.zhipin.com/job_detail/one.html',
    title: 'Java 工程师',
    company: '公司',
    city: '北京',
    salary: '15-20K',
    salaryMin: 15000,
    salaryMax: 20000,
    experience: '',
    education: '',
    recruitment: '',
    employment: '',
    jd: age === null ? '' : '已有详情',
    detailRead: age !== null,
    detailReadAt: age === null ? null : Date.now() - age,
    readAt: Date.now(),
    missing: {},
    removedFromCurrentSearch: false,
    savedOpportunityId: null,
    possibleDuplicate: false,
  }
  const run: SearchRun = {
    id: '11111111-1111-4111-8111-111111111111',
    requestId: 'search-one',
    query: { keyword: 'Java', city: '', platforms: ['boss'] },
    state: 'running',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sources: [],
  }
  const detail = vi.fn(async (_input: { mode?: string }) =>
    age === null || age >= 1800000
      ? { ...job, jd: '完整详情', detailRead: true, detailReadAt: Date.now() }
      : job,
  )
  const api = {
    status: vi.fn(async () => accountStatuses(authenticated)),
    history: vi.fn(async () => ({ items: [run], total: 1 })),
    start: vi.fn(async () => run),
    cancel: vi.fn(async (_id: string) => ({ ...run, state: 'cancelled' as const })),
    run: vi.fn(async () => run),
    list: vi.fn(async (_input?: { page?: number }) => ({
      viewId: 'view-one',
      items: [job],
      total: 40,
      page: 1,
      pageSize: 20,
    })),
    detail,
    browser: vi.fn(async () => {}),
    region: vi.fn(async () => {}),
    verification: vi.fn(async (_input: unknown): Promise<SourceVerificationState | null> => null),
    qrLogin: vi.fn(async (_input: unknown): Promise<QrLoginState | null> => null),
  }
  Object.defineProperty(window, 'zhijiApi', { configurable: true, value: { discovery: api } })
  wrapper = shallowMount(JobDiscoveryView, {
    props: { active: true, statuses: [], resumes: [] },
    global: { plugins: [i18n], renderStubDefaultSlot: true },
  })
  wrapper!.findComponent(NInput).vm.$emit('update:value', 'Java')
  await flushPromises()
  expect(wrapper!.findComponent(NInput).props('value')).toBe('Java')
  if (search) {
    wrapper
      .findAllComponents(NButton)
      .find((b) => b.text() === '搜索岗位')!
      .vm.$emit('click')
    await flushPromises()
    expect(api.start).toHaveBeenCalledOnce()
    const searchButton = wrapper.find('.discovery-search-buttons').findComponent(NButton)
    expect(searchButton.text()).toBe('取消搜索')
    expect(searchButton.props('loading')).toBe(false)
    expect(wrapper.find('.discovery-actions').exists()).toBe(false)
    expect(wrapper!.find('.discovery-job').exists()).toBe(true)
    expect(detail).not.toHaveBeenCalled()
  }

  return { api, job, detail, run }
}

it('selects only signed-in platforms and disables every other platform', async () => {
  await fixture(null, { authenticated: ['boss', 'zhilian'], search: false })
  expect(wrapper!.findComponent(NCheckboxGroup).props('value')).toEqual(['boss', 'zhilian'])
  expect(
    wrapper!
      .findComponent(NCheckboxGroup)
      .findAllComponents(NCheckbox)
      .map((item) => item.props('disabled')),
  ).toEqual([false, true, false, true])
})

it('blocks new searches without a signed-in selection, including Enter and stale selections', async () => {
  const { api } = await fixture(null, { authenticated: [], search: false })
  expect(wrapper!.findComponent(NCheckboxGroup).props('value')).toEqual([])
  expect(
    wrapper!
      .findComponent(NCheckboxGroup)
      .findAllComponents(NCheckbox)
      .every((item) => item.props('disabled')),
  ).toBe(true)
  expect(wrapper!.find('.discovery-search-buttons').findComponent(NButton).props('disabled')).toBe(
    true,
  )
  wrapper!.findComponent(NCheckboxGroup).vm.$emit('update:value', ['boss'])
  wrapper!.findComponent(NInput).vm.$emit('keyup', { key: 'Enter' })
  await flushPromises()
  expect(api.start).not.toHaveBeenCalled()
  expect(wrapper!.findComponent(NCheckboxGroup).props('value')).toEqual([])
})

it('preserves manual deselection across polling, selects new logins and removes expired sessions', async () => {
  const { api } = await fixture(null, { search: false })
  wrapper!.findComponent(NCheckboxGroup).vm.$emit('update:value', [])
  await vi.advanceTimersByTimeAsync(2000)
  expect(wrapper!.findComponent(NCheckboxGroup).props('value')).toEqual([])
  api.status.mockResolvedValue(accountStatuses(['boss', 'liepin']))
  await vi.advanceTimersByTimeAsync(2000)
  expect(wrapper!.findComponent(NCheckboxGroup).props('value')).toEqual(['liepin'])
  const expired = accountStatuses(['boss'])
  expired[1].state = 'session_expired'
  expired[2].state = 'challenge'
  expired[3].state = 'login_required'
  api.status.mockResolvedValue(expired)
  await vi.advanceTimersByTimeAsync(2000)
  expect(wrapper!.findComponent(NCheckboxGroup).props('value')).toEqual([])
  expect(
    wrapper!
      .findComponent(NCheckboxGroup)
      .findAllComponents(NCheckbox)
      .map((item) => item.props('disabled')),
  ).toEqual([false, true, true, true])
})

it('does not reselect signed-out platforms when opening historical search conditions', async () => {
  const { api, run } = await fixture(null, { search: false })
  api.history.mockResolvedValue({
    items: [{ ...run, query: { ...run.query, platforms: [...platforms] } }],
    total: 1,
  })
  await (wrapper!.vm as unknown as { openHistory(): Promise<void> }).openHistory()
  wrapper!
    .findAllComponents(NButton)
    .find((button) => button.text() === '查看')!
    .vm.$emit('click')
  await flushPromises()
  expect(wrapper!.findComponent(NCheckboxGroup).props('value')).toEqual(['boss'])
})

it.each([null, 40 * 60000, 5 * 60000])(
  'reads details only after a user opens a job (detail age %s)',
  async (age) => {
    const { api, job, detail } = await fixture(age)
    await vi.advanceTimersByTimeAsync(3000)
    await flushPromises()
    expect(api.run).toHaveBeenCalled()
    wrapper!.findComponent(NPagination).vm.$emit('update:page', 2)
    await flushPromises()
    expect(api.list).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 }))
    expect(detail).not.toHaveBeenCalled()

    await wrapper!.find('.discovery-job').trigger('click')
    await flushPromises()
    expect(detail).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: job.id, observationId: 1, mode: 'ensure' }),
    )
    expect(detail).toHaveBeenCalledOnce()
    expect(wrapper!.text()).toContain(age === null || age > 30 * 60000 ? '完整详情' : '已有详情')
    expect(wrapper!.findAllComponents(NButton).some((b) => /补全/.test(b.text()))).toBe(false)
  },
)

it('removes an offline job from the list and shows only the large offline state in the detail pane', async () => {
  const { api, job, detail } = await fixture()
  let deleted = false
  detail.mockImplementation(async (input) => {
    if (input.mode === 'ensure') {
      deleted = true
      throw { code: 'DISCOVERY_JOB_OFFLINE' }
    }
    return job
  })
  api.list.mockImplementation(async () => ({
    viewId: 'view-one',
    items: deleted ? [] : [job],
    total: deleted ? 0 : 1,
    page: 1,
    pageSize: 20,
  }))
  await wrapper!.find('.discovery-job').trigger('click')
  await flushPromises()
  expect(wrapper!.find('.discovery-job').exists()).toBe(false)
  expect(wrapper!.find('.discovery-offline').text()).toBe('已下架')
  expect(wrapper!.find('.discovery-detail-header').exists()).toBe(false)
  expect(wrapper!.find('.discovery-detail-actions').exists()).toBe(false)
  expect(api.browser).toHaveBeenLastCalledWith({ action: 'close' })
  await vi.advanceTimersByTimeAsync(3000)
  await flushPromises()
  expect(wrapper!.find('.discovery-offline').text()).toBe('已下架')
  wrapper!.find('.discovery-search-buttons').findComponent(NButton).vm.$emit('click')
  await flushPromises()
  expect(api.cancel).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111')
  wrapper!
    .findAllComponents(NButton)
    .find((b) => b.text() === '搜索岗位')!
    .vm.$emit('click')
  await flushPromises()
  expect(wrapper!.find('.discovery-offline').exists()).toBe(false)
})

it('does not overwrite the newly selected job when an older detail request confirms delisting', async () => {
  const { api, job, detail } = await fixture()
  const next = {
    ...job,
    id: 'job-two',
    title: '另一个岗位',
    detailRead: true,
    detailReadAt: Date.now(),
  }
  let rejectOld: (error: unknown) => void = () => {}
  let deleted = false
  api.list.mockImplementation(async () => ({
    viewId: 'view-one',
    items: deleted ? [next] : [job, next],
    total: deleted ? 1 : 2,
    page: 1,
    pageSize: 20,
  }))
  await vi.advanceTimersByTimeAsync(1000)
  await flushPromises()
  detail.mockImplementation(async (input) =>
    input.mode === 'ensure'
      ? new Promise((_, reject) => {
          rejectOld = reject
        })
      : job,
  )
  await wrapper!.findAll('.discovery-job')[0].trigger('click')
  await flushPromises()
  detail.mockResolvedValue(next)
  await wrapper!.findAll('.discovery-job')[1].trigger('click')
  await flushPromises()
  deleted = true
  rejectOld({ code: 'DISCOVERY_JOB_OFFLINE' })
  await flushPromises()
  expect(wrapper!.find('.discovery-offline').exists()).toBe(false)
  expect(wrapper!.find('.discovery-detail-header').text()).toContain(next.title)
  expect(wrapper!.findAll('.discovery-job')).toHaveLength(1)
})

it('returns to the last valid page after deleting its only job without selecting another job', async () => {
  const { api, job, detail } = await fixture()
  const other = { ...job, id: 'other-job', title: '保留岗位' }
  let deleted = false
  api.list.mockImplementation(async (input) => ({
    viewId: 'view-one',
    items: input?.page === 2 ? (deleted ? [] : [job]) : [other],
    total: deleted ? 20 : 21,
    page: input?.page ?? 1,
    pageSize: 20,
  }))
  wrapper!.findComponent(NPagination).vm.$emit('update:page', 2)
  await flushPromises()
  detail.mockImplementation(async (input) => {
    if (input.mode === 'ensure') {
      deleted = true
      throw { code: 'DISCOVERY_JOB_OFFLINE' }
    }
    return job
  })
  await wrapper!.find('.discovery-job').trigger('click')
  await flushPromises()
  expect(api.list).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1 }))
  expect(wrapper!.find('.discovery-job').text()).toContain(other.title)
  expect(wrapper!.find('.discovery-offline').text()).toBe('已下架')
  expect(detail).toHaveBeenCalledOnce()
})

it('keeps the job and does not display offline on a network failure', async () => {
  const { job, detail } = await fixture()
  detail.mockImplementation(async (input) => {
    if (input.mode === 'ensure') throw { code: 'DISCOVERY_FAILED' }
    return job
  })
  await wrapper!.find('.discovery-job').trigger('click')
  await flushPromises()
  expect(wrapper!.find('.discovery-job').exists()).toBe(true)
  expect(wrapper!.find('.discovery-offline').exists()).toBe(false)
})

it('navigates to a newly selected job before its detail request completes or fails', async () => {
  const { api, job, detail } = await fixture()
  await wrapper!.find('.discovery-job').trigger('click')
  await flushPromises()
  wrapper!
    .findAllComponents(NButton)
    .find((b) => b.text() === '打开浏览器')!
    .vm.$emit('click')
  await flushPromises()
  const next = { ...job, id: 'job-two', title: '新岗位' }
  api.list.mockResolvedValue({
    viewId: 'view-one',
    items: [job, next],
    total: 2,
    page: 1,
    pageSize: 20,
  })
  await vi.advanceTimersByTimeAsync(1000)
  await flushPromises()
  let rejectDetail!: (reason: unknown) => void
  detail.mockImplementation(
    () =>
      new Promise((_, reject) => {
        rejectDetail = reject
      }),
  )
  await wrapper!.findAll('.discovery-job')[1].trigger('click')
  await flushPromises()
  expect(api.browser).toHaveBeenLastCalledWith({ action: 'open', jobId: next.id })
  rejectDetail({ code: 'DISCOVERY_FAILED' })
  await flushPromises()
  expect(wrapper!.find('.discovery-detail-header').text()).toContain(next.title)
  expect(api.browser).toHaveBeenLastCalledWith({ action: 'open', jobId: next.id })
})
