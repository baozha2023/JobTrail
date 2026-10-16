<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NCard, NModal, NSpin, NTag } from 'naive-ui'
import {
  platformNames,
  type JobPlatform,
  type PlatformStatus,
  type QrLoginMethod,
  type QrLoginState,
} from '../../shared/job-discovery'

defineOptions({ inheritAttrs: false })
const props = defineProps<{
  show: boolean
  accountManagement?: boolean
  accounts?: PlatformStatus[]
  tourActive?: boolean
  platform: JobPlatform | null
  account?: PlatformStatus
  state: QrLoginState | null
  busy: boolean
  error: string
}>()
const emit = defineEmits<{
  close: []
  afterEnter: []
  select: [platform: JobPlatform]
  forget: [platform: JobPlatform]
  login: [platform: JobPlatform, method?: QrLoginMethod]
  verify: [action: 'verify' | 'retry']
}>()
const { t, locale } = useI18n()
const label = (key: string) =>
  t('discovery.' + key, { platform: props.platform ? platformNames[props.platform] : '' })
</script>

<template>
  <n-modal
    :show="show"
    :mask-closable="false"
    :trap-focus="!tourActive"
    :auto-focus="!tourActive"
    :close-on-esc="!tourActive"
    :show-mask="!tourActive"
    @after-enter="emit('afterEnter')"
    @update:show="!$event && emit('close')"
  >
    <n-card
      v-bind="$attrs"
      class="discovery-login-dialog discovery-accounts"
      :class="{ 'discovery-source-login': !accountManagement }"
      :data-tour-owned-modal="tourActive ? '' : undefined"
      :title="label(accountManagement ? 'accounts' : 'qrPanelTitle')"
      closable
      @close="emit('close')"
    >
      <div class="discovery-account-layout">
        <div
          v-if="accountManagement"
          class="discovery-account-left"
          data-tour="discovery-account-list"
        >
          <ul class="discovery-account-list">
            <li
              v-for="item in accounts"
              :key="item.platform"
              class="discovery-account"
              :class="{ selected: platform === item.platform }"
            >
              <div class="discovery-account-info">
                <n-button
                  text
                  class="discovery-account-name"
                  :aria-pressed="platform === item.platform"
                  @click="emit('select', item.platform)"
                  >{{ platformNames[item.platform] }}</n-button
                >
              </div>
              <div class="discovery-account-actions">
                <n-tag
                  size="small"
                  :title="label(item.state)"
                  :type="
                    item.state === 'authenticated'
                      ? 'success'
                      : item.state === 'challenge'
                        ? 'warning'
                        : 'default'
                  "
                  >{{ label(item.state) }}</n-tag
                >
                <n-button
                  size="small"
                  :type="platform === item.platform ? 'primary' : 'default'"
                  @click="emit('select', item.platform)"
                  >{{
                    label(item.state === 'authenticated' ? 'accountDetails' : 'login')
                  }}</n-button
                >
                <n-button
                  size="small"
                  ghost
                  :type="platform === item.platform ? 'primary' : 'default'"
                  @click="emit('forget', item.platform)"
                  >{{ label('logout') }}</n-button
                >
              </div>
            </li>
          </ul>
          <p class="discovery-subtitle discovery-login-hint">{{ label('loginHint') }}</p>
        </div>
        <div class="discovery-qr-panel" data-tour="discovery-qr-panel" aria-live="polite">
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
            <p v-if="!accountManagement" class="discovery-subtitle">
              {{ label('sourceLoginHint') }}
            </p>
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
              <template
                v-if="!busy && state?.state === 'challenge' && state.verification?.available"
              >
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
                <n-button @click="emit('verify', 'retry')">{{
                  label('qrVerificationRetry')
                }}</n-button>
              </template>
              <p
                v-else-if="
                  state?.state === 'challenge' && state.verification?.error === 'unavailable'
                "
                class="discovery-subtitle"
              >
                {{ label('qrVerificationError_unavailable') }}
              </p>
              <n-button
                v-if="
                  !busy && state && !(state.state === 'challenge' && state.verification?.available)
                "
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
      </div>
      <template #footer>
        <div class="discovery-account-footer">
          <n-button @click="emit('close')">{{ label('close') }}</n-button>
        </div>
      </template>
    </n-card>
  </n-modal>
</template>

<style scoped>
.discovery-login-dialog {
  width: 70vw;
  height: 80vh;
  display: flex;
  flex-direction: column;
}
.discovery-login-dialog :deep(> .n-card-content) {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.discovery-login-dialog :deep(> .n-card-header),
.discovery-login-dialog :deep(> .n-card__footer) {
  flex-shrink: 0;
}
.discovery-account-footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
}
.discovery-account-layout {
  container-type: size;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 24px;
  flex: 1;
  min-height: 0;
}
.discovery-source-login {
  width: min(440px, 90vw);
  height: min(600px, 90vh);
}
.discovery-source-login .discovery-account-layout {
  grid-template-columns: minmax(0, 1fr);
}
.discovery-account-left {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: auto;
}
.discovery-account-list {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.discovery-account {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border: 1px solid #8883;
  border-radius: 10px;
  min-width: 0;
}
.discovery-account.selected {
  border-color: #18a058;
  background: #18a0580b;
}
.discovery-account-info {
  min-width: 0;
}
.discovery-account-name {
  max-width: 100%;
  font-size: 14px;
  font-weight: 650;
  text-align: left;
}
.discovery-account-name :deep(.n-button__content) {
  white-space: normal;
}
.discovery-account :deep(.n-tag) {
  max-width: 100%;
  justify-self: end;
}
.discovery-account :deep(.n-tag__content) {
  overflow: hidden;
  text-overflow: ellipsis;
}
.discovery-account-actions {
  display: grid;
  grid-template-columns: auto repeat(2, minmax(0, 1fr));
  align-items: center;
  gap: 6px;
}
.discovery-account-actions :deep(.n-button) {
  padding: 0 8px;
  font-size: 12px;
}
@container (max-width: 620px) {
  .discovery-account-actions {
    grid-template-columns: auto minmax(0, 1fr);
  }
  .discovery-account-actions :deep(.n-tag) {
    grid-row: 1 / 3;
  }
  .discovery-account-actions :deep(.n-button) {
    grid-column: 2;
  }
}
.discovery-login-hint {
  line-height: 1.7;
  margin: 12px 0 0;
}
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
.discovery-source-login .discovery-qr-image {
  width: min(220px, 100%, max(96px, calc(100cqh - 220px)));
}
.discovery-login-success {
  font-size: 42px;
  color: #18a058;
}
@media (max-width: 1000px) {
  .discovery-login-dialog :deep(> .n-card-content),
  .discovery-login-dialog :deep(> .n-card__footer) {
    padding-left: 14px;
    padding-right: 14px;
  }
  .discovery-account-layout {
    gap: 10px;
  }
  .discovery-account {
    padding: 10px 8px;
    gap: 8px;
  }
  .discovery-qr-panel {
    --qr-padding: 12px;
    gap: 10px;
  }
}
</style>
