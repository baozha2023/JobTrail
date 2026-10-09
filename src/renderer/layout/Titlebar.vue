<script setup lang="ts">
defineProps<{
  title: string
  websiteUrl: string
  websiteLabel: string
  minimize: () => void
  maximize: () => void
  close: () => void
}>()
const emit = defineEmits<{ 'open-website': [] }>()
</script>

<template>
  <div class="window-titlebar">
    <a
      class="window-titlebar-brand"
      :href="websiteUrl"
      :title="websiteLabel"
      :aria-label="websiteLabel"
      @click.prevent="emit('open-website')"
    >
      <slot name="icon" /><span>{{ title }}</span>
    </a>
    <div class="window-controls">
      <button class="window-control" type="button" @click="minimize">−</button>
      <button class="window-control" type="button" @click="maximize">□</button>
      <button class="window-control close" type="button" @click="close">×</button>
    </div>
  </div>
</template>
