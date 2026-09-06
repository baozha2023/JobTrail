<script setup lang="ts">
defineProps<{ title: string; minimize: () => void; maximize: () => void; close: () => void }>()
</script>

<template>
  <div class="window-titlebar">
    <div class="window-titlebar-brand"><slot name="icon" /><span>{{ title }}</span></div>
    <div class="window-controls">
      <button class="window-control" type="button" @click="minimize">−</button>
      <button class="window-control" type="button" @click="maximize">□</button>
      <button class="window-control close" type="button" @click="close">×</button>
    </div>
  </div>
</template>

