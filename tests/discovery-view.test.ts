// @vitest-environment jsdom
import { flushPromises, shallowMount, type VueWrapper } from '@vue/test-utils'
import {
  NButton,
  NCheckbox,
  NCheckboxGroup,
  NInput,
  NInputNumber,
  NSelect,
  NPagination,
  NModal,
  NCard,
  NAlert,
} from 'naive-ui'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import JobDiscoveryView from '../src/renderer/views/JobDiscoveryView.vue'
import DiscoveryLoginPanel from '../src/renderer/components/DiscoveryLoginPanel.vue'
import { i18n } from '../src/renderer/i18n'
import { commonCities } from '../src/shared/discovery-cities'
import * as cityCatalog from '../src/shared/discovery-cities'
import type { CompanySummary } from '../src/shared/types'
import {
  platforms,
  type DiscoveredJob,
  type DiscoveryApi,
  type BrowserLoadingState,
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
  i18n.global.locale.value = 'zh-CN'
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

it.each([
  ['zh-CN', '登录状态复核未完成', '页面解析未完成'],
  ['en-US', 'Login status check incomplete', 'Page parsing incomplete'],
] as const)(
  'distinguishes account checks from job parsing in current warnings and history (%s)',
  async (locale, accountLabel, parseLabel) => {
    const f = await fixture()
    const failed = {
      ...f.run,
      state: 'partial' as const,
      sources: [
        { ...source('liepin', 'parse_error'), message: 'authentication_check_inconclusive' },
        { ...source('wuyou', 'parse_error'), message: 'response_contract_changed' },
      ],
    }
    f.api.run.mockResolvedValue(failed)
    f.api.history.mockResolvedValue({ items: [failed], total: 1 })
    i18n.global.locale.value = locale
    await vi.advanceTimersByTimeAsync(1800)
    await flushPromises()
    expect(wrapper!.find('.discovery-source-warnings').text()).toContain(`猎聘 · ${accountLabel}`)
    expect(wrapper!.find('.discovery-source-warnings').text()).toContain(`前程无忧 · ${parseLabel}`)
    expect(wrapper!.find('.discovery-verification').exists()).toBe(false)
    await (wrapper!.vm as unknown as { openHistory(): Promise<void> }).openHistory()
    await flushPromises()
    expect(wrapper!.find('.discovery-history-sources').text()).toContain(
      `猎聘 · 0 · ${accountLabel}`,
    )
    expect(wrapper!.find('.discovery-history-sources').text()).toContain(
      `前程无忧 · 0 · ${parseLabel}`,
    )
  },
)

const qrWaiting: QrLoginState = {
  method: 'website',
  methods: [{ id: 'website', label: { 'zh-CN': '扫码', 'en-US': 'Scan' } }],
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
it('closes the QR panel on confirmed login even when scheduling the recheck fails', async () => {
  const f = await openLoginWarning('session_expired')
  f.api.qrLogin.mockResolvedValue({ ...qrWaiting, state: 'authenticated', image: null })
  f.api.verification.mockImplementation(async (input) => {
    if ((input as { action: string }).action === 'recheck') throw new Error('unavailable')
    return null
  })
  await vi.advanceTimersByTimeAsync(1800)
  await flushPromises()
  expect(wrapper!.findComponent(NModal).props('show')).toBe(false)
  expect(wrapper!.find('.discovery-verification').text()).toBe('BOSS 直聘 · 会话失效')
})

it.each(['accounts', 'search warning'] as const)(
  'routes QR refresh, method selection and verification through the shared panel from %s',
  async (entry) => {
    const f =
      entry === 'accounts'
        ? await fixture(null, { authenticated: [], search: false })
        : await openLoginWarning('session_expired')
    const waiting: QrLoginState = {
      ...qrWaiting,
      methods: [
        ...qrWaiting.methods,
        { id: 'app', label: { 'zh-CN': 'App 扫码', 'en-US': 'App scan' } },
      ],
    }
    f.api.qrLogin.mockResolvedValue(waiting)
    if (entry === 'accounts') {
      await (wrapper!.vm as unknown as { openAccounts(): Promise<void> }).openAccounts()
      wrapper!.find('.discovery-account').findComponent(NButton).vm.$emit('click')
    } else await vi.advanceTimersByTimeAsync(1800)
    await flushPromises()
    const panel = () => wrapper!.findComponent(DiscoveryLoginPanel)
    const click = async (text: string) => {
      panel()
        .findAllComponents(NButton)
        .find((button) => button.text() === text)!
        .vm.$emit('click')
      await flushPromises()
    }
    expect(wrapper!.findAllComponents(DiscoveryLoginPanel)).toHaveLength(1)
    expect(panel().find('.discovery-qr-image').attributes('src')).toBe(waiting.image)
    expect(wrapper!.find('.discovery-account-left').exists()).toBe(entry === 'accounts')
    i18n.global.locale.value = 'en-US'
    await flushPromises()
    expect(panel().text()).toContain('Scan with the official app')
    f.api.qrLogin.mockResolvedValue({ ...waiting, method: 'app' })
    await click('App scan')
    expect(f.api.qrLogin).toHaveBeenLastCalledWith({
      action: 'start',
      platform: 'boss',
      method: 'app',
    })
    await click('Refresh QR code')
    expect(f.api.qrLogin).toHaveBeenLastCalledWith({
      action: 'start',
      platform: 'boss',
      method: 'app',
    })

    f.api.qrLogin.mockResolvedValue({
      ...waiting,
      state: 'challenge',
      image: null,
      reason: 'verification',
      verification: { available: true, window: 'closed', error: null },
    })
    await vi.advanceTimersByTimeAsync(1800)
    await flushPromises()
    await click('Open BOSS 直聘 verification')
    expect(f.api.qrLogin).toHaveBeenLastCalledWith({
      action: 'verify',
      platform: 'boss',
      attemptId: waiting.attemptId,
    })
    expect(wrapper!.findComponent(NModal).props('show')).toBe(true)
    f.api.qrLogin.mockResolvedValue(waiting)
    await click('Verification completed — retry QR')
    expect(f.api.qrLogin).toHaveBeenLastCalledWith({
      action: 'retry',
      platform: 'boss',
      attemptId: waiting.attemptId,
    })
    expect(panel().find('.discovery-qr-image').attributes('src')).toBe(waiting.image)

    f.api.qrLogin.mockResolvedValue({ ...waiting, state: 'authenticated', image: null })
    await vi.advanceTimersByTimeAsync(1800)
    await flushPromises()
    expect(wrapper!.findComponent(NModal).props('show')).toBe(false)
    expect(
      f.api.verification.mock.calls.some(
        ([input]) => (input as { action: string }).action === 'recheck',
      ),
    ).toBe(entry === 'search warning')
  },
)

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
    companies = [],
  }: { authenticated?: JobPlatform[]; search?: boolean; companies?: CompanySummary[] } = {},
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
  let receiveBrowserLoading: (state: BrowserLoadingState) => void = () => {}
  const removeBrowserLoadingListener = vi.fn()
  const api = {
    status: vi.fn(async () => accountStatuses(authenticated)),
    history: vi.fn(async () => ({ items: [run], total: 1 })),
    start: vi.fn(async () => run),
    continue: vi.fn(async (_id: string) => run),
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
    save: vi.fn(async (_input: unknown) => ({ opportunityId: 9 })),
    browser: vi.fn(async (_input: Parameters<DiscoveryApi['browser']>[0]) => {}),
    onBrowserLoading: vi.fn((listener: (state: BrowserLoadingState) => void) => {
      receiveBrowserLoading = listener
      return removeBrowserLoadingListener
    }),
    region: vi.fn(async () => {}),
    verification: vi.fn(async (_input: unknown): Promise<SourceVerificationState | null> => null),
    qrLogin: vi.fn(async (_input: unknown): Promise<QrLoginState | null> => null),
  }
  Object.defineProperty(window, 'zhijiApi', { configurable: true, value: { discovery: api } })
  wrapper = shallowMount(JobDiscoveryView, {
    props: { active: true, companies, statuses: [], resumes: [] },
    global: {
      plugins: [i18n],
      renderStubDefaultSlot: true,
      stubs: { DiscoveryLoginPanel: false },
    },
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

  return {
    api,
    job,
    detail,
    run,
    browserLoading: (state: BrowserLoadingState) => receiveBrowserLoading(state),
    removeBrowserLoadingListener,
  }
}

it.each([true, false])(
  'offers every company and defaults only to an exact name match (match: %s)',
  async (matches) => {
    const companies: CompanySummary[] = Array.from({ length: 26 }, (_, index) => ({
      id: index + 1,
      name: index === 25 && matches ? '公司' : `公司 ${index + 1}`,
      aliases: ['公司'],
      industryIds: [],
      industryName: null,
      careerUrl: null,
      lastReadAt: null,
      isBuiltin: false,
      isFavorite: false,
      createdAt: 1,
      updatedAt: 1,
    }))
    const { api, job } = await fixture(null, { companies })
    await wrapper!.setProps({
      statuses: [
        { id: 1, label: '待投递', sortOrder: 0, isBuiltin: true, createdAt: 1, updatedAt: 1 },
      ],
    })
    await wrapper!.find('.discovery-job').trigger('click')
    await flushPromises()
    wrapper!
      .findAllComponents(NButton)
      .find((button) => button.text() === '加入求职记录')!
      .vm.$emit('click')
    await flushPromises()

    const select = wrapper!.find('.discovery-save-form').findComponent(NSelect)
    expect(select.props('options')).toEqual(
      companies.map((company) => ({ label: company.name, value: company.id })),
    )
    expect(select.props('filterable')).toBe(true)
    expect(select.props('remote')).toBe(false)
    expect(select.props('value')).toBe(matches ? 26 : null)

    // Manual choices survive shared company data refreshes and are used when saving.
    select.vm.$emit('update:value', 3)
    await wrapper!.setProps({ companies: [...companies] })
    expect(select.props('value')).toBe(3)
    await (wrapper!.vm as unknown as { save(): Promise<void> }).save()
    expect(api.save).toHaveBeenCalledExactlyOnceWith({
      jobId: job.id,
      observationId: job.observationId,
      companyId: 3,
      newCompanyName: undefined,
      statusId: 1,
      resumeVersionId: null,
    })
    expect(wrapper!.emitted('saved')).toHaveLength(1)
  },
)

it('selects only signed-in platforms and disables every other platform', async () => {
  await fixture(null, { authenticated: ['boss', 'zhilian'], search: false })
  expect(wrapper!.findComponent(NCheckboxGroup).props('value')).toEqual(['boss', 'zhilian'])
  expect(
    wrapper!
      .findComponent(NCheckboxGroup)
      .findAllComponents(NCheckbox)
      .map((item) => item.props('disabled')),
  ).toEqual([false, true, false, true, true, true])
})

function searchButton() {
  return wrapper!.find('.discovery-search-buttons').findComponent(NButton)
}
it('submits the canonical Chinese city after changing the interface language', async () => {
  const { api } = await fixture(null, { search: false })
  wrapper!.findComponent(NSelect).vm.$emit('update:value', '上海')
  i18n.global.locale.value = 'en-US'
  await flushPromises()
  expect(wrapper!.findComponent(NSelect).props('value')).toBe('上海')
  expect(wrapper!.findComponent(NSelect).props('options')).toContainEqual({
    label: 'Shanghai',
    value: '上海',
  })
  searchButton().vm.$emit('click')
  await flushPromises()
  expect(api.start).toHaveBeenCalledWith(
    expect.objectContaining({ query: { keyword: 'Java', city: '上海', platforms: ['boss'] } }),
  )
})

it('translates historical city labels while preserving original locked query values', async () => {
  const { api, run } = await fixture(null, { search: false })
  const saved = { ...run, query: { ...run.query, city: '恩施土家族苗族自治州' } }
  api.history.mockResolvedValue({ items: [saved], total: 1 })
  api.run.mockResolvedValue(saved)
  i18n.global.locale.value = 'en-US'
  await (wrapper!.vm as unknown as { openHistory(): Promise<void> }).openHistory()
  expect(wrapper!.find('.discovery-history-heading').text()).toContain('Enshi')
  wrapper!
    .findAllComponents(NButton)
    .find((button) => button.text() === 'View')!
    .vm.$emit('click')
  await flushPromises()
  const select = wrapper!.findComponent(NSelect)
  expect(select.props('value')).toBe(saved.query.city)
  expect(select.props('disabled')).toBe(true)
  expect(saved.query.city).toBe('恩施土家族苗族自治州')
})

it('uses selected-site city intersections and clears even a still-supported city on changes', async () => {
  await fixture(null, { authenticated: ['boss', 'liepin', 'wuyou'], search: false })
  const group = wrapper!.findComponent(NCheckboxGroup)
  const citySelect = () => wrapper!.findComponent(NSelect)
  const selectSites = async (sites: JobPlatform[]) => {
    group.vm.$emit('update:value', sites)
    await flushPromises()
  }
  await selectSites(['boss'])
  expect(citySelect().props('options')).toEqual(
    commonCities(['boss']).map((c) => ({ label: c.name, value: c.name })),
  )
  citySelect().vm.$emit('update:value', '北京')
  await selectSites(['boss', 'liepin'])
  expect(citySelect().props('value')).toBeNull()
  expect(citySelect().props('options')).toEqual(
    commonCities(['boss', 'liepin']).map((c) => ({ label: c.name, value: c.name })),
  )
  citySelect().vm.$emit('update:value', '北京')
  await selectSites(['liepin', 'boss'])
  expect(citySelect().props('value')).toBe('北京')
  await selectSites(['liepin'])
  expect(citySelect().props('value')).toBeNull()
  await selectSites([])
  expect(citySelect().props('disabled')).toBe(true)
  expect(citySelect().props('placeholder')).toBe('请先选择招聘网站')
  expect(citySelect().props('options')).toEqual([])
})

it('preserves the city on unchanged account polls and clears on automatic login or logout changes', async () => {
  const { api } = await fixture(null, { search: false })
  const citySelect = () => wrapper!.findComponent(NSelect)
  citySelect().vm.$emit('update:value', '北京')
  await vi.advanceTimersByTimeAsync(2000)
  expect(citySelect().props('value')).toBe('北京')
  api.status.mockResolvedValue(accountStatuses(['boss', 'liepin']))
  await vi.advanceTimersByTimeAsync(2000)
  expect(citySelect().props('value')).toBeNull()
  citySelect().vm.$emit('update:value', '北京')
  api.status.mockResolvedValue(accountStatuses(['boss']))
  await vi.advanceTimersByTimeAsync(2000)
  expect(citySelect().props('value')).toBeNull()
})

it('allows a default-location search when selected sites have no common cities', async () => {
  const intersection = vi.spyOn(cityCatalog, 'commonCities').mockReturnValue([])
  try {
    const { api } = await fixture(null, { search: false })
    const select = wrapper!.findComponent(NSelect)
    expect(select.props('disabled')).toBe(true)
    expect(select.props('placeholder')).toBe('所选网站暂无共同城市')
    expect(searchButton().props('disabled')).toBe(false)
    searchButton().vm.$emit('click')
    await flushPromises()
    expect(api.start).toHaveBeenCalledWith(
      expect.objectContaining({ query: { keyword: 'Java', city: '', platforms: ['boss'] } }),
    )
  } finally {
    intersection.mockRestore()
  }
})

it('waits for a newer account poll before submitting a city from an older refresh', async () => {
  const { api } = await fixture(null, { search: false })
  wrapper!.findComponent(NSelect).vm.$emit('update:value', '白杨')
  const pending: ((states: PlatformStatus[]) => void)[] = []
  api.status.mockImplementation(() => new Promise((resolve) => pending.push(resolve)))
  searchButton().vm.$emit('click')
  await flushPromises()
  await vi.advanceTimersByTimeAsync(1800)
  expect(pending).toHaveLength(2)
  pending[0](accountStatuses(['boss']))
  await flushPromises()
  expect(api.start).not.toHaveBeenCalled()
  pending[1](accountStatuses(['boss', 'liepin']))
  await flushPromises()
  expect(api.start).toHaveBeenCalledWith(
    expect.objectContaining({
      query: { keyword: 'Java', city: '', platforms: ['boss', 'liepin'] },
    }),
  )
})

it('clears the old city synchronously when submit refreshes the selected accounts', async () => {
  const { api } = await fixture(null, { search: false })
  wrapper!.findComponent(NSelect).vm.$emit('update:value', '白杨')
  api.status.mockResolvedValue(accountStatuses(['boss', 'liepin']))
  searchButton().vm.$emit('click')
  await flushPromises()
  expect(api.start).toHaveBeenCalledWith(
    expect.objectContaining({
      query: { keyword: 'Java', city: '', platforms: ['boss', 'liepin'] },
    }),
  )
})
async function newSearch() {
  await (wrapper!.vm as unknown as { newSearch(): Promise<void> }).newSearch()
  await flushPromises()
}
async function showSalaryFilters() {
  wrapper!
    .findAllComponents(NButton)
    .find((button) => button.text() === '薪资筛选')!
    .vm.$emit('click')
  await flushPromises()
}
function expectQueryLocked(locked: boolean) {
  expect(wrapper!.findComponent(NInput).props('disabled')).toBe(locked)
  expect(wrapper!.findComponent(NSelect).props('disabled')).toBe(locked)
  for (const input of wrapper!.findAllComponents(NInputNumber))
    expect(input.props('disabled')).toBe(locked)
  if (locked)
    expect(
      wrapper!
        .findComponent(NCheckboxGroup)
        .findAllComponents(NCheckbox)
        .every((item) => item.props('disabled')),
    ).toBe(true)
}

it.each([0, 1])(
  'uses one search button and continues the same task with %s results',
  async (count) => {
    const { api, run, job } = await fixture(null, { search: false })
    await showSalaryFilters()
    api.start.mockResolvedValue({ ...run, state: 'partial' })
    api.list.mockResolvedValue({
      viewId: 'view-one',
      items: count ? [job] : [],
      total: count,
      page: 1,
      pageSize: 20,
    })
    expectQueryLocked(false)
    searchButton().vm.$emit('click')
    await flushPromises()
    expectQueryLocked(true)
    expect(searchButton().text()).toBe(count ? '搜索更多岗位' : '搜索岗位')
    expect(
      wrapper!
        .findAllComponents(NButton)
        .filter((button) => ['搜索岗位', '搜索更多岗位'].includes(button.text())),
    ).toHaveLength(1)
    searchButton().vm.$emit('click')
    await flushPromises()
    expect(api.continue).toHaveBeenCalledWith(run.id)
    expect(api.start).toHaveBeenCalledOnce()
    expect(searchButton().text()).toBe('取消搜索')
    searchButton().vm.$emit('click')
    await flushPromises()
    expect(api.cancel).toHaveBeenCalledWith(run.id)
    expectQueryLocked(true)
  },
)

it('locks conditions during submission and keeps them locked on a failed request until reset', async () => {
  const { api } = await fixture(null, { search: false })
  await showSalaryFilters()
  let rejectStart!: (error: unknown) => void
  api.start.mockImplementation(
    () =>
      new Promise((_, reject) => {
        rejectStart = reject
      }),
  )
  searchButton().vm.$emit('click')
  await flushPromises()
  expectQueryLocked(true)
  rejectStart({ code: 'DISCOVERY_FAILED' })
  await flushPromises()
  expectQueryLocked(true)
  await newSearch()
  await showSalaryFilters()
  expectQueryLocked(false)
})

it('keeps the submitted platform selection through account changes and view navigation', async () => {
  const { api } = await fixture()
  api.status.mockResolvedValue(accountStatuses(['liepin']))
  await vi.advanceTimersByTimeAsync(2000)
  await wrapper!.setProps({ active: false })
  await wrapper!.setProps({ active: true })
  await flushPromises()
  expect(wrapper!.findComponent(NCheckboxGroup).props('value')).toEqual(['boss'])
  expectQueryLocked(true)
  await newSearch()
  expect(wrapper!.findComponent(NCheckboxGroup).props('value')).toEqual(['liepin'])
  expectQueryLocked(false)
})

it('resets conditions, pagination and results, cancels the active run and ignores its late details and list', async () => {
  const { api, job, detail, run } = await fixture(null, { search: false })
  await showSalaryFilters()
  wrapper!.findComponent(NSelect).vm.$emit('update:value', '上海')
  wrapper!.findAllComponents(NInputNumber)[0].vm.$emit('update:value', 10000)
  wrapper!.findAllComponents(NInputNumber)[1].vm.$emit('update:value', 20000)
  searchButton().vm.$emit('click')
  await flushPromises()
  wrapper!.findAllComponents(NSelect)[1].vm.$emit('update:value', 'salary')
  await flushPromises()
  // Supply an old detail request and a page read that both complete after reset.
  let resolveDetail!: (value: DiscoveredJob) => void
  detail.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveDetail = resolve
      }),
  )
  await wrapper!.find('.discovery-job').trigger('click')
  await flushPromises()
  let resolveList!: (value: Awaited<ReturnType<typeof api.list>>) => void
  api.list.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveList = resolve
      }),
  )
  wrapper!.findComponent(NPagination).vm.$emit('update:page-size', 50)
  await flushPromises()
  await newSearch()
  expect(api.cancel).toHaveBeenCalledWith(run.id)
  expect(api.browser).toHaveBeenLastCalledWith({ action: 'close' })
  expect(api.verification).toHaveBeenCalledWith({ action: 'close' })
  resolveDetail({ ...job, jd: '旧请求详情' })
  resolveList({ viewId: 'old-view', items: [job], total: 1, page: 1, pageSize: 50 })
  await flushPromises()
  expect(wrapper!.findComponent(NInput).props('value')).toBe('')
  expect(wrapper!.findComponent(NSelect).props('value')).toBe(null)
  expect(wrapper!.findAllComponents(NSelect)[1].props('value')).toBe('relevance')
  expect(wrapper!.find('.discovery-filters').exists()).toBe(false)
  expect(wrapper!.find('.discovery-job').exists()).toBe(false)
  expect(wrapper!.findComponent(NPagination).exists()).toBe(false)
  expect(wrapper!.text()).not.toContain('旧请求详情')
  expect(wrapper!.find('.discovery-list-tools').text()).toContain('0 个岗位')
  expect(searchButton().text()).toBe('搜索岗位')
  await showSalaryFilters()
  expectQueryLocked(false)
  expect(wrapper!.findAllComponents(NInputNumber).map((input) => input.props('value'))).toEqual([
    null,
    null,
  ])
  api.list.mockResolvedValue({ viewId: 'new-view', items: [job], total: 1, page: 1, pageSize: 20 })
  wrapper!.findComponent(NInput).vm.$emit('update:value', 'Python')
  searchButton().vm.$emit('click')
  await flushPromises()
  expect(api.start).toHaveBeenCalledTimes(2)
  expect(api.start.mock.calls[1]).toEqual([
    expect.objectContaining({ query: { keyword: 'Python', city: '', platforms: ['boss'] } }),
  ])
  expect(api.list).toHaveBeenLastCalledWith(
    expect.objectContaining({ page: 1, pageSize: 20, sort: 'relevance' }),
  )
})

