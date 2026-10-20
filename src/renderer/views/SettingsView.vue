<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  NButton,
  NCard,
  NInput,
  NInputNumber,
  NModal,
  NPopconfirm,
  NProgress,
  NRadioButton,
  NRadioGroup,
  NSelect,
  NSpace,
  NSwitch,
  NTabPane,
  NTabs,
} from 'naive-ui'
import type {
  AppConfig,
  AppConfigUpdate,
  CloseBehavior,
  CompanyCatalogPhase,
  CompanyCatalogStatus,
  CompanyCatalogUpdateResult,
  McpConnectionInfo,
  TourId,
} from '../../shared/types'

const props = defineProps<{
  config: AppConfig | null
  dark: boolean
  mcpConnectionInfo: McpConnectionInfo | null
  currentVersion: string
  checkingForUpdates: boolean
  uninstalling: boolean
  checkForUpdates: () => void
  uninstallApp: () => void
  catalogStatus: CompanyCatalogStatus | null
  catalogModalVisible: boolean
  catalogUpdating: boolean
  catalogPhase: CompanyCatalogPhase
  catalogProgress: number
  catalogResult: CompanyCatalogUpdateResult | null
  catalogError: string
  updateCompanyCatalog: () => void
  closeCatalogModal: () => void
  backupBusy: boolean
  backupStatus: string
  backupAction: (kind: 'export' | 'import') => Promise<void>
}>()
const emit = defineEmits<{
  restartTour: [id: TourId]
  updateConfig: [input: AppConfigUpdate]
  aiSaved: [config: AppConfig]
  error: [error: unknown]
  closeBehavior: [value: CloseBehavior]
  launchAtStartup: [value: boolean]
}>()

const diagnosticBusy = ref(false)
const diagnosticExported = ref(false)
async function diagnosticAction(kind: 'open' | 'export') {
  if (diagnosticBusy.value) return
  diagnosticBusy.value = true
  diagnosticExported.value = false
  try {
    if (kind === 'open') await window.zhijiApi.diagnostics.openDirectory()
    else
      diagnosticExported.value = (await window.zhijiApi.diagnostics.exportBundle()) === 'exported'
  } catch (error) {
    emit('error', error)
  } finally {
    diagnosticBusy.value = false
  }
}

const hostTabs = [
  { key: 'claude', label: 'Claude' },
  { key: 'cursor', label: 'Cursor' },
  { key: 'vscode', label: 'VS Code' },
  { key: 'ccSwitch', label: 'CC-Switch' },
] as const
type McpHost = (typeof hostTabs)[number]['key']

const copyStatus = ref<{ host: McpHost; failed: boolean } | null>(null)
const aiBaseUrl = ref('')
const aiModelId = ref('')
const aiMultimodal = ref(false)
const aiContextWindowK = ref<number | null>(256)
const aiCompactThresholdPercent = ref<number | null>(80)
const keyDraft = ref('')
const aiSaving = ref(false)
watch(
  () => props.config?.ai,
  (ai) => {
    if (!ai) return
    aiBaseUrl.value = ai.baseUrl
    aiModelId.value = ai.modelId
    aiMultimodal.value = ai.multimodal
    aiContextWindowK.value = ai.contextWindowK
    aiCompactThresholdPercent.value = ai.compactThresholdPercent
    keyDraft.value = ai.apiKey
  },
  { immediate: true },
)
async function saveAi(): Promise<void> {
  if (aiSaving.value) return
  aiSaving.value = true
  try {
    const next = await window.zhijiApi.agent.saveSettings({
      baseUrl: aiBaseUrl.value.trim(),
      modelId: aiModelId.value.trim(),
      apiKey: keyDraft.value.trim(),
      multimodal: aiMultimodal.value,
      contextWindowK: aiContextWindowK.value ?? 0,
      compactThresholdPercent: aiCompactThresholdPercent.value ?? 0,
    })
    emit('aiSaved', next)
  } catch (error) {
    emit('error', error)
  } finally {
    aiSaving.value = false
  }
}
let copyStatusTimer: number | undefined
const snippets = computed(() => {
  const connection = props.mcpConnectionInfo
  if (!connection) return { claude: '', cursor: '', vscode: '', ccSwitch: '' }
  const server = {
    command: connection.command,
    args: connection.args,
    ...(connection.env ? { env: connection.env } : {}),
  }
  return {
    claude: JSON.stringify({ mcpServers: { jobtrail: server } }, null, 2),
    cursor: JSON.stringify({ mcpServers: { jobtrail: server } }, null, 2),
    vscode: JSON.stringify({ servers: { jobtrail: { type: 'stdio', ...server } } }, null, 2),
    ccSwitch: JSON.stringify({ type: 'stdio', ...server }, null, 2),
  }
})

