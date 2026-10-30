// @vitest-environment jsdom
import fs from 'node:fs'
import { compile, defineComponent, nextTick, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { NSelect } from 'naive-ui'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type {
  Company,
  CompanySummary,
  CreateCompanyInput,
  CreateOpportunityInput,
} from '../src/shared/types'
import { useOpportunityCompanyPicker } from '../src/renderer/composables/useOpportunityCompanyPicker'
import { i18n } from '../src/renderer/i18n'

// Use the actual selector and keyboard handling. Emitting update:value from a
// stub would miss which action Enter chooses after filtering the options.
const source = fs.readFileSync('src/renderer/views/WorkspaceView.vue', 'utf8')
const modal = source.slice(source.indexOf('<n-modal v-model:show="showOpportunityModal">'))
const selector = modal.match(/<n-select[\s\S]*?\/>/)?.[0]
if (!selector) throw new Error('Opportunity company selector was not found')
const render = compile(selector)
const wrappers: VueWrapper[] = []
const originalScrollTo = HTMLElement.prototype.scrollTo

beforeAll(() => {
  // jsdom has no layout or scrollTo; retain the real virtual list and select.
  HTMLElement.prototype.scrollTo = vi.fn()
  vi.stubGlobal('matchMedia', (media: string) => ({
    media,
    matches: false,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
  }))
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
})
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount())
})
afterAll(() => {
  if (originalScrollTo) HTMLElement.prototype.scrollTo = originalScrollTo
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo')
  vi.unstubAllGlobals()
})

