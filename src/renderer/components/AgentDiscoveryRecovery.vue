<script setup lang="ts">
import { NAlert, NButton, NCard } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { AgentMessage } from '../../shared/types'
import { platformNames, type DiscoveryRecoveryTarget } from '../../shared/job-discovery'
import { useAgentDiscoveryRecovery } from '../composables/useAgentDiscoveryRecovery'
import DiscoveryLoginDialog from './DiscoveryLoginDialog.vue'
const props = defineProps<{
  messages: AgentMessage[]
  conversationId: string | null
  enabled: boolean
}>()
const emit = defineEmits<{ recovered: [target: DiscoveryRecoveryTarget] }>()
const {
  cards,
  error,
  recovery,
  accounts,
  loginPlatform,
  qrState,
  qrBusy,
  qrError,
  verificationState,
  verificationBusy,
  selectedAccount,
  open,
  close,
} = useAgentDiscoveryRecovery(props, (target) => emit('recovered', target))
const { t } = useI18n()
</script>

<template>
  <div v-if="cards.length || error" class="agent-discovery-recovery">
    <n-alert v-if="error" type="error">{{ error }}</n-alert>
    <n-card v-for="card in cards" :key="card.key" size="small" class="agent-discovery-card">
      <strong>{{ platformNames[card.platform] }} · {{ t('discovery.' + card.state) }}</strong>
      <p>
        {{
          t(
            card.state === 'challenge'
              ? 'agent.discoveryVerificationHint'
              : 'agent.discoveryLoginHint',
          )
        }}
      </p>
      <n-button
        type="warning"
        :loading="verificationBusy || verificationState?.phase === 'checking'"
        :disabled="
          accounts ||
          (!!verificationState &&
            (verificationState.phase === 'resuming' ||
              verificationState.platform !== card.platform ||
              verificationState.runId !== (card.runId ?? null)))
        "
        @click="open(card)"
      >
        {{ t(card.state === 'challenge' ? 'agent.discoveryVerify' : 'discovery.login') }}
      </n-button>
      <p v-if="verificationState?.platform === card.platform" role="status">
        {{
          t(
            'discovery.' +
              (verificationState.phase === 'resuming'
                ? 'verificationResuming'
                : verificationState.phase === 'checking'
                  ? 'verificationChecking'
                  : 'verificationHint'),
          )
        }}
      </p>
    </n-card>
  </div>
  <DiscoveryLoginDialog
    class="agent-discovery-login"
    :show="accounts"
    :platform="loginPlatform"
    :account="selectedAccount"
    :state="qrState"
    :busy="qrBusy"
    :error="qrError"
    @close="close"
    @login="recovery.login"
    @verify="recovery.verifyLogin"
  />
</template>

<style scoped>
.agent-discovery-recovery {
  display: grid;
  gap: 10px;
  align-self: flex-start;
  max-width: 100%;
}
.agent-discovery-card p {
  margin: 10px 0;
  line-height: 1.6;
}
</style>
