<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NCard, NModal, NProgress, NSpace, NText } from 'naive-ui'
import type { AppUpdateProgress } from '../../shared/types'

let nextAttemptId = 0
const TICK_MS = 16
const SIMULATION_MS = 350
const phaseRange = {
  preserve: [0, 11],
  delta: [12, 49],
  skipDelta: [12, 49],
  full: [50, 79],
  skipFull: [50, 79],
  verify: [80, 85],
  backup: [86, 97],
  handoff: [98, 100],
} as const
type Phase = keyof typeof phaseRange
const phaseOrder: Record<Phase, number> = {
  preserve: 0,
  delta: 1,
  skipDelta: 1,
  full: 2,
  skipFull: 2,
  verify: 3,
  backup: 4,
  handoff: 5,
}

defineProps<{ currentVersion: string; targetVersion: string }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const installing = ref(false)
const failed = ref(false)
const stage = ref<Phase | null>(null)
const percentage = ref(0)
const stageLabel = computed(() => (stage.value ? t(`settings.updatePhase.${stage.value}`) : ''))
let activeAttemptId = 0
let downloadReady = false
let animationTimer: number | undefined
let lastSimulationTick = 0
let deltaTarget = 12
let fullTarget = 50
let verifyComplete = false
let handoffComplete = false
let phaseQueue: Phase[] = []
const progressWaiters: { value: number; resolve: () => void }[] = []
let removeProgressListener: (() => void) | undefined

function stopAnimation(): void {
  if (animationTimer !== undefined) window.clearInterval(animationTimer)
  animationTimer = undefined
}

function notifyProgress(): void {
  for (let index = progressWaiters.length - 1; index >= 0; index--) {
    const waiter = progressWaiters[index]
    if (percentage.value >= waiter.value) {
      progressWaiters.splice(index, 1)
      waiter.resolve()
    }
  }
}

function waitForProgress(value: number): Promise<void> {
  if (percentage.value >= value) return Promise.resolve()
  return new Promise((resolve) => progressWaiters.push({ value, resolve }))
}

function animate(): void {
  const current = stage.value
  if (!current) return
  if (phaseQueue.length > 0) {
    if (percentage.value < phaseRange[current][1]) {
      percentage.value++
    } else {
      stage.value = phaseQueue.shift()!
      if (percentage.value < phaseRange[stage.value][0]) percentage.value++
      lastSimulationTick = Date.now()
    }
    notifyProgress()
    return
  }
  const target =
    current === 'delta'
      ? deltaTarget
      : current === 'full'
        ? fullTarget
        : current === 'verify' && verifyComplete
          ? 85
          : current === 'handoff' && handoffComplete
            ? 100
            : percentage.value
  if (percentage.value < target) {
    percentage.value++
  } else if (
    current !== 'full' &&
    current !== 'skipDelta' &&
    current !== 'skipFull' &&
    percentage.value <
      (current === 'delta' ? 48 : current === 'handoff' ? 99 : phaseRange[current][1]) &&
    Date.now() - lastSimulationTick >= SIMULATION_MS
  ) {
    percentage.value++
    lastSimulationTick = Date.now()
  }
  notifyProgress()
}

function queuePhase(next: Phase): boolean {
  const latest = phaseQueue.at(-1) ?? stage.value
  if (!latest || phaseOrder[next] < phaseOrder[latest]) return false
  if (phaseOrder[next] === phaseOrder[latest]) return next === latest
  if (latest === 'preserve' && next === 'full') phaseQueue.push('skipDelta')
  if (latest === 'preserve' && next === 'verify') phaseQueue.push('skipDelta', 'skipFull')
  if (latest === 'delta' && next === 'verify') phaseQueue.push('skipFull')
  phaseQueue.push(next)
  return true
}

function receiveProgress(progress: AppUpdateProgress): void {
  if (!installing.value || progress.attemptId !== activeAttemptId) return
  const next = progress.stage === 'transfer' ? progress.mode : progress.stage
  if (!next || !queuePhase(next)) return
  if (progress.stage === 'transfer' && Number.isFinite(progress.percentage)) {
    const actual = Math.max(0, Math.min(100, progress.percentage!))
    if (next === 'delta') deltaTarget = Math.max(deltaTarget, 12 + Math.floor((36 * actual) / 100))
    else fullTarget = Math.max(fullTarget, 50 + Math.floor((29 * actual) / 100))
  }
}

onMounted(() => {
  removeProgressListener = window.velopackApi.onProgress(receiveProgress)
})
onBeforeUnmount(() => {
  stopAnimation()
  removeProgressListener?.()
})

async function install(): Promise<void> {
  if (installing.value) return
  const attemptId = ++nextAttemptId
  activeAttemptId = attemptId
  installing.value = true
  failed.value = false
  stage.value = downloadReady ? 'backup' : 'preserve'
  percentage.value = downloadReady ? 86 : 0
  phaseQueue = []
  deltaTarget = 12
  fullTarget = 50
  verifyComplete = false
  handoffComplete = false
  lastSimulationTick = Date.now()
  stopAnimation()
  animationTimer = window.setInterval(animate, TICK_MS)
  try {
    if (!downloadReady) {
      await window.velopackApi.downloadUpdates(attemptId)
      downloadReady = true
      queuePhase('verify')
      verifyComplete = true
      await waitForProgress(85)
    }
    await window.velopackApi.applyUpdates(attemptId)
    queuePhase('backup')
    queuePhase('handoff')
    handoffComplete = true
    await waitForProgress(100)
  } catch {
    stopAnimation()
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
          <div
            class="app-update-progress-rail"
            :class="{ 'is-running': installing && percentage < 100 }"
          >
            <n-progress
              type="line"
              :percentage="percentage"
              :show-indicator="false"
              :status="failed ? 'error' : 'default'"
            />
          </div>
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
.app-update-progress-rail {
  position: relative;
  overflow: hidden;
}
.app-update-progress-rail.is-running::after {
  position: absolute;
  inset: 0 auto 0 -30%;
  width: 30%;
  content: '';
  pointer-events: none;
  background: linear-gradient(90deg, transparent, rgb(255 255 255 / 35%), transparent);
  animation: update-progress-sweep 1.2s linear infinite;
}
@keyframes update-progress-sweep {
  to {
    left: 100%;
  }
}
@media (prefers-reduced-motion: reduce) {
  .app-update-progress-rail.is-running::after {
    animation: none;
  }
}
</style>