it.each(['resolve', 'reject'])(
  'ignores an old run poll that settles with %s after reset',
  async (outcome) => {
    const { api, run } = await fixture()
    let resolveRun!: (value: SearchRun) => void
    let rejectRun!: (error: unknown) => void
    api.run.mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          resolveRun = resolve
          rejectRun = reject
        }),
    )
    await vi.advanceTimersByTimeAsync(1000)
    await newSearch()
    api.list.mockClear()
    if (outcome === 'resolve') resolveRun(run)
    else rejectRun({ code: 'DISCOVERY_FAILED' })
    await flushPromises()
    expect(api.list).not.toHaveBeenCalled()
    expect(wrapper!.find('.discovery-job').exists()).toBe(false)
    expect(searchButton().text()).toBe('搜索岗位')
    expectQueryLocked(false)
    expect(wrapper!.findComponent(NAlert).exists()).toBe(false)
  },
)

it('leaves invalid drafts editable and starts with an unlocked blank page after remount', async () => {
  const { api } = await fixture(null, { search: false })
  wrapper!.findComponent(NInput).vm.$emit('update:value', ' ')
  searchButton().vm.$emit('click')
  await flushPromises()
  expect(api.start).not.toHaveBeenCalled()
  expectQueryLocked(false)
  wrapper!.unmount()
  await fixture(null, { search: false })
  expectQueryLocked(false)
  expect(wrapper!.find('.discovery-job').exists()).toBe(false)
})

