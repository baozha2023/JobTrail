import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ResumeVersion } from '../../shared/types'

export const useResumesStore = defineStore('resumes', () => {
  const items = ref<ResumeVersion[]>([])
  const load = async () => { items.value = await window.zhijiApi.resumes.list() }
  return { items, load }
})

