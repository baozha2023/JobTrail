<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import {
  NButton,
  NCard,
  NForm,
  NFormItem,
  NInputNumber,
  NInput,
  NModal,
  NPopconfirm,
  NProgress,
  NRadio,
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
  <section class="page-section settings-page">
    <div class="settings-layout">
      <div class="settings-main-column">
        <n-card bordered class="settings-card" :title="$t('settings.appearance')">
          <n-form class="settings-form" label-placement="top">
            <div class="settings-form-grid">
              <n-form-item :label="$t('settings.theme')">
                <n-select
                  :value="config?.themeMode"
                  :options="[
                    { label: $t('settings.light'), value: 'light' },
                    { label: $t('settings.dark'), value: 'dark' },
                    { label: $t('settings.system'), value: 'system' },
                  ]"
                  :placeholder="$t('settings.themePlaceholder')"
                  @update:value="emit('updateConfig', { themeMode: $event })"
                />
              </n-form-item>
              <n-form-item :label="$t('settings.language')">
                <n-select
                  :value="config?.locale"
                  :options="[
                    { label: '简体中文', value: 'zh-CN' },
                    { label: 'English', value: 'en-US' },
                  ]"
                  :placeholder="$t('settings.languagePlaceholder')"
                  @update:value="emit('updateConfig', { locale: $event })"
                />
              </n-form-item>
              <n-form-item :label="$t('settings.companyReadValidityMonths')">
                <n-input-number
                  :value="config?.companyReadValidityMonths"
                  :min="1"
                  :precision="0"
                  :placeholder="$t('settings.companyReadValidityMonthsPlaceholder')"
                  @update:value="emit('updateConfig', { companyReadValidityMonths: $event ?? 3 })"
                />
              </n-form-item>
              <n-form-item class="settings-form-item-wide" :label="$t('settings.closeBehavior')">
                <n-radio-group
                  :value="config?.closeBehavior"
                  @update:value="emit('closeBehavior', $event as CloseBehavior)"
                >
                  <n-space wrap>
                    <n-radio value="tray">{{ $t('settings.minimizeToTray') }}</n-radio>
                    <n-radio value="quit">{{ $t('settings.quitDirectly') }}</n-radio>
                  </n-space>
                </n-radio-group>
              </n-form-item>
              <n-form-item class="settings-form-item-wide" :label="$t('settings.launchAtStartup')">
                <n-radio-group
                  :value="config?.launchAtStartup"
                  @update:value="emit('launchAtStartup', $event as boolean)"
                >
                  <n-space wrap>
                    <n-radio :value="true">{{ $t('settings.enable') }}</n-radio>
                    <n-radio :value="false">{{ $t('settings.disable') }}</n-radio>
                  </n-space>
                </n-radio-group>
              </n-form-item>
            </div>
          </n-form>
        </n-card>

        <n-card bordered class="settings-card" :title="$t('settings.mcpTitle')">
          <div class="settings-mcp-panel">
            <p class="settings-mcp-description">{{ $t('settings.mcpDescription') }}</p>

            <div class="settings-toggle-grid">
              <div class="settings-toggle-row" :class="{ 'is-active': config?.mcp.enabled }">
                <strong>{{ $t('settings.mcpEnabled') }}</strong>
                <n-switch
                  :disabled="!config"
                  :value="config?.mcp.enabled"
                  @update:value="updateMcp({ enabled: $event })"
                />
              </div>
              <div
                class="settings-toggle-row"
                :class="{ 'is-active': config?.mcp.requireWriteConfirmation }"
              >
                <strong>{{ $t('settings.mcpWriteConfirmation') }}</strong>
                <n-switch
                  :disabled="!config"
                  :value="config?.mcp.requireWriteConfirmation"
                  @update:value="updateMcp({ requireWriteConfirmation: $event })"
                />
              </div>
            </div>

            <p
              v-if="!config?.mcp.enabled || !config.mcp.requireWriteConfirmation"
              class="settings-mcp-security"
              :class="{
                'is-warning': config?.mcp.enabled && !config.mcp.requireWriteConfirmation,
              }"
            >
              {{
                !config?.mcp.enabled
                  ? $t('settings.mcpDisabled')
                  : $t('settings.mcpDirectWriteWarning')
              }}
            </p>

            <div class="settings-connection-panel">
              <n-tabs class="settings-mcp-tabs" type="segment" animated>
                <n-tab-pane
                  v-for="host in hostTabs"
                  :key="host.key"
                  :name="host.key"
                  :tab="host.label"
                >
                  <div class="settings-mcp-snippet">
                    <n-input
                      class="settings-mcp-config-input"
                      :value="snippets[host.key]"
                      type="textarea"
                      readonly
                      :autosize="{ minRows: 5, maxRows: 9 }"
                    />
                    <n-button
                      type="primary"
                      secondary
                      class="settings-mcp-copy"
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
        </n-card>
      </div>

      <aside class="settings-side-column">
        <n-card bordered class="settings-card settings-update-card" :title="$t('settings.update')">
          <div class="settings-update-panel">
            <div class="settings-version-block">
              <span class="muted-text">{{ $t('settings.version') }}</span>
              <strong>{{ currentVersion }}</strong>
            </div>
            <n-button block :loading="checkingForUpdates" @click="checkForUpdates">
              {{ $t('settings.checkUpdate') }}
            </n-button>
          </div>
        </n-card>

        <n-card
          bordered
          class="settings-card settings-update-card"
          :title="$t('settings.catalogTitle')"
        >
          <div class="settings-update-panel">
            <n-button
              block
              :loading="catalogUpdating"
              :disabled="!catalogStatus || catalogUpdating"
              @click="updateCompanyCatalog"
            >
              {{ $t('settings.catalogUpdate') }}
            </n-button>
          </div>
        </n-card>

        <n-card
          bordered
          class="settings-card settings-danger-card"
          :title="$t('settings.dangerZone')"
        >
          <div class="settings-danger-panel">
            <div class="settings-danger-copy">
              <strong>{{ $t('settings.uninstall') }}</strong>
              <p>{{ $t('settings.uninstallDescription') }}</p>
            </div>
            <n-popconfirm
              :positive-text="$t('settings.uninstallConfirmButton')"
              :negative-text="$t('common.cancel')"
              @positive-click="uninstallApp"
            >
              <template #trigger>
                <n-button block type="error" secondary :loading="uninstalling">
                  {{ $t('settings.uninstall') }}
                </n-button>
              </template>
              {{ $t('settings.uninstallWarning') }}
            </n-popconfirm>
          </div>
        </n-card>
      </aside>
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
