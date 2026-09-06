import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { Status } from '../../shared/types'

export const useStatusesStore = defineStore('statuses', () => {
  const items = ref<Status[]>([])
  const load = async () => { items.value = await window.zhijiApi.statuses.list() }
  return { items, load }
})