it('keeps the existing page when cancelling for a new search fails', async () => {
  const { api } = await fixture()
  api.cancel.mockRejectedValue({ code: 'DISCOVERY_FAILED' })
  await newSearch()
  expect(wrapper!.find('.discovery-job').exists()).toBe(true)
  expect(wrapper!.findComponent(NInput).props('value')).toBe('Java')
  expectQueryLocked(true)
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
  ).toEqual([false, true, true, true, true, true])
})

it('shows the original locked conditions when opening history even if a platform is signed out', async () => {
  const { api, run } = await fixture(null, { search: false })
  api.history.mockResolvedValue({
    items: [{ ...run, query: { ...run.query, city: '历史城市', platforms: [...platforms] } }],
    total: 1,
  })
  await (wrapper!.vm as unknown as { openHistory(): Promise<void> }).openHistory()
  wrapper!
    .findAllComponents(NButton)
    .find((button) => button.text() === '查看')!
    .vm.$emit('click')
  await flushPromises()
  expect(wrapper!.findComponent(NCheckboxGroup).props('value')).toEqual(platforms)
  expect(wrapper!.findComponent(NSelect).props('value')).toBe('历史城市')
  expect(wrapper!.findComponent(NInput).props('disabled')).toBe(true)
  expect(
    wrapper!
      .findComponent(NCheckboxGroup)
      .findAllComponents(NCheckbox)
      .every((item) => item.props('disabled')),
  ).toBe(true)
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
  await (wrapper!.vm as unknown as { newSearch(): Promise<void> }).newSearch()
  await flushPromises()
  expect(wrapper!.find('.discovery-offline').exists()).toBe(false)
})

