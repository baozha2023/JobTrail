import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { Industry } from '../../shared/types'

export const useIndustriesStore = defineStore('industries', () => {
  const items = ref<Industry[]>([])
  const load = async () => { items.value = await window.zhijiApi.industries.list() }
  return { items, load }
})

