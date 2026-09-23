import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { Company } from '../../shared/types'

export const useCompaniesStore = defineStore('companies', () => {
  const items = ref<Company[]>([])
  const load = async () => {
    items.value = await window.zhijiApi.companies.list()
  }
  return { items, load }
})
