// @vitest-environment jsdom
import { createPinia } from 'pinia'
import { flushPromises, shallowMount, type VueWrapper } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import WorkspaceView from '../src/renderer/views/WorkspaceView.vue'
import JobDiscoveryView from '../src/renderer/views/JobDiscoveryView.vue'
import OpportunitiesView from '../src/renderer/views/OpportunitiesView.vue'
import Sidebar from '../src/renderer/layout/Sidebar.vue'
import { useAgentStore } from '../src/renderer/stores/agent'
import { useOpportunitiesStore } from '../src/renderer/stores/opportunities'
import { i18n } from '../src/renderer/i18n'
import type { Opportunity } from '../src/shared/types'

const { showError, showSuccess } = vi.hoisted(() => ({
  showError: vi.fn(),
  showSuccess: vi.fn(),
}))
vi.mock('naive-ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('naive-ui')>()),
  createDiscreteApi: () => ({ message: { error: showError, success: showSuccess } }),
}))

let wrapper: VueWrapper | undefined
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  showError.mockClear()
  showSuccess.mockClear()
})

async function fixture() {
  const api = {
    config: { get: vi.fn().mockResolvedValue(null) },
    statuses: { list: vi.fn().mockResolvedValue([]) },
    industries: { list: vi.fn().mockResolvedValue([]) },
    resumes: { list: vi.fn().mockResolvedValue([]) },
    companies: {
      list: vi.fn().mockResolvedValue([]),
      search: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    },
    opportunities: {
      list: vi.fn().mockResolvedValue([]),
      search: vi.fn().mockResolvedValue({ items: [], total: 30 }),
    },
    calendar: { list: vi.fn().mockResolvedValue([]), onReminderClick: vi.fn() },
    data: { onExternalChange: vi.fn() },
    companyCatalog: { getStatus: vi.fn().mockResolvedValue(null), onProgress: vi.fn() },
    system: { isDevelopment: vi.fn().mockResolvedValue(false) },
    mcp: { getConnectionInfo: vi.fn().mockResolvedValue(null) },
  }
  vi.stubGlobal('zhijiApi', api)
  vi.stubGlobal('velopackApi', { getVersion: vi.fn().mockResolvedValue('2.1.0') })
  vi.stubGlobal('diagnosticsApi', { report: vi.fn().mockResolvedValue(undefined) })
  const pinia = createPinia()
  vi.spyOn(useAgentStore(pinia), 'start').mockResolvedValue(undefined)
  wrapper = shallowMount(WorkspaceView, {
    global: { plugins: [pinia, i18n], renderStubDefaultSlot: true },
  })
  await flushPromises()
  expect(showError).not.toHaveBeenCalled()
  expect(showSuccess).not.toHaveBeenCalled()
  return { api, store: useOpportunitiesStore(pinia) }
}

it('refreshes the records and linked options after discovery saves, retaining filters and pagination', async () => {
  const { api, store } = await fixture()
  const view = wrapper!.findComponent(OpportunitiesView)
  view.vm.$emit('update:search', 'Java')
  view.vm.$emit('update:selected-status-id', 2)
  view.vm.$emit('update:selected-company-id', 7)
  await flushPromises()
  const pagination = view.props('pagination') as { onUpdatePage: (page: number) => void }
  pagination.onUpdatePage(2)
  await flushPromises()
  wrapper!.findComponent(Sidebar).vm.$emit('update:value', 'discovery')
  await flushPromises()

  const saved: Opportunity = {
    id: 31,
    companyId: 7,
    companyName: '测试公司',
    title: 'Java 工程师',
    statusId: 2,
    statusLabel: '待投递',
    department: null,
    location: null,
    source: 'boss',
    jobUrl: null,
    description: null,
    resumeVersionId: null,
    resumeVersionName: null,
    discoveredAt: 1,
    appliedAt: null,
    deadlineAt: null,
    notes: null,
    createdAt: 1,
    updatedAt: 1,
  }
  api.opportunities.search.mockClear().mockResolvedValue({ items: [saved], total: 31 })
  api.opportunities.list.mockClear().mockResolvedValue([saved])
  api.companies.list.mockClear()
  wrapper!.findComponent(JobDiscoveryView).vm.$emit('saved')
  expect(showSuccess).toHaveBeenCalledExactlyOnceWith('已加入求职记录')
  await flushPromises()

  expect(api.opportunities.search).toHaveBeenCalledExactlyOnceWith({
    page: 2,
    pageSize: 10,
    search: 'Java',
    statusId: 2,
    companyId: 7,
  })
  expect(api.opportunities.list).toHaveBeenCalledOnce()
  expect(api.companies.list).toHaveBeenCalledOnce()
  expect(store.allItems).toEqual([saved])
  wrapper!.findComponent(Sidebar).vm.$emit('update:value', 'opportunities')
  await flushPromises()
  expect(wrapper!.findComponent(OpportunitiesView).props('data')).toEqual([saved])
  expect(wrapper!.findComponent(OpportunitiesView).props('pagination')).toMatchObject({
    page: 2,
    itemCount: 31,
  })
})

it('still refreshes records when a related refresh fails and reports the error', async () => {
  const { api } = await fixture()
  api.companies.list.mockRejectedValueOnce(new Error('Company refresh failed'))
  api.opportunities.search.mockClear().mockResolvedValue({ items: [], total: 31 })
  wrapper!.findComponent(JobDiscoveryView).vm.$emit('saved')
  await flushPromises()
  expect(api.opportunities.search).toHaveBeenCalledOnce()
  expect(wrapper!.findComponent(OpportunitiesView).props('pagination')).toMatchObject({
    itemCount: 31,
  })
  expect(showError).toHaveBeenCalledOnce()
  expect(showSuccess).toHaveBeenCalledExactlyOnceWith('已加入求职记录')
})