it.each(['challenge', 'session_expired'] as const)(
  'shows a new %s warning when a completed search encounters a detail block',
  async (state) => {
    const { api, run, job, detail } = await fixture()
    const completed: SearchRun = {
      ...run,
      state: 'completed',
      sources: [source('boss', 'completed')],
    }
    api.run.mockResolvedValue(completed)
    await vi.advanceTimersByTimeAsync(1800)
    await flushPromises()
    expect(wrapper!.find('.discovery-verification').exists()).toBe(false)
    detail.mockImplementation(async () => {
      api.run.mockResolvedValue({ ...completed, sources: [source('boss', state)] })
      if (state === 'session_expired') throw { code: 'DISCOVERY_FAILED' }
      return { ...job, missing: { jd: 'challenge' as const } }
    })
    await wrapper!.find('.discovery-job').trigger('click')
    await flushPromises()
    expect(wrapper!.find('.discovery-verification').text()).toContain(
      state === 'challenge' ? '需要网站验证' : '会话失效',
    )
    expect(detail).toHaveBeenCalledOnce()
  },
)

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

it('keeps a loading indicator until the current webpage finishes and ignores old page events', async () => {
  const { api, browserLoading, removeBrowserLoadingListener } = await fixture()
  await wrapper!.find('.discovery-job').trigger('click')
  await flushPromises()
  const click = async (label: string) => {
    wrapper!
      .findAllComponents(NButton)
      .find((button) => button.text() === label)!
      .vm.$emit('click')
    await flushPromises()
  }
  await click('打开网页')
  const opening = api.browser.mock.calls.at(-1)![0]
  if (opening.action !== 'open') throw new Error('Expected webpage open')
  expect(wrapper!.find('.discovery-browser-loading').text()).toBe('网页加载中…')
  expect(api.region).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }))
  browserLoading({ requestId: opening.requestId, loading: false })
  await flushPromises()
  expect(wrapper!.find('.discovery-browser-loading').exists()).toBe(false)
  expect(api.region).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true }))

  // In-page navigation and toolbar actions use the same native loading events.
  browserLoading({ requestId: opening.requestId, loading: true })
  await flushPromises()
  expect(wrapper!.find('.discovery-browser-loading').exists()).toBe(true)
  expect(api.region).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }))
  await click('详情')
  browserLoading({ requestId: opening.requestId, loading: true })
  await flushPromises()
  expect(wrapper!.find('.discovery-browser-loading').exists()).toBe(false)
  await click('打开网页')
  const reopened = api.browser.mock.calls.at(-1)![0]
  if (reopened.action !== 'open') throw new Error('Expected webpage open')
  expect(reopened.requestId).not.toBe(opening.requestId)
  browserLoading({ requestId: opening.requestId, loading: false })
  await flushPromises()
  expect(wrapper!.find('.discovery-browser-loading').exists()).toBe(true)
  browserLoading({ requestId: reopened.requestId, loading: false })
  await flushPromises()
  expect(wrapper!.find('.discovery-browser-loading').exists()).toBe(false)
  wrapper!.unmount()
  wrapper = undefined
  expect(removeBrowserLoadingListener).toHaveBeenCalledOnce()
})

