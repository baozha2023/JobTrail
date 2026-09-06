<script setup lang="ts">
import { NCard, NDataTable, NInput, type DataTableColumns, type PaginationProps } from 'naive-ui'
import type { Company } from '../../shared/types'
defineProps<{ columns: DataTableColumns<Company>; data: Company[]; pagination: PaginationProps; search: string }>()
const emit = defineEmits<{ 'update:search': [value: string] }>()
</script>
<template><section class="page-section management-page"><n-card bordered class="toolbar-card"><n-input :value="search" clearable :placeholder="$t('management.companySearch')" @update:value="emit('update:search', $event)" /></n-card><n-card bordered class="table-card"><n-data-table class="responsive-table" table-layout="fixed" paginate-single-page :columns="columns" :data="data" :pagination="pagination"><template #empty>{{ $t('management.companyEmpty') }}</template>
  </n-data-table></n-card></section></template>

