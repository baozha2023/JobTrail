// @vitest-environment jsdom
import fs from 'node:fs'
import { compile, computed, defineComponent, ref } from 'vue'
import { createPinia } from 'pinia'
import { mount, flushPromises } from '@vue/test-utils'
import { NFormItem, NSelect } from 'naive-ui'
import { afterEach, expect, it, vi } from 'vitest'
import { useI18n } from 'vue-i18n'
import { i18n } from '../src/renderer/i18n'
import CompaniesView from '../src/renderer/views/CompaniesView.vue'
import { useManagementWorkspace } from '../src/renderer/composables/useManagementWorkspace'
import { useCompaniesStore } from '../src/renderer/stores/companies'
import type { Company, CompanyQuery, PageResult } from '../src/shared/types'

afterEach(() => vi.unstubAllGlobals())
const source = fs.readFileSync('src/renderer/views/WorkspaceView.vue', 'utf8')
const field = source.match(
  /<n-form-item :label="t\('management.companyNature'\)">[\s\S]*?<\/n-form-item>/,
)?.[0]
if (!field) throw new Error('Actual company nature editor not found')

it('uses the database options in real selects, saves/clears nature and ignores stale filtered pages', async () => {
  let resolveOld!: (value: PageResult<Company>) => void
  const row: Company = {
    id: 1,
    name: '测试公司',
    companyNature: 'private',
    industryIds: [],
    industryName: null,
    locations: [],
    careerUrl: null,
    lastReadAt: null,
    aliases: [],
    isBuiltin: false,
    isFavorite: false,
    createdAt: 1,
    updatedAt: 1,
  }
  const listNatures = vi.fn().mockResolvedValue([
    { code: 'private', name: '民营企业', sortOrder: 2 },
    { code: 'other', name: '其他', sortOrder: 6 },
  ])
  const search = vi.fn(
    (query: CompanyQuery): Promise<PageResult<Company>> =>
      query.companyNatures?.includes('other')
        ? new Promise((resolve) => {
            resolveOld = resolve
          })
        : Promise.resolve({ ...query, items: [row], total: 1 }),
  )
  const update = vi.fn().mockResolvedValue(row)
  vi.stubGlobal('zhijiApi', {
    companies: {
      list: vi.fn().mockResolvedValue([row]),
      listNatures,
      search,
      update,
      searchLocations: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    },
  })
  const pinia = createPinia()
  const store = useCompaniesStore(pinia)
  await store.load()
  let workspace!: ReturnType<typeof useManagementWorkspace>
  const Harness = defineComponent({
    components: { NFormItem, NSelect, CompaniesView },
    setup() {
      const { t } = useI18n()
      workspace = useManagementWorkspace({
        statuses: ref([]),
        industries: ref([]),
        resumes: ref([]),
        loadCompanies: store.load,
        loadOpportunities: async () => {},
        loadAllOpportunities: async () => {},
        loadCalendar: async () => {},
        showError: (error) => {
          throw error
        },
        notifySuccess: () => {},
        notifyError: () => {},
      })
      const companyNatureOptions = computed(() =>
        store.natures.map((item) => ({
          value: item.code,
          label: t(`management.companyNatureLabels.${item.code}`),
        })),
      )
      return { ...workspace, companyNatureOptions, t }
    },
    render: compile(`<div>${field}<CompaniesView
      :columns="[]" :data="managedCompanies" :loading="managedCompaniesLoading"
      :pagination="{page: managedCompanyPage, pageSize: 10}" :search="''"
      :selected-industry-id="null" :industry-options="[]" :selected-locations="[]"
      :location-options-revision="0" :nature-options="companyNatureOptions"
      :selected-natures="selectedCompanyNatures"
      @update:selected-natures="selectedCompanyNatures = $event"
    /></div>`),
  })
  const wrapper = mount(Harness, { global: { plugins: [pinia, i18n] }, attachTo: document.body })
  try {
    expect(listNatures).toHaveBeenCalledOnce()
    workspace.openCompanyEditor(row)
    await flushPromises()
    const editor = wrapper
      .findAllComponents(NSelect)
      .find((select) => select.classes().includes('company-nature-editor'))!
    expect(editor.props('options')).toEqual([
      { value: 'private', label: '民营企业' },
      { value: 'other', label: '其他' },
    ])
    expect(editor.props('value')).toBe('private')
    i18n.global.locale.value = 'en-US'
    await flushPromises()
    expect(editor.props('options')?.[0]).toEqual({ value: 'private', label: 'Private enterprise' })
    i18n.global.locale.value = 'zh-CN'
    await flushPromises()
    editor.vm.$emit('update:value', 'other')
    await workspace.saveCompany()
    expect(update).toHaveBeenLastCalledWith(1, expect.objectContaining({ companyNature: 'other' }))
    editor.vm.$emit('update:value', null)
    await workspace.saveCompany()
    expect(update).toHaveBeenLastCalledWith(1, expect.objectContaining({ companyNature: null }))
    const filter = wrapper
      .findAllComponents(NSelect)
      .find((select) => select.classes().includes('company-nature-filter'))!
    expect(filter.props('options')).toEqual(editor.props('options'))
    workspace.managedCompanyPage.value = 3
    filter.vm.$emit('update:value', ['other'])
    await flushPromises()
    expect(workspace.managedCompanyPage.value).toBe(1)
    filter.vm.$emit('update:value', ['private'])
    await flushPromises()
    expect(search).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 1, companyNatures: ['private'] }),
    )
    resolveOld({ page: 1, pageSize: 10, items: [], total: 0 })
    await flushPromises()
    expect(workspace.managedCompanies.value).toEqual([row])
    expect(workspace.selectedCompanyNatures.value).toEqual(['private'])
    filter.vm.$emit('update:value', [])
    await flushPromises()
    expect(search).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 1, companyNatures: [] }),
    )
    expect(workspace.selectedCompanyNatures.value).toEqual([])
    expect(workspace.companyForm.value.companyNature).toBeNull()
  } finally {
    wrapper.unmount()
    i18n.global.locale.value = 'zh-CN'
  }
})