it('does not open a delayed webpage after returning to details', async () => {
  const { api } = await fixture()
  await wrapper!.find('.discovery-job').trigger('click')
  await flushPromises()
  let releaseRegion!: () => void
  api.region.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        releaseRegion = resolve
      }),
  )
  wrapper!
    .findAllComponents(NButton)
    .find((button) => button.text() === '打开网页')!
    .vm.$emit('click')
  await flushPromises()
  wrapper!
    .findAllComponents(NButton)
    .find((button) => button.text() === '详情')!
    .vm.$emit('click')
  await flushPromises()
  releaseRegion()
  await flushPromises()
  expect(api.browser.mock.calls.some(([input]) => input.action === 'open')).toBe(false)
  expect(wrapper!.find('.discovery-browser-region').exists()).toBe(false)
})

it('clears the webpage loading indicator if opening the native view fails', async () => {
  const { api } = await fixture()
  await wrapper!.find('.discovery-job').trigger('click')
  await flushPromises()
  api.browser.mockRejectedValueOnce({ code: 'DISCOVERY_FAILED' })
  wrapper!
    .findAllComponents(NButton)
    .find((button) => button.text() === '打开网页')!
    .vm.$emit('click')
  await flushPromises()
  expect(wrapper!.find('.discovery-browser-loading').exists()).toBe(false)
  expect(wrapper!.findComponent(NAlert).exists()).toBe(true)
})

