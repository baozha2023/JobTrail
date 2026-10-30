import { computed, ref, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { SelectOption } from 'naive-ui'
import type { CompanySummary, CreateOpportunityInput } from '../../shared/types'

interface OpportunityCompanyPickerOptions {
  companies: Ref<CompanySummary[]>
  opportunityForm: Ref<CreateOpportunityInput>
  showOpportunityModal: Ref<boolean>
  loadCompanies: () => Promise<void>
  loadManagedCompanies: () => Promise<void>
  notifySuccess: (text: string) => void
  showError: (error: unknown) => void
}

export function useOpportunityCompanyPicker(options: OpportunityCompanyPickerOptions) {
  const { t } = useI18n()
  const companySearch = ref('')
  const creatingCompany = ref(false)
  const createCompanyValue = '__create_company__'
  const companyOptions = computed(() =>
    options.companies.value.map((item) => ({
      label: item.name,
      value: item.id,
      searchTexts: [item.name, ...item.aliases].map((text) => text.toLocaleLowerCase()),
    })),
  )
  const opportunityCompanyOptions = computed<SelectOption[]>(() => {
    const name = companySearch.value.trim()
    if (!name || options.companies.value.some((company) => company.name === name))
      return companyOptions.value
    // Keep existing matches ahead of the write action so Enter selects a match.
    return [
      ...companyOptions.value,
      {
        label: t('opportunity.createCompany', { name }),
        value: createCompanyValue,
        createName: name,
      },
    ]
  })

  function filterCompanyOption(pattern: string, option: SelectOption): boolean {
    const keyword = pattern.trim().toLocaleLowerCase()
    if (!keyword) return true
    if (option.value === createCompanyValue) return true
    return (
      Array.isArray(option.searchTexts) &&
      option.searchTexts.some((value: string) => value.includes(keyword))
    )
  }

  async function selectOpportunityCompany(
    value: number | string,
    option: SelectOption,
  ): Promise<void> {
    if (typeof value === 'number') {
      options.opportunityForm.value.companyId = value
      companySearch.value = ''
      return
    }
    if (
      value !== createCompanyValue ||
      typeof option.createName !== 'string' ||
      creatingCompany.value
    )
      return
    const form = options.opportunityForm.value
    creatingCompany.value = true
    try {
      const company = await window.zhijiApi.companies.create({ name: option.createName })
      // Creation has committed. Keep its summary and selection even if a later
      // refresh fails; full company details must not enter the summary store.
      const { locations: _locations, ...summary } = company
      if (!options.companies.value.some((item) => item.id === summary.id))
        options.companies.value = [...options.companies.value, summary]
      if (options.showOpportunityModal.value && options.opportunityForm.value === form)
        form.companyId = company.id
      companySearch.value = ''
      options.notifySuccess(t('feedback.addSuccess'))
      await Promise.all([
        options.loadCompanies().catch(options.showError),
        options.loadManagedCompanies().catch(options.showError),
      ])
    } catch (error) {
      options.showError(error)
    } finally {
      creatingCompany.value = false
    }
  }

  return {
    companyOptions,
    companySearch,
    creatingCompany,
    opportunityCompanyOptions,
    filterCompanyOption,
    selectOpportunityCompany,
  }
}
