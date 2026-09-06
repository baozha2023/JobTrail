import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { AppConfig } from '../../shared/types'

export const useSettingsStore = defineStore('settings', () => {
  const config = ref<AppConfig | null>(null)
  const load = async () => { config.value = await window.zhijiApi.config.get() }
  const update = async (input: Partial<AppConfig>) => { config.value = await window.zhijiApi.config.update(input) }
  return { config, load, update }
})