it('navigates to a newly selected job before its detail request completes or fails', async () => {
  const { api, job, detail } = await fixture()
  await wrapper!.find('.discovery-job').trigger('click')
  await flushPromises()
  wrapper!
    .findAllComponents(NButton)
    .find((b) => b.text() === '打开网页')!
    .vm.$emit('click')
  await flushPromises()
  const pane = wrapper!.find('.discovery-detail')
  expect(pane.classes()).toContain('discovery-detail-web')
  expect(pane.element.children).toHaveLength(1)
  expect(pane.find('.discovery-browser-region').exists()).toBe(true)
  expect(pane.find('.discovery-detail-header').exists()).toBe(false)
  expect(pane.find('.discovery-detail-actions').exists()).toBe(false)
  const toolbar = wrapper!.find('.discovery > .discovery-browser-toolbar')
  expect(toolbar.exists()).toBe(true)
  expect(toolbar.element.nextElementSibling).toBe(wrapper!.find('.discovery-panes').element)
  expect(toolbar.findAllComponents(NButton).map((button: VueWrapper) => button.text())).toEqual([
    '返回列表',
    '详情',
    '返回',
    '前进',
    '刷新',
    '外部打开',
    '加入求职记录',
  ])
  for (const [label, action] of [
    ['返回', 'back'],
    ['前进', 'forward'],
    ['刷新', 'reload'],
    ['外部打开', 'external'],
  ]) {
    toolbar
      .findAllComponents(NButton)
      .find((button: VueWrapper) => button.text() === label)!
      .vm.$emit('click')
    await flushPromises()
    expect(api.browser).toHaveBeenLastCalledWith({ action })
  }
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
  expect(api.browser).toHaveBeenLastCalledWith({
    action: 'open',
    jobId: next.id,
    requestId: expect.any(String),
  })
  rejectDetail({ code: 'DISCOVERY_FAILED' })
  await flushPromises()
  expect(wrapper!.find('.discovery-detail-header').exists()).toBe(false)
  expect(wrapper!.find('.discovery-detail').element.children).toHaveLength(1)
  expect(api.browser).toHaveBeenLastCalledWith({
    action: 'open',
    jobId: next.id,
    requestId: expect.any(String),
  })
  toolbar
    .findAllComponents(NButton)
    .find((button: VueWrapper) => button.text() === '详情')!
    .vm.$emit('click')
  await flushPromises()
  expect(api.browser).toHaveBeenLastCalledWith({ action: 'close' })
  expect(wrapper!.find('.discovery-browser-toolbar').exists()).toBe(false)
  expect(wrapper!.find('.discovery-browser-region').exists()).toBe(false)
  expect(wrapper!.find('.discovery-detail').classes()).not.toContain('discovery-detail-web')
  expect(wrapper!.find('.discovery-detail-header').text()).toContain(next.title)
  expect(wrapper!.find('.discovery-detail-actions').exists()).toBe(true)
})
