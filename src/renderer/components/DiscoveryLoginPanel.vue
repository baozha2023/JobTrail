<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NSpin } from 'naive-ui'
import {
  platformNames,
  type JobPlatform,
  type PlatformStatus,
  type QrLoginMethod,
  type QrLoginState,
} from '../../shared/job-discovery'

const props = defineProps<{
  platform: JobPlatform | null
  account?: PlatformStatus
  state: QrLoginState | null
  busy: boolean
  error: string
  hint?: string
}>()
const emit = defineEmits<{
  login: [platform: JobPlatform, method?: QrLoginMethod]
  verify: [action: 'verify' | 'retry']
}>()
const { t, locale } = useI18n()
const label = (key: string) =>
  t('discovery.' + key, { platform: props.platform ? platformNames[props.platform] : '' })
</script>

<template>
  <div class="discovery-qr-panel" aria-live="polite">
    <template v-if="platform">
      <strong class="discovery-qr-title">{{ platformNames[platform] }}</strong>
      <div
        v-if="state && state.methods.length > 1 && state.state !== 'authenticated'"
        class="discovery-qr-methods"
      >
        <n-button
          v-for="method in state.methods"
          :key="method.id"
          size="small"
          :type="state.method === method.id ? 'primary' : 'default'"
          :disabled="busy"
          @click="emit('login', platform, method.id)"
          >{{ method.label[locale === 'en-US' ? 'en-US' : 'zh-CN'] }}</n-button
        >
      </div>
      <p v-if="hint" class="discovery-subtitle">{{ hint }}</p>
      <n-alert v-if="error" type="error">{{ error }}</n-alert>
      <n-spin v-if="busy" size="large" />
      <img
        v-if="state?.image"
        :src="state.image"
        :alt="label('qrAlt')"
        class="discovery-qr-image"
      />
      <template
        v-if="
          !busy &&
          (state?.state === 'authenticated' || (!state && account?.state === 'authenticated'))
        "
      >
        <span class="discovery-login-success" aria-hidden="true">✓</span>
        <strong>{{ label('authenticated') }}</strong>
        <p v-if="account?.checkedAt" class="discovery-subtitle">
          {{ label('lastConfirmed') }} {{ new Date(account.checkedAt).toLocaleString() }}
        </p>
      </template>
      <template v-else>
        <p>{{ busy ? label('qrLoading') : state ? label('qr_' + state.state) : '' }}</p>
        <p
          v-if="state?.state === 'waiting' || state?.state === 'scanned'"
          class="discovery-subtitle"
        >
          {{ state.scanHint[locale === 'en-US' ? 'en-US' : 'zh-CN'] }}
        </p>
        <p v-if="state?.reason" class="discovery-subtitle">
          {{ label('qrReason_' + state.reason) }}
        </p>
        <template v-if="!busy && state?.state === 'challenge' && state.verification?.available">
          <p class="discovery-subtitle">{{ label('qrVerificationHint') }}</p>
          <p v-if="state.verification.window !== 'closed'" class="discovery-subtitle">
            {{ label('qrWindow_' + state.verification.window) }}
          </p>
          <n-alert v-if="state.verification.error" type="warning">{{
            label('qrVerificationError_' + state.verification.error)
          }}</n-alert>
          <n-button
            type="primary"
            :loading="state.verification.window === 'loading'"
            @click="emit('verify', 'verify')"
            >{{ label('qrVerify') }}</n-button
          >
          <n-button @click="emit('verify', 'retry')">{{ label('qrVerificationRetry') }}</n-button>
        </template>
        <p
          v-else-if="state?.state === 'challenge' && state.verification?.error === 'unavailable'"
          class="discovery-subtitle"
        >
          {{ label('qrVerificationError_unavailable') }}
        </p>
        <n-button
          v-if="!busy && state && !(state.state === 'challenge' && state.verification?.available)"
          @click="emit('login', platform, state.method)"
          >{{ label('qrRefresh') }}</n-button
        >
      </template>
    </template>
    <template v-else>
      <strong>{{ label('qrPanelTitle') }}</strong>
      <p class="discovery-subtitle">{{ label('qrChoose') }}</p>
    </template>
  </div>
</template>

<style scoped>
.discovery-qr-panel {
  --qr-padding: 24px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  gap: 16px;
  padding: var(--qr-padding);
  border: 1px dashed #8884;
  border-radius: 12px;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  text-align: center;
}
.discovery-qr-panel > * {
  flex-shrink: 0;
}
/* Auto margins center short content without pushing overflow above the scroll origin. */
.discovery-qr-panel > :first-child {
  margin-top: auto;
}
.discovery-qr-panel > :last-child {
  margin-bottom: auto;
}
.discovery-qr-panel p {
  margin: 0;
  line-height: 1.7;
}
.discovery-subtitle {
  font-size: 12px;
  opacity: 0.65;
}
.discovery-qr-title {
  font-size: 18px;
}
.discovery-qr-image {
  width: min(240px, 100%, calc(100cqh - 2 * var(--qr-padding) - 2px));
  box-sizing: border-box;
  aspect-ratio: 1;
  object-fit: contain;
  background: white;
  padding: 10px;
  border-radius: 8px;
}
.discovery-login-success {
  font-size: 42px;
  color: #18a058;
}
@media (max-width: 1000px) {
  .discovery-qr-panel {
    --qr-padding: 12px;
    gap: 10px;
  }
}
</style>
