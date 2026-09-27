<script setup lang="ts">
import { NCard, NDataTable, type DataTableColumns } from 'naive-ui'
import type { Industry } from '../../shared/types'
defineProps<{
  columns: DataTableColumns<Industry>
  data: Industry[]
}>()
</script>
<template>
  <section class="page-section management-page">
    <n-card bordered class="table-card"
      ><n-data-table
        class="responsive-table"
        table-layout="fixed"
        :columns="columns"
        :data="data"
        :row-key="(row: Industry) => row.id"
        ><template #empty>{{ $t('management.industryEmpty') }}</template>
      </n-data-table></n-card
    >
  </section>
</template>
