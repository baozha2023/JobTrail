import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { CompanySummary } from '../../shared/types'

export const useCompaniesStore = defineStore('companies', () => {
  const items = ref<CompanySummary[]>([])
  const load = async () => {
    items.value = await window.zhijiApi.companies.list()
  }
  return { items, load }
})