async function copySnippet(host: McpHost): Promise<void> {
  const value = snippets.value[host]
  if (!value) return
  try {
    await navigator.clipboard.writeText(value)
    copyStatus.value = { host, failed: false }
  } catch {
    copyStatus.value = { host, failed: true }
  }
  window.clearTimeout(copyStatusTimer)
  copyStatusTimer = window.setTimeout(() => {
    if (copyStatus.value?.host === host) copyStatus.value = null
  }, 1500)
}

function updateMcp(patch: Partial<AppConfig['mcp']>): void {
  if (!props.config) return
  emit('updateConfig', { mcp: patch })
}

onBeforeUnmount(() => window.clearTimeout(copyStatusTimer))
</script>

<template>
  <section class="page-section settings-page" :class="{ 'is-dark': dark }">
    <div class="settings-layout">
      <section class="settings-section" aria-labelledby="settings-preferences-title">
        <header class="settings-section-header">
          <span class="settings-section-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" focusable="false">
              <path d="M4 7h9m4 0h3M4 17h3m4 0h9" />
              <circle cx="15" cy="7" r="2" />
              <circle cx="9" cy="17" r="2" />
            </svg>
          </span>
          <div>
            <h2 id="settings-preferences-title">{{ $t('settings.preferencesTitle') }}</h2>
            <p>{{ $t('settings.preferencesDescription') }}</p>
          </div>
        </header>
        <div class="settings-section-body">
          <div class="settings-field-grid">
            <div class="settings-field">
              <label class="settings-field-label">{{ $t('settings.theme') }}</label>
              <n-select
                :value="config?.themeMode"
                :disabled="!config"
                :options="[
                  { label: $t('settings.light'), value: 'light' },
                  { label: $t('settings.dark'), value: 'dark' },
                  { label: $t('settings.system'), value: 'system' },
                ]"
                :placeholder="$t('settings.themePlaceholder')"
                :aria-label="$t('settings.theme')"
                @update:value="emit('updateConfig', { themeMode: $event })"
              />
            </div>
            <div class="settings-field">
              <label class="settings-field-label">{{ $t('settings.language') }}</label>
              <n-select
                :value="config?.locale"
                :disabled="!config"
                :options="[
                  { label: '简体中文', value: 'zh-CN' },
                  { label: 'English', value: 'en-US' },
                ]"
                :placeholder="$t('settings.languagePlaceholder')"
                :aria-label="$t('settings.language')"
                @update:value="emit('updateConfig', { locale: $event })"
              />
            </div>
            <div class="settings-field">
              <label class="settings-field-label">{{
                $t('settings.companyReadValidityMonths')
              }}</label>
              <n-input-number
                :value="config?.companyReadValidityMonths"
                :disabled="!config"
                :min="1"
                :precision="0"
                :placeholder="$t('settings.companyReadValidityMonthsPlaceholder')"
                :aria-label="$t('settings.companyReadValidityMonths')"
                @update:value="emit('updateConfig', { companyReadValidityMonths: $event ?? 3 })"
              />
              <p class="settings-field-help">{{ $t('settings.companyReadValidityDescription') }}</p>
            </div>
          </div>
          <div class="settings-section-divider"></div>
          <div class="settings-behavior-grid">
            <div class="settings-behavior-item">
              <div>
                <strong>{{ $t('settings.closeBehavior') }}</strong>
                <p>{{ $t('settings.closeBehaviorDescription') }}</p>
              </div>
              <n-radio-group
                :value="config?.closeBehavior"
                :disabled="!config"
                :aria-label="$t('settings.closeBehavior')"
                @update:value="emit('closeBehavior', $event as CloseBehavior)"
              >
                <n-radio-button value="tray">{{ $t('settings.minimizeToTray') }}</n-radio-button>
                <n-radio-button value="quit">{{ $t('settings.quitDirectly') }}</n-radio-button>
              </n-radio-group>
            </div>
            <div class="settings-behavior-item">
              <div>
                <strong>{{ $t('settings.launchAtStartup') }}</strong>
                <p>{{ $t('settings.launchAtStartupDescription') }}</p>
              </div>
              <n-switch
                :value="config?.launchAtStartup"
                :disabled="!config"
                :aria-label="$t('settings.launchAtStartup')"
                @update:value="emit('launchAtStartup', $event)"
              />
            </div>
          </div>
        </div>
      </section>

      <section class="settings-section" aria-labelledby="settings-mcp-title">
        <header class="settings-section-header">
          <span class="settings-section-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" focusable="false">
              <path d="M10 13a5 5 0 0 0 7.1 0l3-3a5 5 0 0 0-7.1-7.1l-1.7 1.7" />
              <path d="M14 11a5 5 0 0 0-7.1 0l-3 3a5 5 0 0 0 7.1 7.1l1.7-1.7" />
            </svg>
          </span>
          <div>
            <h2 id="settings-mcp-title">{{ $t('settings.mcpTitle') }}</h2>
            <p>{{ $t('settings.mcpDescription') }}</p>
          </div>
        </header>
        <div class="settings-section-body">
          <div class="settings-switch-list">
            <div class="settings-switch-row">
              <div>
                <strong>{{ $t('settings.mcpEnabled') }}</strong>
                <p>{{ $t('settings.mcpEnabledDescription') }}</p>
              </div>
              <n-switch
                :disabled="!config"
                :value="config?.mcp.enabled"
                :aria-label="$t('settings.mcpEnabled')"
                @update:value="updateMcp({ enabled: $event })"
              />
            </div>
            <div class="settings-switch-row">
              <div>
                <strong>{{ $t('settings.mcpWriteConfirmation') }}</strong>
                <p>{{ $t('settings.mcpWriteConfirmationDescription') }}</p>
              </div>
              <n-switch
                :disabled="!config || !config.mcp.enabled"
                :value="config?.mcp.requireWriteConfirmation"
                :aria-label="$t('settings.mcpWriteConfirmation')"
                @update:value="updateMcp({ requireWriteConfirmation: $event })"
              />
            </div>
          </div>
          <p
            class="settings-mcp-notice"
            :class="{ 'is-warning': config?.mcp.enabled && !config.mcp.requireWriteConfirmation }"
          >
            {{
              !config?.mcp.enabled
                ? $t('settings.mcpDisabled')
                : config.mcp.requireWriteConfirmation
                  ? $t('settings.mcpConfirmationActive')
                  : $t('settings.mcpDirectWriteWarning')
            }}
          </p>
          <div class="settings-connection">
            <div class="settings-connection-header">
              <div>
                <h3>{{ $t('settings.mcpConnectionTitle') }}</h3>
                <p>{{ $t('settings.mcpConnectionDescription') }}</p>
              </div>
            </div>
            <n-tabs class="settings-mcp-tabs" type="segment" animated>
              <n-tab-pane
                v-for="host in hostTabs"
                :key="host.key"
                :name="host.key"
                :tab="host.label"
              >
                <div class="settings-snippet">
                  <pre class="settings-code"><code>{{ snippets[host.key] }}</code></pre>
                  <n-button
                    type="primary"
                    secondary
                    :disabled="!snippets[host.key]"
                    @click="copySnippet(host.key)"
                  >
                    {{
                      copyStatus?.host === host.key
                        ? $t(copyStatus.failed ? 'settings.mcpCopyFailed' : 'settings.mcpCopied')
                        : $t('settings.mcpCopy')
                    }}
                  </n-button>
                </div>
              </n-tab-pane>
            </n-tabs>
          </div>
        </div>
      </section>

      <section class="settings-section" aria-labelledby="settings-ai-title">
        <header class="settings-section-header">
          <span class="settings-section-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" focusable="false">
              <rect x="4" y="7" width="16" height="14" rx="4" />
              <path d="M12 7V3H9M4 13H2m18 0h2M9 17h6" />
              <circle cx="9" cy="12" r="1" />
              <circle cx="15" cy="12" r="1" />
            </svg>
          </span>
          <div>
            <h2 id="settings-ai-title">{{ $t('settings.aiTitle') }}</h2>
            <p>{{ $t('settings.aiDescription') }}</p>
          </div>
        </header>
        <div class="settings-section-body">
          <div class="settings-field-grid">
            <div class="settings-field">
              <label class="settings-field-label">Base URL</label
              ><n-input v-model:value="aiBaseUrl" placeholder="https://api.openai.com/v1" />
            </div>
            <div class="settings-field">
              <label class="settings-field-label">Model ID</label
              ><n-input
                v-model:value="aiModelId"
                :placeholder="$t('settings.aiModelPlaceholder')"
              />
            </div>
            <div class="settings-field">
              <label class="settings-field-label">API Key</label
              ><n-input
                v-model:value="keyDraft"
                type="password"
                show-password-on="click"
                :placeholder="$t('settings.aiKeyPlaceholder')"
              />
            </div>
          </div>
          <div class="settings-field-grid">
            <div class="settings-field">
              <label class="settings-field-label">{{ $t('settings.aiContextWindow') }}</label>
              <n-input-number
                v-model:value="aiContextWindowK"
                :min="8"
                :max="2048"
                :precision="0"
              />
            </div>
            <div class="settings-field">
              <label class="settings-field-label">{{ $t('settings.aiCompactThreshold') }}</label>
              <n-input-number
                v-model:value="aiCompactThresholdPercent"
                :min="50"
                :max="90"
                :precision="0"
              />
            </div>
          </div>
          <div class="settings-switch-row">
            <div>
              <strong>{{ $t('settings.aiMultimodal') }}</strong>
              <p>{{ $t('settings.aiMultimodalDescription') }}</p>
            </div>
            <n-switch v-model:value="aiMultimodal" />
          </div>
          <n-button type="primary" :loading="aiSaving" @click="saveAi">{{
            $t('settings.aiSave')
          }}</n-button>
        </div>
      </section>

      <section class="settings-section" aria-labelledby="settings-maintenance-title">
        <header class="settings-section-header">
          <span class="settings-section-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" focusable="false">
              <path d="M20 7a9 9 0 0 0-15-2L2 8m0-5v5h5" />
              <path d="M4 17a9 9 0 0 0 15 2l3-3m0 5v-5h-5" />
            </svg>
          </span>
          <div>
            <h2 id="settings-maintenance-title">{{ $t('settings.maintenanceTitle') }}</h2>
            <p>{{ $t('settings.maintenanceDescription') }}</p>
          </div>
        </header>
        <div class="settings-maintenance-grid">
          <div class="settings-maintenance-item">
            <div>
              <h3>{{ $t('settings.update') }}</h3>
              <p>{{ $t('settings.appUpdateDescription') }}</p>
            </div>
            <div class="settings-maintenance-footer">
              <span class="settings-version"
                >{{ $t('settings.version') }} <strong>{{ currentVersion }}</strong></span
              >
              <n-button
                type="primary"
                secondary
                :loading="checkingForUpdates"
                @click="checkForUpdates"
              >
                {{ $t('settings.checkUpdate') }}
              </n-button>
            </div>
          </div>
          <div class="settings-maintenance-item">
            <div>
              <h3>{{ $t('settings.catalogTitle') }}</h3>
              <p>{{ $t('settings.catalogDescription') }}</p>
            </div>
            <div class="settings-maintenance-footer">
              <span class="settings-version">
                {{ $t('settings.catalogVersion') }}
                <strong>{{ catalogStatus?.catalogVersion ?? '—' }}</strong>
              </span>
              <n-button
                type="primary"
                secondary
                :loading="catalogUpdating"
                :disabled="!catalogStatus || catalogUpdating"
                @click="updateCompanyCatalog"
              >
                {{ $t('settings.catalogUpdate') }}
              </n-button>
            </div>
          </div>
        </div>
      </section>

      <section class="settings-section" aria-labelledby="settings-diagnostics-title">
        <header class="settings-section-header">
          <span class="settings-section-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" focusable="false">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
              <path d="M14 2v6h6M8 13h8m-8 4h6" />
            </svg>
          </span>
          <div>
            <h2 id="settings-diagnostics-title">{{ $t('settings.diagnosticsTitle') }}</h2>
            <p>{{ $t('settings.diagnosticsDescription') }}</p>
          </div>
        </header>
        <div class="settings-section-body">
          <n-space>
            <n-button :disabled="diagnosticBusy" @click="diagnosticAction('open')">{{
              $t('settings.diagnosticsOpen')
            }}</n-button>
            <n-button :loading="diagnosticBusy" @click="diagnosticAction('export')">{{
              $t('settings.diagnosticsExport')
            }}</n-button>
          </n-space>
          <p v-if="diagnosticExported" role="status">{{ $t('settings.diagnosticsExported') }}</p>
        </div>
      </section>

      <section class="settings-section" aria-labelledby="settings-backup-title">
        <header class="settings-section-header">
          <span class="settings-section-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" focusable="false">
              <rect x="3" y="3" width="18" height="4" rx="1" />
              <path d="M5 7v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7M10 11h4" />
            </svg>
          </span>
          <div>
            <h2 id="settings-backup-title">{{ $t('settings.backupTitle') }}</h2>
            <p>{{ $t('settings.backupDescription') }}</p>
          </div>
        </header>
        <div class="settings-section-body">
          <n-space>
            <n-button :disabled="backupBusy || !config" @click="backupAction('export')">{{
              $t('settings.backupExport')
            }}</n-button>
            <n-button :disabled="backupBusy || !config" @click="backupAction('import')">{{
              $t('settings.backupImport')
            }}</n-button>
          </n-space>
          <p v-if="backupStatus" role="status">
            {{ backupStatus }}
          </p>
        </div>
      </section>

      <section class="settings-section" aria-labelledby="settings-tours-title">
        <header class="settings-section-header">
          <span class="settings-section-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" focusable="false">
              <circle cx="12" cy="12" r="10" />
              <path d="m16 8-2.5 5.5L8 16l2.5-5.5Z" />
            </svg>
          </span>
          <div>
            <h2 id="settings-tours-title">{{ $t('onboarding.title') }}</h2>
            <p>{{ $t('onboarding.description') }}</p>
          </div>
        </header>
        <div class="settings-section-body">
          <n-space>
            <n-button :disabled="!config || backupBusy" @click="emit('restartTour', 'app')">{{
              $t('onboarding.restartApp')
            }}</n-button>
            <n-button :disabled="!config || backupBusy" @click="emit('restartTour', 'discovery')">{{
              $t('onboarding.restartDiscovery')
            }}</n-button>
          </n-space>
        </div>
      </section>

      <section class="settings-danger" aria-labelledby="settings-danger-title">
        <div class="settings-danger-content">
          <span class="settings-section-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" focusable="false">
              <path d="M3 6h18M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
              <path d="m5 6 1 14a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1l1-14M10 10v7m4-7v7" />
            </svg>
          </span>
          <div>
            <h2 id="settings-danger-title">{{ $t('settings.dangerZone') }}</h2>
            <p>{{ $t('settings.uninstallDescription') }}</p>
          </div>
        </div>
        <n-popconfirm
          :positive-text="$t('settings.uninstallConfirmButton')"
          :negative-text="$t('common.cancel')"
          @positive-click="uninstallApp"
        >
          <template #trigger>
            <n-button type="error" secondary :loading="uninstalling">
              {{ $t('settings.uninstall') }}
            </n-button>
          </template>
          {{ $t('settings.uninstallWarning') }}
        </n-popconfirm>
      </section>
    </div>

    <n-modal
      :show="catalogModalVisible"
      :mask-closable="false"
      :close-on-esc="false"
      :auto-focus="false"
    >
      <n-card class="catalog-update-modal" :title="$t('settings.catalogDialogTitle')" bordered>
        <div class="catalog-update-content">
          <template v-if="catalogUpdating">
            <strong>{{ $t(`settings.catalogPhase.${catalogPhase}`) }}</strong>
            <n-progress
              type="line"
              :percentage="Math.floor(catalogProgress)"
              :show-indicator="true"
              processing
            />
          </template>
          <template v-else-if="catalogResult">
            <strong>{{
              $t(
                catalogResult.status === 'up-to-date'
                  ? 'settings.catalogUpToDate'
                  : 'settings.catalogSuccess',
              )
            }}</strong>
            <div class="catalog-update-summary">
              <span>{{ $t('settings.catalogAdded') }}：{{ catalogResult.added }}</span>
              <span>{{ $t('settings.catalogUpdated') }}：{{ catalogResult.updated }}</span>
              <span>{{ $t('settings.catalogAdopted') }}：{{ catalogResult.adopted }}</span>
              <span
                >{{ $t('settings.catalogConvertedToCustom') }}：{{
                  catalogResult.convertedToCustom
                }}</span
              >
              <span>{{ $t('settings.catalogUnchanged') }}：{{ catalogResult.unchanged }}</span>
            </div>
            <n-progress type="line" :percentage="100" status="success" />
          </template>
          <template v-else>
            <strong>{{ $t('settings.catalogFailed') }}</strong>
            <p class="catalog-update-error">{{ catalogError }}</p>
            <n-progress
              type="line"
              :percentage="Math.min(99, Math.floor(catalogProgress))"
              status="error"
            />
          </template>
        </div>
        <template v-if="!catalogUpdating" #footer>
          <n-space justify="end">
            <n-button type="primary" @click="closeCatalogModal">{{ $t('common.close') }}</n-button>
          </n-space>
        </template>
      </n-card>
    </n-modal>
  </section>
</template>
