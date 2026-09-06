import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { Company } from '../../shared/types'

export const useCompaniesStore = defineStore('companies', () => {
  const items = ref<Company[]>([])
  const load = async (keyword = '') => {
    items.value = keyword.trim() ? await window.zhijiApi.companies.search(keyword) : await window.zhijiApi.companies.list()
  }
  return { items, load }
})
