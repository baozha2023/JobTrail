<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NCard, NModal, NSpin, NText } from 'naive-ui'
import type { BackupImportConfirmation } from '../../shared/types'

const props = defineProps<{
  confirmation: BackupImportConfirmation
  currentVersion: string
  deciding: boolean
  restoring: boolean
}>()
const emit = defineEmits<{ confirm: []; cancel: [] }>()
const { t, locale } = useI18n()
const createdAt = computed(() =>
  new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(props.confirmation.createdAt),
  ),
)
const locked = computed(() => props.deciding || props.restoring)
</script>

<template>
  <n-modal :show="true" :mask-closable="false" :close-on-esc="false">
    <n-card
      class="backup-import-modal"
      :title="t('settings.backupConfirmTitle')"
      role="dialog"
      aria-modal="true"
      :aria-label="t('settings.backupConfirmTitle')"
    >
      <div class="backup-import-content">
        <n-text depth="3">{{ t('settings.backupConfirmDescription') }}</n-text>
        <div class="backup-import-versions">
          <n-card size="small" embedded>
            <n-text depth="3">{{ t('settings.version') }}</n-text>
            <strong class="backup-import-version">{{ currentVersion }}</strong>
          </n-card>
          <n-card size="small" embedded>
            <n-text depth="3">{{ t('settings.backupSourceVersion') }}</n-text>
            <strong class="backup-import-version">{{ confirmation.appVersion }}</strong>
          </n-card>
        </div>
        <div class="backup-import-date">
          <n-text depth="3">{{ t('settings.backupCreatedAt') }}</n-text>
          <time :datetime="confirmation.createdAt">{{ createdAt }}</time>
        </div>
        <n-alert type="warning" :title="t('settings.backupReplaceTitle')">
          {{ t('settings.backupReplaceDescription') }}
        </n-alert>
        <n-text v-if="!restoring" depth="3">{{ t('settings.backupKeepCurrent') }}</n-text>
        <div v-else class="backup-import-status" role="status">
          <n-spin size="small" />
          <n-text depth="3">{{ t('settings.backupRestoring') }}</n-text>
        </div>
      </div>
      <template #footer>
        <div class="backup-import-actions">
          <n-button :disabled="locked" @click="emit('cancel')">{{ t('common.cancel') }}</n-button>
          <n-button type="error" :loading="restoring" :disabled="locked" @click="emit('confirm')">
            {{ t('settings.backupReplaceConfirm') }}
          </n-button>
        </div>
      </template>
    </n-card>
  </n-modal>
</template>

<style scoped>
.backup-import-modal {
  width: min(560px, calc(100vw - 32px));
  max-height: calc(100vh - 32px);
  border-radius: 14px;
}
.backup-import-modal > :deep(.n-card-content) {
  min-height: 0;
  overflow-y: auto;
}
.backup-import-modal > :deep(.n-card-header),
.backup-import-modal > :deep(.n-card__footer) {
  flex-shrink: 0;
}
.backup-import-content {
  display: grid;
  gap: 20px;
  line-height: 1.7;
}
.backup-import-versions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.backup-import-version {
  display: block;
  margin-top: 6px;
  font-size: 24px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.backup-import-date,
.backup-import-status,
.backup-import-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}
.backup-import-date {
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 4px 16px;
}
.backup-import-date time {
  font-variant-numeric: tabular-nums;
}
.backup-import-actions {
  justify-content: flex-end;
  flex-wrap: wrap;
}
</style>
