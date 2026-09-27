<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NCard, NModal, NSpace, NText } from 'naive-ui'

defineProps<{ currentVersion: string; targetVersion: string }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const installing = ref(false)
const failed = ref(false)

async function install(): Promise<void> {
  if (installing.value) return
  installing.value = true
  failed.value = false
  try {
    await window.velopackApi.downloadUpdates()
    await window.velopackApi.applyUpdates()
  } catch {
    failed.value = true
    installing.value = false
  }
}
</script>

<template>
  <n-modal :show="true" :mask-closable="false" :close-on-esc="false">
    <n-card
      class="app-update-modal"
      :title="t('settings.updateFound')"
      role="dialog"
      aria-modal="true"
      :aria-label="t('settings.updateFound')"
    >
      <div class="app-update-content">
        <n-text depth="3">{{ t('settings.updateAvailable') }}</n-text>
        <div class="app-update-versions">
          <n-card size="small" embedded>
            <n-text depth="3">{{ t('settings.version') }}</n-text>
            <strong class="app-update-version">{{ currentVersion }}</strong>
          </n-card>
          <n-card size="small" embedded>
            <n-text depth="3">{{ t('settings.updateTargetVersion') }}</n-text>
            <n-text class="app-update-version" type="success" strong>{{ targetVersion }}</n-text>
          </n-card>
        </div>
        <n-alert v-if="failed" type="error" :show-icon="false" role="alert">
          {{ t('settings.updateFailed') }}
        </n-alert>
        <n-text v-if="installing" depth="3" role="status">{{ t('settings.updating') }}</n-text>
      </div>
      <template #footer>
        <n-space justify="end">
          <n-button :disabled="installing" @click="emit('close')">{{
            t('common.cancel')
          }}</n-button>
          <n-button type="primary" :loading="installing" :disabled="installing" @click="install">
            {{ t(failed ? 'settings.updateRetry' : 'settings.updateInstall') }}
          </n-button>
        </n-space>
      </template>
    </n-card>
  </n-modal>
</template>

<style scoped>
.app-update-modal {
  width: min(520px, calc(100vw - 32px));
  border-radius: 14px;
}
.app-update-content {
  display: grid;
  gap: 20px;
  line-height: 1.7;
}
.app-update-versions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.app-update-version {
  display: block;
  margin-top: 6px;
  font-size: 24px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
</style>
