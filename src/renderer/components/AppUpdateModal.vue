<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NCard, NModal, NProgress, NSpace, NText } from 'naive-ui'
import type { AppUpdateProgress } from '../../shared/types'

let nextAttemptId = 0
// 0–12 rollback copy, 12–80 Velopack transfer/patch, 80–86 verification,
// 86–98 backup, 98–99 handoff. Installation finishes after this process exits.
const stageOrder = { preserve: 0, transfer: 1, verify: 2, backup: 3, handoff: 4 } as const
const stageStart = { preserve: 0, transfer: 12, verify: 80, backup: 86, handoff: 98 } as const
const simulatedLimit = { preserve: 11, verify: 85, backup: 97, handoff: 99 } as const
type Stage = AppUpdateProgress['stage']

defineProps<{ currentVersion: string; targetVersion: string }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const installing = ref(false)
const failed = ref(false)
const stage = ref<Stage | null>(null)
const transferMode = ref<'delta' | 'full'>('full')
const percentage = ref(0)
const stageLabel = computed(() =>
  stage.value === 'transfer'
    ? t(`settings.updatePhase.${transferMode.value}`)
    : stage.value
      ? t(`settings.updatePhase.${stage.value}`)
      : '',
)
let activeAttemptId = 0
let transferFloor = 12
let downloadReady = false
let simulationTimer: number | undefined
let removeProgressListener: (() => void) | undefined

function stopSimulation(): void {
  if (simulationTimer !== undefined) window.clearInterval(simulationTimer)
  simulationTimer = undefined
}

function simulate(stageName: Exclude<Stage, 'transfer'>): void {
  stopSimulation()
  const limit = simulatedLimit[stageName]
  simulationTimer = window.setInterval(() => {
    percentage.value = Math.min(limit, percentage.value + 1)
    if (percentage.value === limit) stopSimulation()
  }, 350)
}

function receiveProgress(progress: AppUpdateProgress): void {
  if (!installing.value || progress.attemptId !== activeAttemptId) return
  if (stage.value && stageOrder[progress.stage] < stageOrder[stage.value]) return
  const previousStage = stage.value
  stage.value = progress.stage
  if (progress.stage === 'transfer') {
    stopSimulation()
    if (previousStage !== 'transfer') transferFloor = stageStart.transfer
    if (transferMode.value === 'delta' && progress.mode === 'full' && previousStage === 'transfer')
      transferFloor = percentage.value
    transferMode.value = progress.mode ?? transferMode.value
    if (typeof progress.percentage === 'number' && Number.isFinite(progress.percentage)) {
      const actual = Math.max(0, Math.min(100, progress.percentage))
      percentage.value = Math.max(
        percentage.value,
        Math.min(
          stageStart.verify,
          Math.floor(transferFloor + ((80 - transferFloor) * actual) / 100),
        ),
      )
    }
    return
  }
  percentage.value = Math.max(percentage.value, stageStart[progress.stage])
  simulate(progress.stage)
}

onMounted(() => {
  removeProgressListener = window.velopackApi.onProgress(receiveProgress)
})
onBeforeUnmount(() => {
  stopSimulation()
  removeProgressListener?.()
})

async function install(): Promise<void> {
  if (installing.value) return
  const attemptId = ++nextAttemptId
  activeAttemptId = attemptId
  installing.value = true
  failed.value = false
  stage.value = null
  transferMode.value = 'full'
  percentage.value = 0
  receiveProgress({ attemptId, stage: downloadReady ? 'backup' : 'preserve' })
  try {
    if (!downloadReady) {
      await window.velopackApi.downloadUpdates(attemptId)
      downloadReady = true
    }
    await window.velopackApi.applyUpdates(attemptId)
    receiveProgress({ attemptId, stage: 'handoff' })
  } catch {
    stopSimulation()
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
        <div
          v-if="stage"
          class="app-update-progress"
          role="progressbar"
          :aria-label="t('settings.updateProgress')"
          :aria-valuenow="percentage"
          aria-valuemin="0"
          aria-valuemax="100"
        >
          <div class="app-update-progress-heading">
            <n-text depth="3" role="status">{{ stageLabel }}</n-text>
            <strong>{{ percentage }}%</strong>
          </div>
          <n-progress
            type="line"
            :percentage="percentage"
            :show-indicator="false"
            :status="failed ? 'error' : 'default'"
          />
        </div>
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
.app-update-progress {
  display: grid;
  gap: 10px;
}
.app-update-progress-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
}
.app-update-progress-heading strong {
  color: var(--n-text-color);
  font-variant-numeric: tabular-nums;
}
</style>
