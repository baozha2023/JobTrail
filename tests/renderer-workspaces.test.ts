// @vitest-environment jsdom

import { defineComponent, h, ref } from 'vue'
import { createPinia } from 'pinia'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import type {
  CalendarEvent,
  Company,
  CreateCalendarEventInput,
  CreateOpportunityInput,
  Opportunity,
  OpportunityStatusFlow,
  Status,
} from '../src/shared/types'
import { useCalendarWorkspace } from '../src/renderer/composables/useCalendarWorkspace'
import { useOpportunityWorkspace } from '../src/renderer/composables/useOpportunityWorkspace'
import { useManagementWorkspace } from '../src/renderer/composables/useManagementWorkspace'
import { i18n } from '../src/renderer/i18n'
import type { ViewKey } from '../src/renderer/types'

function mountComposable<T>(factory: () => T): { workspace: T; wrapper: VueWrapper } {
  let workspace: T | undefined
  const Harness = defineComponent({
    setup() {
      workspace = factory()
      return () => h('div')
    },
  })
  const wrapper = mount(Harness, { global: { plugins: [createPinia(), i18n] } })
  if (!workspace) throw new Error('Composable was not initialized')
  return { workspace, wrapper }
}

function calendarEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 1,
    opportunityId: null,
    opportunityTitle: null,
    opportunityJobUrl: null,
    companyName: null,
    title: '日程',
    eventType: '自定义类型',
    startAt: Date.UTC(2026, 8, 7),
    endAt: Date.UTC(2026, 8, 7, 1),
    isAllDay: false,
    timezone: 'Asia/Shanghai',
    location: null,
    description: null,
    reminderMinutes: null,
    isCompleted: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function opportunity(overrides: Partial<Opportunity> = {}): Opportunity {
  return {
    id: 1,
    companyId: 1,
    companyName: '公司',
    title: '岗位',
    department: null,
    location: null,
    source: null,
    jobUrl: null,
    description: null,
    statusId: 2,
    statusLabel: '待投递',
    resumeVersionId: null,
    resumeVersionName: null,
    discoveredAt: null,
    appliedAt: null,
    deadlineAt: null,
    notes: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function company(overrides: Partial<Company> = {}): Company {
  return {
    id: 1,
    name: '公司',
    industryIds: [],
    industryName: null,
    careerUrl: null,
    lastReadAt: null,
    aliases: [],
    isBuiltin: false,
    isFavorite: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe('renderer domain workspaces', () => {
  it('normalizes an all-day editor value and refreshes the calendar after creation', async () => {
    const create = vi.fn(async (input: CreateCalendarEventInput) =>
      calendarEvent({
        ...input,
        id: 7,
        isAllDay: input.isAllDay ?? false,
        timezone: input.timezone ?? 'Asia/Shanghai',
      }),
    )
    Object.defineProperty(window, 'zhijiApi', {
      configurable: true,
      value: {
        calendar: {
          list: vi.fn(async () => []),
          get: vi.fn(async () => calendarEvent()),
          create,
          update: vi.fn(),
          delete: vi.fn(),
          onReminderClick: vi.fn(),
        },
      },
    })
    const activeView = ref<ViewKey>('calendar')
    const { workspace, wrapper } = mountComposable(() =>
      useCalendarWorkspace({
        activeView,
        showError: vi.fn(),
        notifySuccess: vi.fn(),
        notifyError: vi.fn(),
      }),
    )

    workspace.newEvent(new Date(2026, 8, 7))
    expect(workspace.eventTypeOptions.value).toHaveLength(4)
    expect(workspace.eventTypeOptions.value).not.toContainEqual({ label: '其他', value: '其他' })
    expect(workspace.eventForm.value.eventType).toBeNull()
    workspace.eventForm.value.eventType = '笔试'
    workspace.setEventAllDay(true)
    workspace.eventForm.value.title = '全天事项'
    workspace.eventForm.value.timezone = 'Asia/Shanghai'
    workspace.eventForm.value.startAt = new Date(2026, 8, 7).getTime()
    workspace.eventForm.value.endAt = new Date(2026, 8, 9).getTime()
    await workspace.saveEvent()

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        startAt: Date.UTC(2026, 8, 6, 16),
        endAt: Date.UTC(2026, 8, 8, 16),
        isAllDay: true,
        eventType: '笔试',
        timezone: 'Asia/Shanghai',
      }),
    )
    expect(workspace.showEventModal.value).toBe(false)
    workspace.newEvent(new Date(2026, 8, 7))
    workspace.eventForm.value.title = '自定义日程'
    await workspace.saveEvent()
    expect(create).toHaveBeenCalledTimes(1)
    workspace.eventForm.value.eventType = '技术沟通'
    await workspace.saveEvent()
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ eventType: '技术沟通' }))
    const previousLocale = i18n.global.locale.value
    try {
      i18n.global.locale.value = 'en-US'
      expect(workspace.eventTypeOptions.value).toContainEqual({
        label: 'Written test',
        value: 'Written test',
      })
      expect(workspace.eventTypeOptions.value).not.toContainEqual({
        label: 'Other',
        value: 'Other',
      })
      workspace.newEvent(new Date(2026, 8, 7))
      expect(workspace.eventForm.value.eventType).toBeNull()
    } finally {
      i18n.global.locale.value = previousLocale
    }
    wrapper.unmount()
  })

  it('creates an opportunity with the intended default status and refreshes linked domains', async () => {
    const create = vi.fn(async (input: CreateOpportunityInput) => opportunity({ ...input, id: 9 }))
    Object.defineProperty(window, 'zhijiApi', {
      configurable: true,
      value: {
        opportunities: { list: vi.fn(async () => []), create, update: vi.fn(), delete: vi.fn() },
      },
    })
    const statuses = ref<Status[]>([
      { id: 1, label: '感兴趣', sortOrder: 1, isBuiltin: true, createdAt: 1, updatedAt: 1 },
      { id: 2, label: '待投递', sortOrder: 2, isBuiltin: true, createdAt: 1, updatedAt: 1 },
    ])
    const loadCalendar = vi.fn(async () => undefined)
    const { workspace, wrapper } = mountComposable(() =>
      useOpportunityWorkspace({
        companies: ref([company()]),
        statuses,
        loadCalendar,
        showError: vi.fn(),
        notifySuccess: vi.fn(),
        notifyError: vi.fn(),
      }),
    )

    workspace.newOpportunity()
    expect(workspace.opportunityForm.value.statusId).toBe(2)
    workspace.opportunityForm.value.title = '测试岗位'
    await workspace.saveOpportunity()

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 1, statusId: 2, title: '测试岗位' }),
    )
    expect(loadCalendar).toHaveBeenCalledOnce()
    expect(workspace.showOpportunityModal.value).toBe(false)
    wrapper.unmount()
  })

  it('opens the status flow and ignores an older request after switching records', async () => {
    let finishFirst: ((value: OpportunityStatusFlow) => void) | undefined
    const first = new Promise<OpportunityStatusFlow>((resolve) => {
      finishFirst = resolve
    })
    const secondFlow: OpportunityStatusFlow = {
      opportunity: opportunity({ id: 2 }),
      events: [],
    }
    const statusFlow = vi.fn().mockReturnValueOnce(first).mockResolvedValueOnce(secondFlow)
    Object.defineProperty(window, 'zhijiApi', {
      configurable: true,
      value: {
        opportunities: {
          list: vi.fn(async () => []),
          statusFlow,
        },
      },
    })
    const { workspace, wrapper } = mountComposable(() =>
      useOpportunityWorkspace({
        companies: ref([company()]),
        statuses: ref([]),
        loadCalendar: vi.fn(async () => undefined),
        showError: vi.fn(),
        notifySuccess: vi.fn(),
        notifyError: vi.fn(),
      }),
    )

    workspace.openStatusFlow(opportunity())
    workspace.openStatusFlow(opportunity({ id: 2 }))
    expect(workspace.statusFlowOpportunity.value?.id).toBe(2)
    await flushPromises()
    expect(workspace.statusFlow.value).toEqual(secondFlow)
    finishFirst?.({ opportunity: opportunity(), events: [] })
    await flushPromises()
    expect(workspace.statusFlow.value).toEqual(secondFlow)
    workspace.closeStatusFlow()
    expect(workspace.showStatusFlowModal.value).toBe(false)
    expect(workspace.statusFlowOpportunity.value).toBeNull()
    expect(workspace.statusFlow.value).toBeNull()
    wrapper.unmount()
  })

  it('normalizes company aliases and performs every required cross-domain refresh', async () => {
    const create = vi.fn(async () => company({ id: 3 }))
    Object.defineProperty(window, 'zhijiApi', {
      configurable: true,
      value: {
        companies: { create, update: vi.fn(), delete: vi.fn() },
      },
    })
    const loadCompanies = vi.fn(async () => undefined)
    const loadOpportunities = vi.fn(async () => undefined)
    const loadAllOpportunities = vi.fn(async () => undefined)
    const loadCalendar = vi.fn(async () => undefined)
    const { workspace, wrapper } = mountComposable(() =>
      useManagementWorkspace({
        statuses: ref([]),
        industries: ref([]),
        resumes: ref([]),
        companies: ref([]),
        loadCompanies,
        loadOpportunities,
        loadAllOpportunities,
        loadCalendar,
        showError: vi.fn(),
        notifySuccess: vi.fn(),
        notifyError: vi.fn(),
      }),
    )

    workspace.openCompanyEditor()
    workspace.companyForm.value.name = '新公司'
    workspace.companyAliasInput.value = ' 简称,简称，第二简称 '
    workspace.commitCompanyAliasInput()
    await workspace.saveCompany()

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ name: '新公司', aliases: ['简称', '第二简称'] }),
    )
    expect(loadCompanies).toHaveBeenCalledOnce()
    expect(loadOpportunities).toHaveBeenCalledOnce()
    expect(loadAllOpportunities).toHaveBeenCalledOnce()
    expect(loadCalendar).toHaveBeenCalledOnce()
    wrapper.unmount()
    await flushPromises()
  })

  it('filters managed companies by name or aliases and industry', () => {
    const { workspace, wrapper } = mountComposable(() =>
      useManagementWorkspace({
        statuses: ref([]),
        industries: ref([]),
        resumes: ref([]),
        companies: ref([
          company({ id: 1, name: '名称命中', aliases: ['Alpha'], industryIds: [1] }),
          company({ id: 2, name: '别名命中', aliases: ['Target'], industryIds: [2] }),
          company({
            id: 3,
            name: '不应命中',
            industryName: 'Target 行业',
            careerUrl: 'https://target.example.com',
          }),
        ]),
        loadCompanies: vi.fn(async () => undefined),
        loadOpportunities: vi.fn(async () => undefined),
        loadAllOpportunities: vi.fn(async () => undefined),
        loadCalendar: vi.fn(async () => undefined),
        showError: vi.fn(),
        notifySuccess: vi.fn(),
        notifyError: vi.fn(),
      }),
    )

    workspace.companyManagementSearch.value = '名称命中'
    expect(workspace.managedCompanies.value.map((item) => item.id)).toEqual([1])
    workspace.companyManagementSearch.value = 'target'
    expect(workspace.managedCompanies.value.map((item) => item.id)).toEqual([2])
    workspace.selectedCompanyIndustryId.value = 1
    expect(workspace.managedCompanies.value).toEqual([])
    workspace.companyManagementSearch.value = ''
    expect(workspace.managedCompanies.value.map((item) => item.id)).toEqual([1])
    wrapper.unmount()
  })
})
