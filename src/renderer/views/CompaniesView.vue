<script setup lang="ts">
import {
  NCard,
  NDataTable,
  NInput,
  NSelect,
  NSpace,
  type DataTableColumns,
  type PaginationProps,
  type SelectOption,
} from 'naive-ui'
import type { Company } from '../../shared/types'
defineProps<{
  columns: DataTableColumns<Company>
  data: Company[]
  pagination: PaginationProps
  search: string
  selectedIndustryId: number | null
  industryOptions: SelectOption[]
}>()
const emit = defineEmits<{
  'update:search': [value: string]
  'update:selectedIndustryId': [value: number | null]
}>()
</script>
<template>
  <section class="page-section management-page">
    <n-card bordered class="toolbar-card">
      <n-space align="center" wrap>
        <n-input
          :value="search"
          clearable
          class="company-search"
          :placeholder="$t('management.companySearch')"
          @update:value="emit('update:search', $event)"
        />
        <n-select
          :value="selectedIndustryId"
          clearable
          filterable
          class="company-industry-filter"
          :options="industryOptions"
          :placeholder="$t('management.companyIndustryFilterPlaceholder')"
          @update:value="emit('update:selectedIndustryId', $event as number | null)"
        />
      </n-space>
    </n-card>
    <n-card bordered class="table-card"
      ><n-data-table
        class="responsive-table"
        table-layout="fixed"
        paginate-single-page
        :columns="columns"
        :data="data"
        :pagination="pagination"
        ><template #empty>{{ $t('management.companyEmpty') }}</template>
      </n-data-table></n-card
    >
  </section>
</template>
