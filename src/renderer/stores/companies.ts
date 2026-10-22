import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { CompanySummary, CompanyNatureOption } from '../../shared/types'

export const useCompaniesStore = defineStore('companies', () => {
  const items = ref<CompanySummary[]>([])
  const natures = ref<CompanyNatureOption[]>([])
  const load = async () => {
    const [companies, dictionary] = await Promise.all([
      window.zhijiApi.companies.list(),
      window.zhijiApi.companies.listNatures(),
    ])
    items.value = companies
    natures.value = dictionary
  }
  return { items, natures, load }
})
