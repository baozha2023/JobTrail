import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { Opportunity, OpportunityQuery } from '../../shared/types'

export const useOpportunitiesStore = defineStore('opportunities', () => {
  const items = ref<Opportunity[]>([])
  const allItems = ref<Opportunity[]>([])
  const loading = ref(false)
  let sequence = 0
  let allSequence = 0
  async function load(query: OpportunityQuery): Promise<void> {
    const current = ++sequence
    loading.value = true
    try {
      const result = await window.zhijiApi.opportunities.list(query)
      if (current === sequence) items.value = result
    } finally {
      if (current === sequence) loading.value = false
    }
  }
  async function loadAll(): Promise<void> {
    const current = ++allSequence
    const result = await window.zhijiApi.opportunities.list({})
    if (current === allSequence) allItems.value = result
  }
  return { items, allItems, loading, load, loadAll }
})
