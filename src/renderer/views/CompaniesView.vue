<script setup lang="ts">
import { h } from 'vue'
import {
  NCard,
  NDataTable,
  NInput,
  NSelect,
  NCascader,
  NSpace,
  type DataTableColumns,
  type PaginationProps,
  type CascaderOption,
} from 'naive-ui'
import type { Company, CompanyNature } from '../../shared/types'
import CompanyLocationSelect from '../components/CompanyLocationSelect.vue'
defineProps<{
  selectedNatures: CompanyNature[]
  natureOptions: Array<{ value: CompanyNature; label: string }>
  columns: DataTableColumns<Company>
  data: Company[]
  loading: boolean
  pagination: PaginationProps
  search: string
  selectedIndustryId: number | null
  industryOptions: CascaderOption[]
  selectedLocations: string[]
  locationOptionsRevision: number
}>()
const emit = defineEmits<{
  'update:selectedNatures': [value: CompanyNature[]]
  'update:search': [value: string]
  'update:selectedIndustryId': [value: number | null]
  'update:selectedLocations': [value: string[]]
}>()

const industryFilterMenuProps = { class: 'company-industry-filter-menu' }
const renderIndustryFilterPrefix = () => null
function renderIndustryFilterLabel(option: CascaderOption) {
  if (!option.children) return option.label
  return h(
    'span',
    { onClick: () => emit('update:selectedIndustryId', option.value as number) },
    option.label,
  )
}
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
        <n-cascader
          :value="selectedIndustryId"
          check-strategy="all"
          :show-path="false"
          :render-prefix="renderIndustryFilterPrefix"
          :render-label="renderIndustryFilterLabel"
          :menu-props="industryFilterMenuProps"
          clearable
          filterable
          class="company-industry-filter"
          :options="industryOptions"
          :placeholder="$t('management.companyIndustryFilterPlaceholder')"
          @update:value="emit('update:selectedIndustryId', $event as number | null)"
        />
        <n-select
          class="company-nature-filter"
          style="min-width: 220px"
          multiple
          clearable
          filterable
          max-tag-count="responsive"
          :value="selectedNatures"
          :options="natureOptions"
          :placeholder="$t('management.companyNatureFilter')"
          @update:value="emit('update:selectedNatures', $event as CompanyNature[])"
        />
        <company-location-select
          :value="selectedLocations"
          :revision="locationOptionsRevision"
          @update:value="emit('update:selectedLocations', $event)"
        />
      </n-space>
    </n-card>
    <n-card bordered class="table-card"
      ><n-data-table
        class="responsive-table"
        table-layout="fixed"
        :scroll-x="1290"
        remote
        paginate-single-page
        :columns="columns"
        :data="data"
        :loading="loading"
        :pagination="pagination"
        ><template #empty>{{ $t('management.companyEmpty') }}</template>
      </n-data-table></n-card
    >
  </section>
</template>
