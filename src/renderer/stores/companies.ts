import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { CompanySummary, CompanyNatureOption } from '../../shared/types'

export const useCompaniesStore = defineStore('companies', () => {
  const items = ref<CompanySummary[]>([])
  const natures = ref<CompanyNatureOption[]>([])
  let loadSequence = 0
  const load = async () => {
    const sequence = ++loadSequence
    const [companies, dictionary] = await Promise.all([
      window.zhijiApi.companies.list(),
      window.zhijiApi.companies.listNatures(),
    ])
    if (sequence !== loadSequence) return
    items.value = companies
    natures.value = dictionary
  }
  return { items, natures, load }
})
