<script setup lang="ts">
import { NCard, NDataTable, type DataTableColumns, type PaginationProps } from 'naive-ui'
import type { Industry } from '../../shared/types'
defineProps<{ columns: DataTableColumns<Industry>; data: Industry[]; pagination: PaginationProps }>()
</script>
<template><section class="page-section management-page"><n-card bordered class="table-card"><n-data-table class="responsive-table" table-layout="fixed" paginate-single-page :columns="columns" :data="data" :pagination="pagination"><template #empty>{{ $t('management.industryEmpty') }}</template>
  </n-data-table></n-card></section></template>

