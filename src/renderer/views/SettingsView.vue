<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import {
  NButton,
  NCard,
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
  CloseBehavior,
  CompanyCatalogPhase,
  CompanyCatalogStatus,
  CompanyCatalogUpdateResult,
  McpConnectionInfo,
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
}>()
const emit = defineEmits<{
  updateConfig: [input: Partial<AppConfig>]
  closeBehavior: [value: CloseBehavior]
  launchAtStartup: [value: boolean]
}>()

const hostTabs = [
  { key: 'claude', label: 'Claude' },
  { key: 'cursor', label: 'Cursor' },
  { key: 'vscode', label: 'VS Code' },
  { key: 'ccSwitch', label: 'CC-Switch' },
] as const
type McpHost = (typeof hostTabs)[number]['key']

const copyStatus = ref<{ host: McpHost; failed: boolean } | null>(null)
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
  emit('updateConfig', { mcp: { ...props.config.mcp, ...patch } })
}

onBeforeUnmount(() => window.clearTimeout(copyStatusTimer))
</script>

<template>
  <section class="page-section settings-page" :class="{ 'is-dark': dark }">
    <div class="settings-layout">
      <p class="settings-lead">{{ $t('settings.intro') }}</p>

      <section class="settings-section" aria-labelledby="settings-preferences-title">
        <header class="settings-section-header">
          <span class="settings-section-number">01</span>
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
          <span class="settings-section-number">02</span>
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

      <section class="settings-section" aria-labelledby="settings-maintenance-title">
        <header class="settings-section-header">
          <span class="settings-section-number">03</span>
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

      <section class="settings-danger" aria-labelledby="settings-danger-title">
        <div class="settings-danger-content">
          <span class="settings-section-number">04</span>
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