function company(id: number, name: string, aliases: string[] = []): Company {
  return {
    id,
    name,
    aliases,
    companyNature: null,
    industryIds: [],
    industryName: null,
    careerUrl: null,
    lastReadAt: null,
    isBuiltin: false,
    isFavorite: false,
    createdAt: 1,
    updatedAt: 1,
    locations: ['上海'],
  }
}
function summary(value: Company): CompanySummary {
  const { locations: _locations, ...result } = value
  return result
}
function form(): CreateOpportunityInput {
  return {
    companyId: 1,
    title: '已填写岗位',
    notes: '已填写备注',
    statusId: 1,
    department: null,
    location: null,
    source: null,
    jobUrl: null,
    description: null,
    resumeVersionId: null,
    discoveredAt: null,
    appliedAt: null,
    deadlineAt: null,
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

interface Overrides {
  create?: (input: CreateCompanyInput) => Promise<Company>
  loadCompanies?: () => Promise<void>
  loadManagedCompanies?: () => Promise<void>
}
function harness(overrides: Overrides = {}) {
  const companies = ref<CompanySummary[]>([
    summary(company(1, '默认公司')),
    summary(company(2, '中兴通讯股份有限公司', ['中兴', 'ZTE'])),
  ])
  const opportunityForm = ref(form())
  const showOpportunityModal = ref(true)
  const create = vi.fn(
    overrides.create ?? (async (input: CreateCompanyInput) => company(9, input.name)),
  )
  const loadCompanies = vi.fn(overrides.loadCompanies ?? (async () => {}))
  const loadManagedCompanies = vi.fn(overrides.loadManagedCompanies ?? (async () => {}))
  const notifySuccess = vi.fn()
  const showError = vi.fn()
  Object.defineProperty(window, 'zhijiApi', {
    configurable: true,
    value: { companies: { create } },
  })
  let picker: ReturnType<typeof useOpportunityCompanyPicker> | undefined
  const wrapper = mount(
    defineComponent({
      components: { NSelect },
      setup() {
        const { t } = useI18n()
        picker = useOpportunityCompanyPicker({
          companies,
          opportunityForm,
          showOpportunityModal,
          loadCompanies,
          loadManagedCompanies,
          notifySuccess,
          showError,
        })
        return { ...picker, opportunityForm, t }
      },
      render,
    }),
    { attachTo: document.body, global: { plugins: [i18n] } },
  )
  wrappers.push(wrapper)
  if (!picker) throw new Error('Company picker was not initialized')
  return {
    picker,
    wrapper,
    companies,
    opportunityForm,
    showOpportunityModal,
    create,
    loadCompanies,
    loadManagedCompanies,
    notifySuccess,
    showError,
  }
}
async function search(wrapper: VueWrapper, text: string) {
  const input = wrapper.get('input')
  await input.trigger('focus')
  await input.setValue(text)
  await flushPromises()
  return input
}

describe('opportunity company picker', () => {
  it.each(['中兴', 'ztE', '通讯'])(
    'selects the existing match with Enter for %s without creating a company',
    async (text) => {
      const state = harness()
      const input = await search(state.wrapper, text)
      await input.trigger('keydown', { key: 'Enter' })
      await flushPromises()
      expect(state.opportunityForm.value.companyId).toBe(2)
      expect(state.create).not.toHaveBeenCalled()
    },
  )

  it('offers creation after matches and still allows explicitly choosing that action', async () => {
    const state = harness()
    const input = await search(state.wrapper, '中兴')
    const matches = state.picker.opportunityCompanyOptions.value.filter((option) =>
      state.picker.filterCompanyOption('中兴', option),
    )
    expect(matches.map((option) => option.value)).toEqual([2, '__create_company__'])
    await input.trigger('keydown', { key: 'ArrowDown' })
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(state.create).toHaveBeenCalledExactlyOnceWith({ name: '中兴' })
    expect(state.opportunityForm.value.companyId).toBe(9)
  })

  it('creates and selects a trimmed new name without losing draft fields or storing full details', async () => {
    const state = harness()
    const before = { ...state.opportunityForm.value }
    const input = await search(state.wrapper, '  全新公司  ')
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(state.create).toHaveBeenCalledExactlyOnceWith({ name: '全新公司' })
    expect(state.opportunityForm.value).toEqual({ ...before, companyId: 9 })
    const created = state.companies.value.find((item) => item.id === 9)
    expect(created).toMatchObject({ name: '全新公司', aliases: [] })
    expect(created).not.toHaveProperty('locations')
    expect(state.loadCompanies).toHaveBeenCalledOnce()
    expect(state.loadManagedCompanies).toHaveBeenCalledOnce()
    expect(state.notifySuccess).toHaveBeenCalledOnce()
  })

  it('selects the committed company before refreshing and keeps it when the summary refresh fails', async () => {
    const refresh = deferred<void>()
    const failure = new Error('公司列表读取失败')
    const state = harness({ loadCompanies: () => refresh.promise })
    const input = await search(state.wrapper, '刷新失败公司')
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(state.opportunityForm.value.companyId).toBe(9)
    expect(state.picker.companyOptions.value).toContainEqual(
      expect.objectContaining({ value: 9, label: '刷新失败公司' }),
    )
    expect(state.notifySuccess).toHaveBeenCalledOnce()
    expect(state.loadManagedCompanies).toHaveBeenCalledOnce()
    refresh.reject(failure)
    await flushPromises()
    expect(state.showError).toHaveBeenCalledExactlyOnceWith(failure)
    expect(state.opportunityForm.value.companyId).toBe(9)
    expect(state.companies.value.find((item) => item.id === 9)).not.toHaveProperty('locations')
    expect(state.picker.creatingCompany.value).toBe(false)
  })

  it('keeps a successful selection when the management refresh fails', async () => {
    const failure = new Error('公司管理刷新失败')
    const state = harness({
      loadManagedCompanies: async () => {
        throw failure
      },
    })
    const input = await search(state.wrapper, '管理刷新公司')
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(state.opportunityForm.value.companyId).toBe(9)
    expect(state.showError).toHaveBeenCalledExactlyOnceWith(failure)
    expect(state.notifySuccess).toHaveBeenCalledOnce()
  })

  it('does not offer creation for an exact name or a whitespace-only search', () => {
    const state = harness()
    for (const text of ['中兴通讯股份有限公司', '   ', '']) {
      state.picker.companySearch.value = text
      expect(
        state.picker.opportunityCompanyOptions.value.some(
          (option) => typeof option.value === 'string',
        ),
      ).toBe(false)
    }
  })

  it('handles a rejected creation without changing the draft, refreshing, or reporting success', async () => {
    const failure = new Error('公司名称已存在')
    const state = harness({
      create: async () => {
        throw failure
      },
    })
    const before = { ...state.opportunityForm.value }
    const input = await search(state.wrapper, '冲突公司')
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(state.opportunityForm.value).toEqual(before)
    expect(state.showError).toHaveBeenCalledExactlyOnceWith(failure)
    expect(state.loadCompanies).not.toHaveBeenCalled()
    expect(state.loadManagedCompanies).not.toHaveBeenCalled()
    expect(state.notifySuccess).not.toHaveBeenCalled()
    expect(state.picker.creatingCompany.value).toBe(false)
  })

  it('prevents repeated creation and does not overwrite a reopened form with a late result', async () => {
    const pending = deferred<Company>()
    const state = harness({ create: () => pending.promise })
    const input = await search(state.wrapper, '异步公司')
    const option = state.picker.opportunityCompanyOptions.value.at(-1)!
    await input.trigger('keydown', { key: 'Enter' })
    await nextTick()
    expect(state.wrapper.findComponent(NSelect).props('disabled')).toBe(true)
    await state.picker.selectOpportunityCompany('__create_company__', option)
    expect(state.create).toHaveBeenCalledOnce()
    state.showOpportunityModal.value = false
    state.opportunityForm.value = { ...form(), companyId: 2, title: '后来打开的表单' }
    state.showOpportunityModal.value = true
    pending.resolve(company(9, '异步公司'))
    await flushPromises()
    expect(state.opportunityForm.value).toMatchObject({ companyId: 2, title: '后来打开的表单' })
    expect(state.companies.value.filter((item) => item.id === 9)).toHaveLength(1)
    expect(state.wrapper.findComponent(NSelect).props('disabled')).toBe(false)
  })

  it('updates cached matches when a company name or alias changes', () => {
    const state = harness()
    const oldOptions = state.picker.companyOptions.value
    expect(state.picker.filterCompanyOption('中兴', oldOptions[1])).toBe(true)
    state.companies.value[1].name = '新名称'
    state.companies.value[1].aliases = ['New-Alias']
    expect(
      state.picker.filterCompanyOption('new-alias', state.picker.companyOptions.value[1]),
    ).toBe(true)
    expect(state.picker.filterCompanyOption('中兴', state.picker.companyOptions.value[1])).toBe(
      false,
    )
  })
})
