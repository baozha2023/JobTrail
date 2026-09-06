<script setup lang="ts">
import { NLayoutSider, NMenu, type MenuOption } from 'naive-ui'

defineProps<{ options: MenuOption[]; value: string; width: number }>()
const emit = defineEmits<{ 'update:value': [value: string] }>()
</script>

<template>
  <n-layout-sider bordered :width="width" class="sidebar">
    <slot name="brand" />
    <n-menu :value="value" :options="options" @update:value="(next: string) => emit('update:value', next)" />
  </n-layout-sider>
</template>
