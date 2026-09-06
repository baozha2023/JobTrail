<script setup lang="ts">
import { NCard, NDataTable, type DataTableColumns, type PaginationProps } from 'naive-ui'
import type { Status } from '../../shared/types'
defineProps<{ columns: DataTableColumns<Status>; data: Status[]; pagination: PaginationProps }>()
</script>
<template><section class="page-section management-page"><n-card bordered class="table-card"><n-data-table class="responsive-table" table-layout="fixed" paginate-single-page :columns="columns" :data="data" :pagination="pagination"><template #empty>{{ $t('management.statusEmpty') }}</template>
  </n-data-table></n-card></section></template>
