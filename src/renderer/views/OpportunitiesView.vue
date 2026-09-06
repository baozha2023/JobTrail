<script setup lang="ts">
import { NButton, NCard, NDataTable, NInput, NSelect, NSpace, type DataTableColumns, type PaginationProps, type SelectOption } from 'naive-ui'
import type { Opportunity } from '../../shared/types'

defineProps<{
  columns: DataTableColumns<Opportunity>
  data: Opportunity[]
  loading: boolean
  pagination: PaginationProps
  search: string
  selectedStatusId: number | null
  selectedCompanyId: number | null
  statusOptions: SelectOption[]
  companyOptions: SelectOption[]
  filterCompanyOption: (pattern: string, option: SelectOption) => boolean
}>()
const emit = defineEmits<{
  'update:search': [value: string]
  'update:selectedStatusId': [value: number | null]
  'update:selectedCompanyId': [value: number | null]
  refresh: []
}>()
</script>

<template>
  <section class="page-section">
    <n-card bordered class="toolbar-card">
      <n-space align="center" wrap>
        <n-input :value="search" clearable class="opportunity-search" :placeholder="$t('common.search')" @update:value="emit('update:search', $event)" />
        <n-select :value="selectedStatusId" clearable filterable class="opportunity-filter" :options="statusOptions" :placeholder="$t('opportunity.status')" @update:value="emit('update:selectedStatusId', $event as number | null)" />
        <n-select :value="selectedCompanyId" clearable filterable :filter="filterCompanyOption" class="opportunity-filter" :options="companyOptions" :placeholder="$t('opportunity.company')" @update:value="emit('update:selectedCompanyId', $event as number | null)" />
        <n-button quaternary @click="emit('refresh')">{{ $t('common.refresh') }}</n-button>
      </n-space>
    </n-card>
    <n-card bordered class="table-card">
      <n-data-table class="responsive-table" table-layout="fixed" paginate-single-page :columns="columns" :data="data" :loading="loading" :pagination="pagination">
        <template #empty>{{ $t('opportunity.empty') }}</template>
      </n-data-table>
    </n-card>
  </section>
</template>

