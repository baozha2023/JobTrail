<script setup lang="ts">
import { computed, h, onBeforeUnmount, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import logoUrl from '../../../resource/icon.png'
import {
  darkTheme,
  enUS,
  lightTheme,
  NButton,
  NCard,
  NConfigProvider,
  NDatePicker,
  NForm,
  NFormItem,
  NInput,
  NLayout,
  NLayoutContent,
  NModal,
  NPopconfirm,
  NRadio,
  NRadioGroup,
  NSelect,
  NSpace,
  NTag,
  createDiscreteApi,
  zhCN,
  type DataTableColumns,
  type SelectOption,
} from 'naive-ui'
import type {
  AppConfig,
  Company,
  CompanyCatalogPhase,
  CompanyCatalogProgress,
  CompanyCatalogStatus,
  CompanyCatalogUpdateResult,
  CloseBehavior,
  Opportunity,
  Industry,
  McpConnectionInfo,
  ResumeVersion,
  Status,
} from '../../shared/types'
import OpportunitiesView from './OpportunitiesView.vue'
import OpportunityStatusFlowModal from './OpportunityStatusFlowModal.vue'
import CalendarView from './CalendarView.vue'
import StatusesView from './StatusesView.vue'
import IndustriesView from './IndustriesView.vue'
import ResumesView from './ResumesView.vue'
import CompaniesView from './CompaniesView.vue'
import SettingsView from './SettingsView.vue'
import Sidebar from '../layout/Sidebar.vue'
import Titlebar from '../layout/Titlebar.vue'
import { getErrorMessage } from '../utils/errors'
import { useStatusesStore } from '../stores/statuses'
import { useIndustriesStore } from '../stores/industries'
import { useResumesStore } from '../stores/resumes'
import { useCompaniesStore } from '../stores/companies'
import { useSettingsStore } from '../stores/settings'
import { useCalendarWorkspace } from '../composables/useCalendarWorkspace'
import { useOpportunityWorkspace } from '../composables/useOpportunityWorkspace'
import { useManagementWorkspace } from '../composables/useManagementWorkspace'
import type { ViewKey } from '../types'

const { t, locale } = useI18n()
const windowControls = window.windowControlsApi
const statusesStore = useStatusesStore()
const industriesStore = useIndustriesStore()
const resumesStore = useResumesStore()
const companiesStore = useCompaniesStore()
const settingsStore = useSettingsStore()
const { items: statuses } = storeToRefs(statusesStore)
const { items: industries } = storeToRefs(industriesStore)
const { items: resumes } = storeToRefs(resumesStore)
const { items: companies } = storeToRefs(companiesStore)
const { config } = storeToRefs(settingsStore)
const viewportWidth = ref(window.innerWidth)
const activeView = ref<ViewKey>('opportunities')
const loading = ref(false)
const checkingForUpdates = ref(false)
const currentVersion = ref('—')
const mcpConnectionInfo = ref<McpConnectionInfo | null>(null)
const uninstalling = ref(false)
const catalogStatus = ref<CompanyCatalogStatus | null>(null)
const catalogModalVisible = ref(false)
const catalogUpdating = ref(false)
const catalogPhase = ref<CompanyCatalogPhase>('metadata')
const catalogProgress = ref(0)
const catalogResult = ref<CompanyCatalogUpdateResult | null>(null)
const catalogError = ref('')
const isDevelopment = ref(false)
const currentTime = ref(Date.now())
const prefersDark = ref(false)
const tablePageSizes = [10, 20, 50]
function createTablePagination(initialPageSize = 10) {
  const page = ref(1)
  const pageSize = ref(initialPageSize)
  return computed(() => ({
    page: page.value,
    pageSize: pageSize.value,
    showSizePicker: true,
    pageSizes: tablePageSizes,
    onUpdatePage: (nextPage: number) => {
      page.value = nextPage
    },
    onUpdatePageSize: (nextPageSize: number) => {
      pageSize.value = nextPageSize
      page.value = 1
    },
  }))
}
const opportunityPagination = createTablePagination()
const statusPagination = createTablePagination()
const industryPagination = createTablePagination()
const resumePagination = createTablePagination()
const companyPagination = createTablePagination()

const menuOptions = computed(() => [
  { label: t('nav.opportunities'), key: 'opportunities' },
  { label: t('nav.calendar'), key: 'calendar' },
  { label: t('nav.statuses'), key: 'statuses' },
  { label: t('nav.industries'), key: 'industries' },
  { label: t('nav.resumes'), key: 'resumes' },
  { label: t('nav.companies'), key: 'companies' },
  { label: t('nav.settings'), key: 'settings' },
])

const pageTitle = computed(() => {
  const titles: Record<string, string> = {
    opportunities: t('opportunity.title'),
    calendar: t('calendar.title'),
    statuses: t('management.statuses'),
    industries: t('management.industries'),
    resumes: t('management.resumes'),
    companies: t('management.companies'),
    settings: t('settings.title'),
  }
  return titles[activeView.value] ?? t('opportunity.title')
})
const sidebarWidth = computed(() =>
  Math.min(220, Math.max(168, Math.round(viewportWidth.value * 0.145))),
)

const statusOptions = computed(() =>
  statuses.value.map((item) => ({ label: item.label, value: item.id })),
)
const industryOptions = computed(() =>
  industries.value.map((item) => ({ label: item.name, value: item.id })),
)
const companyOptions = computed(() =>
  companies.value.map((item) => ({ label: item.name, value: item.id })),
)
const resumeOptions = computed(() =>
  resumes.value.map((item) => ({ label: item.name, value: item.id })),
)
const theme = computed(() => {
  const isDark =
    config.value?.themeMode === 'dark' ||
    (config.value?.themeMode === 'system' && prefersDark.value)
  return isDark ? darkTheme : lightTheme
})
const isDarkTheme = computed(() => theme.value === darkTheme)
const statusFlowThemeSaving = ref(false)
const naiveLocale = computed(() => (locale.value === 'zh-CN' ? zhCN : enUS))
const { message } = createDiscreteApi(['message'], {
  configProviderProps: computed(() => ({ theme: theme.value, locale: naiveLocale.value })),
})

const {
  showEventModal,
  editingEventId,
  eventForm,
  calendarMonth,
  selectedCalendarDay,
  eventTypeOptions,
  reminderOptions,
  weekdays,
  selectedDayEvents,
  monthEventCount,
  monthLabel,
  calendarDays,
  formatEventTime,
  isSameDay,
  eventsForDay,
  selectCalendarDay,
  loadCalendar,
  newEvent,
  openEvent,
  setEventAllDay,
  openCalendarEventFromReminder,
  saveEvent,
  deleteEvent,
  previousMonth,
  nextMonth,
  goToday,
} = useCalendarWorkspace({
  activeView,
  showError,
  notifySuccess: (text) => {
    message.success(text)
  },
  notifyError: (text) => {
    message.error(text)
  },
})

const {
  opportunities,
  allOpportunities,
  opportunitiesLoading,
  search,
  selectedStatusId,
  selectedCompanyId,
  showOpportunityModal,
  showStatusFlowModal,
  statusFlowOpportunity,
  statusFlow,
  statusFlowLoading,
  editingOpportunityId,
  opportunityForm,
  loadOpportunities,
  loadAllOpportunities,
  refreshOpportunities,
  newOpportunity,
  openOpportunity,
  openStatusFlow,
  closeStatusFlow,
  reloadStatusFlow,
  saveOpportunity,
  deleteOpportunity,
} = useOpportunityWorkspace({
  companies,
  statuses,
  loadCalendar,
  showError,
  notifySuccess: (text) => {
    message.success(text)
  },
  notifyError: (text) => {
    message.error(text)
  },
})

const {
  showStatusModal,
  editingStatusId,
  statusForm,
  showResumeModal,
  resumeForm,
  showCompanyModal,
  editingCompanyId,
  companyManagementSearch,
  selectedCompanyIndustryId,
  companyAliasInput,
  companyForm,
  showIndustryModal,
  editingIndustryId,
  industryForm,
  managedCompanies,
  moveStatus,
  moveIndustry,
  moveResume,
  openStatusEditor,
  saveStatus,
  deleteStatus,
  importResume,
  openResumeEditor,
  saveResume,
  deleteResume,
  openResume,
  openIndustryEditor,
  saveIndustry,
  deleteIndustry,
  openCompanyEditor,
  commitCompanyAliasInput,
  removeCompanyAlias,
  saveCompany,
  toggleCompanyFavorite,
  deleteCompany,
} = useManagementWorkspace({
  statuses,
  industries,
  resumes,
  companies,
  loadCompanies,
  loadOpportunities,
  loadAllOpportunities,
  loadCalendar,
  showError,
  notifySuccess: (text) => {
    message.success(text)
  },
  notifyError: (text) => {
    message.error(text)
  },
})

const columns = computed<DataTableColumns<Opportunity>>(() => [
  {
    title: t('opportunity.company'),
    key: 'companyName',
    width: '14%',
    ellipsis: { tooltip: true },
  },
  { title: t('opportunity.position'), key: 'title', width: '20%', ellipsis: { tooltip: true } },
  {
    title: t('opportunity.status'),
    key: 'statusLabel',
    width: '12%',
    render: (row) =>
      h(
        NTag,
        { type: row.statusLabel === 'Offer' ? 'success' : 'info', bordered: false },
        { default: () => row.statusLabel },
      ),
  },
  {
    title: t('opportunity.appliedAt'),
    key: 'appliedAt',
    width: '14%',
    render: (row) => formatDate(row.appliedAt),
  },
  {
    title: t('opportunity.url'),
    key: 'jobUrl',
    width: '16%',
    ellipsis: { tooltip: true },
    render: (row) =>
      row.jobUrl
        ? h(
            'a',
            {
              class: 'external-link',
              href: normalizeExternalUrl(row.jobUrl),
              title: row.jobUrl,
              onClick: (event: MouseEvent) => {
                event.preventDefault()
                openEventLink(row.jobUrl)
              },
            },
            row.jobUrl,
          )
        : '—',
  },
  {
    title: t('common.actions'),
    key: 'actions',
    width: '24%',
    render: (row) =>
      h(
        NSpace,
        { size: 8, wrap: true },
        {
          default: () => [
            h(
              NButton,
              { size: 'small', onClick: () => openOpportunity(row) },
              { default: () => t('common.edit') },
            ),
            h(
              NButton,
              {
                size: 'small',
                type: 'primary',
                tertiary: true,
                title: t('opportunity.flowOpen'),
                'aria-label': t('opportunity.flowOpen'),
                onClick: () => openStatusFlow(row),
              },
              { default: () => t('opportunity.flowButton') },
            ),
            h(
              NPopconfirm,
              { onPositiveClick: () => deleteOpportunity(row.id) },
              {
                trigger: () =>
                  h(
                    NButton,
                    { size: 'small', tertiary: true, type: 'error' },
                    { default: () => t('common.delete') },
                  ),
                default: () => t('opportunity.deleteConfirm'),
              },
            ),
          ],
        },
      ),
  },
])

const statusColumns = computed<DataTableColumns<Status>>(() => [
  {
    title: '',
    key: 'order',
    width: '12%',
    render: (row) => orderControls(row.id, statuses.value, moveStatus),
  },
  { title: t('management.statusName'), key: 'label', width: '68%', ellipsis: { tooltip: true } },
  {
    title: t('common.edit'),
    key: 'actions',
    width: '20%',
    render: (row) =>
      row.isBuiltin && !isDevelopment.value
        ? h('span', { class: 'muted-text', title: t('management.builtinLocked') }, '—')
        : h(
            NSpace,
            { size: 8, wrap: true },
            {
              default: () => [
                h(
                  NButton,
                  { size: 'small', onClick: () => openStatusEditor(row) },
                  { default: () => t('common.edit') },
                ),
                h(
                  NPopconfirm,
                  { onPositiveClick: () => deleteStatus(row) },
                  {
                    trigger: () =>
                      h(
                        NButton,
                        { size: 'small', tertiary: true, type: 'error' },
                        { default: () => t('common.delete') },
                      ),
                    default: () => t('management.statusDeleteConfirm'),
                  },
                ),
              ],
            },
          ),
  },
])

const industryColumns = computed<DataTableColumns<Industry>>(() => [
  {
    title: '',
    key: 'order',
    width: '12%',
    render: (row) => orderControls(row.id, industries.value, moveIndustry),
  },
  { title: t('management.industryName'), key: 'name', width: '68%', ellipsis: { tooltip: true } },
  {
    title: t('common.edit'),
    key: 'actions',
    width: '20%',
    render: (row) =>
      row.isBuiltin && !isDevelopment.value
        ? h('span', { class: 'muted-text', title: t('management.builtinLocked') }, '—')
        : h(
            NSpace,
            { size: 8, wrap: true },
            {
              default: () => [
                h(
                  NButton,
                  { size: 'small', onClick: () => openIndustryEditor(row) },
                  { default: () => t('common.edit') },
                ),
                h(
                  NPopconfirm,
                  { onPositiveClick: () => deleteIndustry(row) },
                  {
                    trigger: () =>
                      h(
                        NButton,
                        { size: 'small', tertiary: true, type: 'error' },
                        { default: () => t('common.delete') },
                      ),
                    default: () => t('management.industryDeleteConfirm'),
                  },
                ),
              ],
            },
          ),
  },
])

const resumeColumns = computed<DataTableColumns<ResumeVersion>>(() => [
  {
    title: '',
    key: 'order',
    width: '12%',
    render: (row) => orderControls(row.id, resumes.value, moveResume),
  },
  { title: t('management.resumeName'), key: 'name', width: '17%', ellipsis: { tooltip: true } },
  {
    title: t('management.resumeFile'),
    key: 'relativePath',
    width: '23%',
    ellipsis: { tooltip: true },
  },
  {
    title: t('management.resumeSize'),
    key: 'sizeBytes',
    width: '10%',
    render: (row) => (row.sizeBytes === null ? '—' : `${Math.ceil(row.sizeBytes / 1024)} KB`),
  },
  {
    title: t('management.resumeNote'),
    key: 'note',
    width: '19%',
    ellipsis: { tooltip: true },
    render: (row) => row.note ?? '—',
  },
  {
    title: t('common.edit'),
    key: 'actions',
    width: '19%',
    render: (row) =>
      h(
        NSpace,
        { size: 8, wrap: true },
        {
          default: () => [
            h(
              NButton,
              { size: 'small', onClick: () => openResumeEditor(row) },
              { default: () => t('common.edit') },
            ),
            h(
              NButton,
              { size: 'small', onClick: () => openResume(row.id) },
              { default: () => t('common.open') },
            ),
            h(
              NPopconfirm,
              { onPositiveClick: () => deleteResume(row) },
              {
                trigger: () =>
                  h(
                    NButton,
                    { size: 'small', tertiary: true, type: 'error' },
                    { default: () => t('common.delete') },
                  ),
                default: () => t('management.resumeDeleteConfirm'),
              },
            ),
          ],
        },
      ),
  },
])

const companyColumns = computed<DataTableColumns<Company>>(() => [
  { title: t('management.companyName'), key: 'name', width: '18%', ellipsis: { tooltip: true } },
  {
    title: t('management.companyIndustry'),
    key: 'industryName',
    width: '14%',
    ellipsis: { tooltip: true },
    render: (row) => row.industryName ?? '—',
  },
  {
    title: t('management.companyCareerUrl'),
    key: 'careerUrl',
    width: '30%',
    ellipsis: { tooltip: true },
    render: (row) => {
      const url = row.careerUrl
      return url
        ? h(
            'a',
            {
              class: 'external-link',
              href: normalizeExternalUrl(url),
              title: url,
              onClick: (event: MouseEvent) => {
                event.preventDefault()
                void openCompanyCareerLink(row)
              },
            },
            url,
          )
        : '—'
    },
  },
  {
    title: t('management.companyReadStatus'),
    key: 'readStatus',
    width: '12%',
    render: (row) =>
      h(
        NTag,
        { type: isCompanyRead(row) ? 'success' : 'warning', bordered: false },
        {
          default: () => (isCompanyRead(row) ? t('management.readTag') : t('management.unreadTag')),
        },
      ),
  },
  {
    title: t('management.companyFavorite'),
    key: 'isFavorite',
    width: '8%',
    render: (row) =>
      h(
        NButton,
        {
          circle: true,
          quaternary: true,
          size: 'small',
          type: row.isFavorite ? 'warning' : 'default',
          title: row.isFavorite ? t('management.unfavorite') : t('management.favorite'),
          'aria-label': row.isFavorite ? t('management.unfavorite') : t('management.favorite'),
          class: 'favorite-button',
          onClick: () => toggleCompanyFavorite(row),
        },
        {
          default: () =>
            h(
              'svg',
              {
                class: ['favorite-svg', { active: row.isFavorite }],
                viewBox: '0 0 24 24',
                'aria-hidden': 'true',
              },
              [
                h('path', {
                  d: 'M12 3.75l2.57 5.2 5.74.83-4.15 4.05.98 5.72L12 16.85l-5.14 2.7.98-5.72-4.15-4.05 5.74-.83L12 3.75z',
                }),
              ],
            ),
        },
      ),
  },
  {
    title: t('common.edit'),
    key: 'actions',
    width: '18%',
    render: (row) =>
      row.isBuiltin && !isDevelopment.value
        ? h('span', { class: 'muted-text', title: t('management.builtinLocked') }, '—')
        : h(
            NSpace,
            { size: 8, wrap: true },
            {
              default: () => [
                h(
                  NButton,
                  { size: 'small', onClick: () => openCompanyEditor(row) },
                  { default: () => t('common.edit') },
                ),
                h(
                  NPopconfirm,
                  { onPositiveClick: () => deleteCompany(row) },
                  {
                    trigger: () =>
                      h(
                        NButton,
                        { size: 'small', tertiary: true, type: 'error' },
                        { default: () => t('common.delete') },
                      ),
                    default: () => t('management.companyDeleteConfirm'),
                  },
                ),
              ],
            },
          ),
  },
])

function formatDate(timestamp: number | null): string {
  if (timestamp === null) return '—'
  return new Intl.DateTimeFormat(locale.value, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(timestamp)
}

function isCompanyRead(company: Company): boolean {
  if (company.lastReadAt === null) return false
  const validityMonths = config.value?.companyReadValidityMonths ?? 3
  const validUntil = new Date(company.lastReadAt)
  validUntil.setMonth(validUntil.getMonth() + validityMonths)
  return currentTime.value < validUntil.getTime()
}

function filterCompanyOption(pattern: string, option: SelectOption): boolean {
  const keyword = pattern.trim().toLocaleLowerCase()
  if (!keyword) return true
  const companyId = typeof option.value === 'number' ? option.value : null
  const company = companies.value.find((item) => item.id === companyId)
  const label = typeof option.label === 'string' ? option.label : (company?.name ?? '')
  return [label, ...(company?.aliases ?? [])].some((value) =>
    value.toLocaleLowerCase().includes(keyword),
  )
}

function orderControls<T extends { id: number }>(
  id: number,
  items: T[],
  move: (id: number, offset: number) => Promise<void>,
) {
  const index = items.findIndex((item) => item.id === id)
  return h('div', { class: 'order-controls' }, [
    h(
      NButton,
      {
        circle: true,
        quaternary: true,
        size: 'small',
        class: 'order-arrow-button',
        disabled: index <= 0,
        title: t('management.moveUp'),
        'aria-label': t('management.moveUp'),
        onClick: () => {
          void move(id, -1)
        },
      },
      { default: () => h('span', { class: 'order-arrow' }, '↑') },
    ),
    h(
      NButton,
      {
        circle: true,
        quaternary: true,
        size: 'small',
        class: 'order-arrow-button',
        disabled: index < 0 || index >= items.length - 1,
        title: t('management.moveDown'),
        'aria-label': t('management.moveDown'),
        onClick: () => {
          void move(id, 1)
        },
      },
      { default: () => h('span', { class: 'order-arrow' }, '↓') },
    ),
  ])
}

function errorMessage(error: unknown): string {
  return getErrorMessage(error, t)
}

function showError(error: unknown): void {
  message.error(errorMessage(error))
}

function runWindowControl(action: () => Promise<unknown>): void {
  void action().catch(showError)
}

async function openExternal(url: string): Promise<void> {
  try {
    await window.zhijiApi.system.openExternal(url)
  } catch (error) {
    showError(error)
  }
}

async function openCompanyCareerLink(company: Company): Promise<void> {
  if (!company.careerUrl) return
  try {
    await window.zhijiApi.system.openExternal(normalizeExternalUrl(company.careerUrl))
    const updated = await window.zhijiApi.companies.markRead(company.id)
    companies.value = companies.value.map((item) => (item.id === updated.id ? updated : item))
  } catch (error) {
    showError(error)
  }
}

function isExternalUrl(value: string | null): boolean {
  return value !== null && /^(https?:\/\/|www\.)/i.test(value.trim())
}

function normalizeExternalUrl(value: string | null): string {
  const trimmed = value?.trim() ?? ''
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

function openEventLink(value: string | null): void {
  if (!value) return
  void openExternal(normalizeExternalUrl(value))
}

function updateViewportWidth(): void {
  viewportWidth.value = window.innerWidth
}

async function loadAll(): Promise<void> {
  loading.value = true
  const results = await Promise.allSettled([
    settingsStore.load(),
    window.velopackApi.getVersion(),
    statusesStore.load(),
    industriesStore.load(),
    resumesStore.load(),
    companiesStore.load(),
    loadAllOpportunities(),
    window.zhijiApi.system.isDevelopment(),
    window.zhijiApi.mcp.getConnectionInfo(),
    window.zhijiApi.companyCatalog.getStatus(),
  ])
  const [
    configResult,
    versionResult,
    statusResult,
    industryResult,
    resumeResult,
    companyResult,
    allOpportunitiesResult,
    developmentResult,
    mcpConnectionResult,
    catalogStatusResult,
  ] = results
  if (configResult.status === 'fulfilled' && config.value) locale.value = config.value.locale
  else if (configResult.status === 'rejected') showError(configResult.reason)
  if (versionResult.status === 'fulfilled') {
    currentVersion.value = versionResult.value
  } else {
    showError(versionResult.reason)
  }
  if (statusResult.status === 'rejected') showError(statusResult.reason)
  if (industryResult.status === 'rejected') showError(industryResult.reason)
  if (resumeResult.status === 'rejected') showError(resumeResult.reason)
  if (companyResult.status === 'rejected') showError(companyResult.reason)
  if (allOpportunitiesResult.status === 'rejected') showError(allOpportunitiesResult.reason)
  if (developmentResult.status === 'fulfilled') isDevelopment.value = developmentResult.value
  else showError(developmentResult.reason)
  if (mcpConnectionResult.status === 'fulfilled')
    mcpConnectionInfo.value = mcpConnectionResult.value
  else showError(mcpConnectionResult.reason)
  if (catalogStatusResult.status === 'fulfilled') catalogStatus.value = catalogStatusResult.value
  else showError(catalogStatusResult.reason)
  await Promise.allSettled([loadOpportunities(), loadCalendar()]).then((settled) =>
    settled.forEach((result) => {
      if (result.status === 'rejected') showError(result.reason)
    }),
  )
  loading.value = false
}

let externalRefreshRunning = false
let externalRefreshPending = false

async function refreshExternalData(): Promise<void> {
  externalRefreshPending = true
  if (externalRefreshRunning) return
  externalRefreshRunning = true
  try {
    while (externalRefreshPending) {
      externalRefreshPending = false
      const baseResults = await Promise.allSettled([
        statusesStore.load(),
        industriesStore.load(),
        resumesStore.load(),
        companiesStore.load(),
        loadAllOpportunities(),
      ])
      baseResults.forEach((result) => {
        if (result.status === 'rejected') showError(result.reason)
      })
      const viewResults = await Promise.allSettled([
        loadOpportunities(),
        loadCalendar(),
        reloadStatusFlow(),
      ])
      viewResults.forEach((result) => {
        if (result.status === 'rejected') showError(result.reason)
      })
    }
  } finally {
    externalRefreshRunning = false
  }
}

async function loadCompanies(): Promise<void> {
  await companiesStore.load()
}

function receiveCatalogProgress(progress: CompanyCatalogProgress): void {
  if (!catalogUpdating.value) return
  catalogPhase.value = progress.phase
  catalogProgress.value = Math.max(catalogProgress.value, progress.progress)
}

async function updateCompanyCatalog(): Promise<void> {
  if (catalogUpdating.value) return
  catalogModalVisible.value = true
  catalogUpdating.value = true
  catalogPhase.value = 'metadata'
  catalogProgress.value = 0
  catalogResult.value = null
  catalogError.value = ''
  try {
    const result = await window.zhijiApi.companyCatalog.update()
    catalogPhase.value = 'finalizing'
    catalogResult.value = result
    catalogProgress.value = 100
    const refreshResults = await Promise.allSettled([
      companiesStore.load(),
      loadAllOpportunities(),
      loadOpportunities(),
      loadCalendar(),
      window.zhijiApi.companyCatalog.getStatus(),
    ])
    refreshResults.slice(0, 4).forEach((refreshResult) => {
      if (refreshResult.status === 'rejected') showError(refreshResult.reason)
    })
    const statusResult = refreshResults[4]
    if (statusResult?.status === 'fulfilled') catalogStatus.value = statusResult.value
    else if (statusResult?.status === 'rejected') showError(statusResult.reason)
  } catch (error) {
    catalogError.value = errorMessage(error)
  } finally {
    catalogUpdating.value = false
  }
}

function closeCatalogModal(): void {
  if (catalogUpdating.value) return
  catalogModalVisible.value = false
}

async function saveConfig(input: Partial<AppConfig>): Promise<void> {
  if (!config.value) return
  try {
    await settingsStore.update(input)
    if (!config.value) return
    locale.value = config.value.locale
    message.success(t('feedback.saveSuccess'))
  } catch (error) {
    showError(error)
  }
}

async function setStatusFlowTheme(value: AppConfig['statusFlowTheme']): Promise<void> {
  if (statusFlowThemeSaving.value) return
  statusFlowThemeSaving.value = true
  try {
    await settingsStore.update({ statusFlowTheme: value })
  } catch (error) {
    showError(error)
  } finally {
    statusFlowThemeSaving.value = false
  }
}

function setCloseBehavior(value: CloseBehavior): void {
  void saveConfig({ closeBehavior: value })
}

function setLaunchAtStartup(value: boolean): void {
  void saveConfig({ launchAtStartup: value })
}

async function checkForUpdates(): Promise<void> {
  if (checkingForUpdates.value) return
  if (isDevelopment.value) {
    message.info(t('settings.updateUnavailableDevelopment'))
    return
  }
  checkingForUpdates.value = true
  let statusMessage: { destroy: () => void } | null = message.loading(t('settings.checking'), {
    duration: 0,
  })
  try {
    const updateInfo = await window.velopackApi.checkForUpdates()
    statusMessage.destroy()
    statusMessage = null
    if (!updateInfo) {
      message.success(t('settings.noUpdate'))
      return
    }

    message.info(t('settings.updateFound'))
    if (!window.confirm(t('settings.updateAvailable'))) return

    statusMessage = message.loading(t('settings.updating'), { duration: 0 })
    await window.velopackApi.downloadUpdates()
    await window.velopackApi.applyUpdates()
  } catch (error) {
    statusMessage?.destroy()
    statusMessage = null
    console.error('Update failed', error)
    message.error(t('settings.updateFailed'))
  } finally {
    statusMessage?.destroy()
    checkingForUpdates.value = false
  }
}

async function uninstallApp(): Promise<void> {
  if (uninstalling.value) return
  uninstalling.value = true
  let started = false
  try {
    const result = await window.velopackApi.uninstall()
    started = result === 'started'
    if (result === 'started') {
      message.info(t('settings.uninstallStarting'))
      return
    }
    message.error(
      t(
        result === 'development'
          ? 'settings.uninstallDevelopment'
          : 'settings.uninstallUnavailable',
      ),
    )
  } catch (error) {
    showError(error)
  } finally {
    if (!started) uninstalling.value = false
  }
}

let removeReminderClickListener: (() => void) | undefined
let removeExternalDataChangeListener: (() => void) | undefined
let readStatusTimer: number | undefined
let removePreferredColorSchemeListener: (() => void) | undefined
let removeCatalogProgressListener: (() => void) | undefined
onMounted(() => {
  window.addEventListener('resize', updateViewportWidth)
  readStatusTimer = window.setInterval(() => {
    currentTime.value = Date.now()
  }, 60_000)
  removeReminderClickListener = window.zhijiApi.calendar.onReminderClick((notification) => {
    void openCalendarEventFromReminder(notification)
  })
  removeExternalDataChangeListener = window.zhijiApi.data.onExternalChange(() => {
    void refreshExternalData()
  })
  removeCatalogProgressListener = window.zhijiApi.companyCatalog.onProgress(receiveCatalogProgress)
  if (window.matchMedia) {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    prefersDark.value = media.matches
    const listener = (event: MediaQueryListEvent) => {
      prefersDark.value = event.matches
    }
    media.addEventListener('change', listener)
    removePreferredColorSchemeListener = () => media.removeEventListener('change', listener)
  }
  void loadAll()
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', updateViewportWidth)
  if (readStatusTimer !== undefined) window.clearInterval(readStatusTimer)
  removeReminderClickListener?.()
  removeExternalDataChangeListener?.()
  removePreferredColorSchemeListener?.()
  removeCatalogProgressListener?.()
})
</script>

<template>
  <n-config-provider :theme="theme" :locale="naiveLocale">
    <div class="window-root">
      <Titlebar
        :title="t('appName')"
        :minimize="() => runWindowControl(windowControls.minimize)"
        :maximize="() => runWindowControl(windowControls.toggleMaximize)"
        :close="() => runWindowControl(windowControls.close)"
      >
        <template #icon><img :src="logoUrl" alt="职迹" /></template>
      </Titlebar>

      <n-layout has-sider class="app-shell">
        <Sidebar v-model:value="activeView" :options="menuOptions" :width="sidebarWidth">
          <template #brand>
            <div class="brand">
              <img class="brand-logo" :src="logoUrl" alt="职迹" />
              <div class="brand-name">{{ t('appName') }}</div>
            </div>
          </template>
        </Sidebar>

        <n-layout>
          <n-layout-content class="content">
            <header class="page-header">
              <div>
                <h1>{{ pageTitle }}</h1>
              </div>
              <n-space>
                <n-button
                  v-if="activeView === 'opportunities'"
                  type="primary"
                  @click="newOpportunity"
                  >{{ t('common.add') }}</n-button
                >
                <n-button
                  v-if="activeView === 'statuses'"
                  type="primary"
                  @click="openStatusEditor()"
                  >{{ t('common.add') }}</n-button
                >
                <n-button
                  v-if="activeView === 'industries'"
                  type="primary"
                  @click="openIndustryEditor()"
                  >{{ t('common.add') }}</n-button
                >
                <n-button v-if="activeView === 'resumes'" type="primary" @click="importResume">{{
                  t('common.import')
                }}</n-button>
                <n-button
                  v-if="activeView === 'companies'"
                  type="primary"
                  @click="openCompanyEditor()"
                  >{{ t('common.add') }}</n-button
                >
              </n-space>
            </header>

            <OpportunitiesView
              v-if="activeView === 'opportunities'"
              :columns="columns"
              :data="opportunities"
              :loading="loading || opportunitiesLoading"
              :pagination="opportunityPagination"
              :search="search"
              :selected-status-id="selectedStatusId"
              :selected-company-id="selectedCompanyId"
              :status-options="statusOptions"
              :company-options="companyOptions"
              :filter-company-option="filterCompanyOption"
              @update:search="search = $event"
              @update:selected-status-id="selectedStatusId = $event"
              @update:selected-company-id="selectedCompanyId = $event"
              @refresh="refreshOpportunities"
            />
            <CalendarView
              v-if="activeView === 'calendar'"
              :month-label="monthLabel"
              :weekdays="weekdays"
              :calendar-days="calendarDays"
              :calendar-month="calendarMonth"
              :selected-calendar-day="selectedCalendarDay"
              :selected-day-events="selectedDayEvents"
              :month-event-count="monthEventCount"
              :events-for-day="eventsForDay"
              :is-same-day="isSameDay"
              :format-date="formatDate"
              :format-event-time="formatEventTime"
              :is-external-url="isExternalUrl"
              :normalize-external-url="normalizeExternalUrl"
              @previous="previousMonth"
              @next="nextMonth"
              @today="goToday"
              @select-day="selectCalendarDay"
              @add-day="newEvent"
              @open-event="openEvent"
              @add="newEvent(selectedCalendarDay)"
              @edit="openEvent"
              @delete="deleteEvent"
              @open-link="openEventLink"
            />
            <StatusesView
              v-if="activeView === 'statuses'"
              :columns="statusColumns"
              :data="statuses"
              :pagination="statusPagination"
            />
            <IndustriesView
              v-if="activeView === 'industries'"
              :columns="industryColumns"
              :data="industries"
              :pagination="industryPagination"
            />
            <ResumesView
              v-if="activeView === 'resumes'"
              :columns="resumeColumns"
              :data="resumes"
              :pagination="resumePagination"
            />
            <CompaniesView
              v-if="activeView === 'companies'"
              :columns="companyColumns"
              :data="managedCompanies"
              :pagination="companyPagination"
              :search="companyManagementSearch"
              :selected-industry-id="selectedCompanyIndustryId"
              :industry-options="industryOptions"
              @update:search="companyManagementSearch = $event"
              @update:selected-industry-id="selectedCompanyIndustryId = $event"
            />
            <SettingsView
              v-if="activeView === 'settings'"
              :config="config"
              :dark="isDarkTheme"
              :mcp-connection-info="mcpConnectionInfo"
              :current-version="currentVersion"
              :checking-for-updates="checkingForUpdates"
              :uninstalling="uninstalling"
              :check-for-updates="checkForUpdates"
              :uninstall-app="uninstallApp"
              :catalog-status="catalogStatus"
              :catalog-modal-visible="catalogModalVisible"
              :catalog-updating="catalogUpdating"
              :catalog-phase="catalogPhase"
              :catalog-progress="catalogProgress"
              :catalog-result="catalogResult"
              :catalog-error="catalogError"
              :update-company-catalog="updateCompanyCatalog"
              :close-catalog-modal="closeCatalogModal"
              @update-config="saveConfig"
              @close-behavior="setCloseBehavior"
              @launch-at-startup="setLaunchAtStartup"
            />
          </n-layout-content>
        </n-layout>
      </n-layout>
    </div>

    <n-modal v-model:show="showOpportunityModal">
      <n-card
        class="opportunity-modal"
        :title="editingOpportunityId ? t('opportunity.edit') : t('opportunity.add')"
        closable
        @close="showOpportunityModal = false"
      >
        <n-form class="opportunity-form" label-placement="top">
          <div class="form-grid two-columns">
            <n-form-item :label="t('opportunity.company')" required
              ><n-select
                v-model:value="opportunityForm.companyId"
                filterable
                :filter="filterCompanyOption"
                :options="companyOptions"
                :placeholder="t('opportunity.noCompany')"
            /></n-form-item>
            <n-form-item :label="t('opportunity.position')" required
              ><n-input
                v-model:value="opportunityForm.title"
                :placeholder="t('opportunity.positionPlaceholder')"
            /></n-form-item>
            <n-form-item :label="t('opportunity.status')" required
              ><n-select
                v-model:value="opportunityForm.statusId"
                :options="statusOptions"
                :placeholder="t('opportunity.statusPlaceholder')"
            /></n-form-item>
            <n-form-item :label="t('opportunity.resume')"
              ><n-select
                v-model:value="opportunityForm.resumeVersionId"
                clearable
                :options="resumeOptions"
                :placeholder="t('opportunity.resumePlaceholder')"
            /></n-form-item>
            <n-form-item :label="t('opportunity.department')"
              ><n-input
                v-model:value="opportunityForm.department"
                :placeholder="t('opportunity.departmentPlaceholder')"
            /></n-form-item>
            <n-form-item :label="t('opportunity.location')"
              ><n-input
                v-model:value="opportunityForm.location"
                :placeholder="t('opportunity.locationPlaceholder')"
            /></n-form-item>
            <n-form-item :label="t('opportunity.source')"
              ><n-input
                v-model:value="opportunityForm.source"
                :placeholder="t('opportunity.sourcePlaceholder')"
            /></n-form-item>
            <n-form-item :label="t('opportunity.url')"
              ><n-input
                v-model:value="opportunityForm.jobUrl"
                :placeholder="t('opportunity.urlPlaceholder')"
            /></n-form-item>
          </div>
          <div class="form-grid three-columns opportunity-date-grid">
            <n-form-item :label="t('opportunity.discoveredAt')"
              ><n-date-picker
                v-model:value="opportunityForm.discoveredAt"
                type="date"
                clearable
                :placeholder="t('opportunity.discoveredAtPlaceholder')"
            /></n-form-item>
            <n-form-item :label="t('opportunity.appliedAt')"
              ><n-date-picker
                v-model:value="opportunityForm.appliedAt"
                type="date"
                clearable
                :placeholder="t('opportunity.appliedAtPlaceholder')"
            /></n-form-item>
            <n-form-item :label="t('opportunity.deadlineAt')"
              ><n-date-picker
                v-model:value="opportunityForm.deadlineAt"
                type="date"
                clearable
                :placeholder="t('opportunity.deadlineAtPlaceholder')"
            /></n-form-item>
          </div>
          <n-form-item :label="t('opportunity.description')"
            ><n-input
              v-model:value="opportunityForm.description"
              type="textarea"
              :placeholder="t('opportunity.descriptionPlaceholder')"
              :autosize="{ minRows: 3, maxRows: 8 }"
          /></n-form-item>
          <n-form-item :label="t('opportunity.notes')"
            ><n-input
              v-model:value="opportunityForm.notes"
              type="textarea"
              :placeholder="t('opportunity.notesPlaceholder')"
              :autosize="{ minRows: 2, maxRows: 5 }"
          /></n-form-item>
        </n-form>
        <template #footer
          ><n-space justify="end"
            ><n-button @click="showOpportunityModal = false">{{ t('common.cancel') }}</n-button
            ><n-button type="primary" @click="saveOpportunity">{{
              t('common.save')
            }}</n-button></n-space
          ></template
        >
      </n-card>
    </n-modal>

    <OpportunityStatusFlowModal
      :show="showStatusFlowModal"
      :opportunity="statusFlowOpportunity"
      :flow="statusFlow"
      :loading="statusFlowLoading"
      :theme="config?.statusFlowTheme ?? 'violet'"
      :theme-saving="statusFlowThemeSaving"
      :dark="isDarkTheme"
      :locale="locale"
      @close="closeStatusFlow"
      @select-theme="setStatusFlowTheme"
    />

    <n-modal v-model:show="showEventModal">
      <n-card
        class="event-modal"
        :title="editingEventId ? t('calendar.edit') : t('calendar.add')"
        closable
        @close="showEventModal = false"
      >
        <n-form label-placement="top">
          <n-form-item :label="t('calendar.eventTitle')" required
            ><n-input
              v-model:value="eventForm.title"
              :placeholder="t('calendar.eventTitlePlaceholder')"
          /></n-form-item>
          <div class="form-grid two-columns">
            <n-form-item :label="t('calendar.eventType')" required
              ><n-select
                v-model:value="eventForm.eventType"
                :options="eventTypeOptions"
                filterable
                tag
                :placeholder="t('calendar.eventTypePlaceholder')"
            /></n-form-item>
            <n-form-item :label="t('calendar.opportunity')"
              ><n-select
                v-model:value="eventForm.opportunityId"
                clearable
                filterable
                :options="
                  allOpportunities.map((item) => ({
                    label: `${item.companyName} · ${item.title}`,
                    value: item.id,
                  }))
                "
                :placeholder="t('calendar.opportunityPlaceholder')"
            /></n-form-item>
            <n-form-item :label="t('calendar.allDay')"
              ><n-radio-group :value="eventForm.isAllDay" @update:value="setEventAllDay"
                ><n-space
                  ><n-radio :value="true">{{ t('common.yes') }}</n-radio
                  ><n-radio :value="false">{{ t('common.no') }}</n-radio></n-space
                ></n-radio-group
              ></n-form-item
            >
            <n-form-item :label="t('calendar.start')"
              ><n-date-picker
                v-model:value="eventForm.startAt"
                :type="eventForm.isAllDay ? 'date' : 'datetime'"
                :placeholder="t('calendar.startPlaceholder')"
            /></n-form-item>
            <n-form-item
              :label="eventForm.isAllDay ? t('calendar.endExclusive') : t('calendar.end')"
              ><n-date-picker
                v-model:value="eventForm.endAt"
                :type="eventForm.isAllDay ? 'date' : 'datetime'"
                :placeholder="t('calendar.endPlaceholder')"
            /></n-form-item>
            <n-form-item :label="t('calendar.reminder')"
              ><n-select
                v-model:value="eventForm.reminderMinutes"
                clearable
                :options="reminderOptions"
                :placeholder="t('calendar.reminderPlaceholder')"
            /></n-form-item>
          </div>
          <n-form-item :label="t('calendar.location')"
            ><n-input
              v-model:value="eventForm.location"
              :placeholder="t('calendar.locationPlaceholder')"
          /></n-form-item>
          <n-form-item :label="t('calendar.description')"
            ><n-input
              v-model:value="eventForm.description"
              type="textarea"
              :placeholder="t('calendar.descriptionPlaceholder')"
          /></n-form-item>
        </n-form>
        <template #footer
          ><n-space justify="end"
            ><n-button @click="showEventModal = false">{{ t('common.cancel') }}</n-button
            ><n-button type="primary" @click="saveEvent">{{ t('common.save') }}</n-button></n-space
          ></template
        >
      </n-card>
    </n-modal>

    <n-modal v-model:show="showIndustryModal">
      <n-card
        class="management-modal"
        :title="editingIndustryId ? t('management.editIndustry') : t('management.addIndustry')"
        closable
        @close="showIndustryModal = false"
      >
        <n-form label-placement="top">
          <n-form-item :label="t('management.industryName')" required>
            <n-input
              v-model:value="industryForm.name"
              :placeholder="t('management.industryNamePlaceholder')"
              @keyup.enter="saveIndustry"
            />
          </n-form-item>
        </n-form>
        <template #footer
          ><n-space justify="end"
            ><n-button @click="showIndustryModal = false">{{ t('common.cancel') }}</n-button
            ><n-button type="primary" @click="saveIndustry">{{
              t('common.save')
            }}</n-button></n-space
          ></template
        >
      </n-card>
    </n-modal>

    <n-modal v-model:show="showStatusModal">
      <n-card
        class="management-modal"
        :title="editingStatusId ? t('management.editStatus') : t('management.addStatus')"
        closable
        @close="showStatusModal = false"
      >
        <n-input
          v-model:value="statusForm.label"
          :placeholder="t('management.statusPlaceholder')"
          @keyup.enter="saveStatus"
        />
        <template #footer
          ><n-space justify="end"
            ><n-button @click="showStatusModal = false">{{ t('common.cancel') }}</n-button
            ><n-button type="primary" @click="saveStatus">{{ t('common.save') }}</n-button></n-space
          ></template
        >
      </n-card>
    </n-modal>

    <n-modal v-model:show="showResumeModal">
      <n-card
        class="management-modal"
        :title="t('management.editResume')"
        closable
        @close="showResumeModal = false"
      >
        <n-form label-placement="top">
          <n-form-item :label="t('management.resumeName')" required>
            <n-input
              v-model:value="resumeForm.name"
              :placeholder="t('management.resumeNamePlaceholder')"
            />
          </n-form-item>
          <n-form-item :label="t('management.resumeNote')">
            <n-input
              v-model:value="resumeForm.note"
              type="textarea"
              :placeholder="t('management.resumeNotePlaceholder')"
            />
          </n-form-item>
        </n-form>
        <template #footer
          ><n-space justify="end"
            ><n-button @click="showResumeModal = false">{{ t('common.cancel') }}</n-button
            ><n-button type="primary" @click="saveResume">{{ t('common.save') }}</n-button></n-space
          ></template
        >
      </n-card>
    </n-modal>

    <n-modal v-model:show="showCompanyModal">
      <n-card
        class="management-modal"
        :title="editingCompanyId ? t('management.editCompany') : t('management.addCompany')"
        closable
        @close="showCompanyModal = false"
      >
        <n-form label-placement="top">
          <n-form-item :label="t('management.companyName')" required>
            <n-input
              v-model:value="companyForm.name"
              :placeholder="t('management.companyNamePlaceholder')"
            />
          </n-form-item>
          <n-form-item :label="t('management.companyIndustry')">
            <n-select
              v-model:value="companyForm.industryIds"
              multiple
              clearable
              filterable
              max-tag-count="responsive"
              :options="industryOptions"
              :placeholder="t('management.companyIndustryPlaceholder')"
            />
          </n-form-item>
          <n-form-item :label="t('management.companyAliases')">
            <div class="company-alias-editor">
              <n-tag
                v-for="(alias, index) in companyForm.aliases"
                :key="alias"
                closable
                round
                @close="removeCompanyAlias(index)"
                >{{ alias }}</n-tag
              >
              <n-input
                v-model:value="companyAliasInput"
                class="company-alias-input"
                :bordered="false"
                :placeholder="
                  companyForm.aliases.length ? '' : t('management.companyAliasesPlaceholder')
                "
                @keydown.enter.prevent="commitCompanyAliasInput"
                @blur="commitCompanyAliasInput"
              />
            </div>
          </n-form-item>
          <n-form-item :label="t('management.companyCareerUrl')">
            <n-input
              v-model:value="companyForm.careerUrl"
              :placeholder="t('management.companyCareerUrlPlaceholder')"
            />
          </n-form-item>
        </n-form>
        <template #footer
          ><n-space justify="end"
            ><n-button @click="showCompanyModal = false">{{ t('common.cancel') }}</n-button
            ><n-button type="primary" @click="saveCompany">{{
              t('common.save')
            }}</n-button></n-space
          ></template
        >
      </n-card>
    </n-modal>
  </n-config-provider>
</template>
