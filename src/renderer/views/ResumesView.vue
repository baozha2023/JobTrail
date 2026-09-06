<script setup lang="ts">
import { NCard, NDataTable, type DataTableColumns, type PaginationProps } from 'naive-ui'
import type { ResumeVersion } from '../../shared/types'
defineProps<{ columns: DataTableColumns<ResumeVersion>; data: ResumeVersion[]; pagination: PaginationProps }>()
</script>
<template><section class="page-section management-page"><n-card bordered class="table-card"><n-data-table class="responsive-table" table-layout="fixed" paginate-single-page :columns="columns" :data="data" :pagination="pagination"><template #empty>{{ $t('management.resumeEmpty') }}</template>
  </n-data-table></n-card></section></template>

