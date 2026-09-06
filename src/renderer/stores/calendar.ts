import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { CalendarEvent, CalendarRange } from '../../shared/types'

export const useCalendarStore = defineStore('calendar', () => {
  const items = ref<CalendarEvent[]>([])
  const loading = ref(false)
  let sequence = 0
  async function load(range: CalendarRange): Promise<void> {
    const current = ++sequence
    loading.value = true
    try {
      const result = await window.zhijiApi.calendar.list(range)
      if (current === sequence) items.value = result
    } finally {
      if (current === sequence) loading.value = false
    }
  }
  return { items, loading, load }
})

