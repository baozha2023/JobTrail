<script setup lang="ts">
import { computed, h, onBeforeUnmount, onMounted, ref, toRaw, watch } from 'vue'
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
  CalendarEvent,
  CalendarReminderNotification,
  Company,
  CloseBehavior,
  CreateCompanyInput,
  CreateIndustryInput,
  CreateCalendarEventInput,
  CreateOpportunityInput,
  Opportunity,
  Industry,
  ResumeVersion,
  Status,
  UpdateResumeVersionInput,
} from '../../shared/types'
import OpportunitiesView from './OpportunitiesView.vue'
import CalendarView from './CalendarView.vue'
import StatusesView from './StatusesView.vue'
import IndustriesView from './IndustriesView.vue'
import ResumesView from './ResumesView.vue'
import CompaniesView from './CompaniesView.vue'
import SettingsView from './SettingsView.vue'
import Sidebar from '../layout/Sidebar.vue'
import Titlebar from '../layout/Titlebar.vue'
import { getErrorMessage } from '../utils/errors'
import { useOpportunitiesStore } from '../stores/opportunities'
import { useCalendarStore } from '../stores/calendar'
import { useStatusesStore } from '../stores/statuses'
import { useIndustriesStore } from '../stores/industries'
import { useResumesStore } from '../stores/resumes'
import { useCompaniesStore } from '../stores/companies'
import { useSettingsStore } from '../stores/settings'

type ViewKey = 'opportunities' | 'calendar' | 'statuses' | 'industries' | 'resumes' | 'companies' | 'settings'
type CompanyForm = Omit<CreateCompanyInput, 'aliases' | 'industryIds'> & { industryIds: number[]; aliases: string[] }

const { t, locale } = useI18n()
const windowControls = window.windowControlsApi
const opportunitiesStore = useOpportunitiesStore()
const calendarStore = useCalendarStore()
const statusesStore = useStatusesStore()
const industriesStore = useIndustriesStore()
const resumesStore = useResumesStore()
const companiesStore = useCompaniesStore()
const settingsStore = useSettingsStore()
const { items: opportunities, loading: opportunitiesLoading } = storeToRefs(opportunitiesStore)
const { items: events } = storeToRefs(calendarStore)
const { items: statuses } = storeToRefs(statusesStore)
const { items: industries } = storeToRefs(industriesStore)
const { items: resumes } = storeToRefs(resumesStore)
const { items: companies } = storeToRefs(companiesStore)
const { config } = storeToRefs(settingsStore)
const viewportWidth = ref(window.innerWidth)
const activeView = ref<ViewKey>('opportunities')
const search = ref('')
const selectedStatusId = ref<number | null>(null)
const selectedCompanyId = ref<number | null>(null)
const showOpportunityModal = ref(false)
const editingOpportunityId = ref<number | null>(null)
const showEventModal = ref(false)
const editingEventId = ref<number | null>(null)
const loading = ref(false)
const showStatusModal = ref(false)
const editingStatusId = ref<number | null>(null)
const statusForm = ref({ label: '' })
const showResumeModal = ref(false)
const editingResumeId = ref<number | null>(null)
const resumeForm = ref<UpdateResumeVersionInput>({ name: '', note: null })
const showCompanyModal = ref(false)
const editingCompanyId = ref<number | null>(null)
const companyManagementSearch = ref('')
const companyAliasInput = ref('')
const companyForm = ref<CompanyForm>({ name: '', industryIds: [], careerUrl: null, aliases: [] })
const showIndustryModal = ref(false)
const editingIndustryId = ref<number | null>(null)
const industryForm = ref<CreateIndustryInput>({ name: '' })
const calendarMonth = ref(new Date(new Date().getFullYear(), new Date().getMonth(), 1))
const selectedCalendarDay = ref(new Date())
const updateInfo = ref<import('velopack').UpdateInfo | null>(null)
const checkingForUpdates = ref(false)
const currentVersion = ref('0.2.0')
const uninstalling = ref(false)
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
    onUpdatePage: (nextPage: number) => { page.value = nextPage },
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

const opportunityForm = ref<CreateOpportunityInput>({
  companyId: 0, title: '', department: null, location: null, source: null, jobUrl: null,
  description: null, statusId: 0, resumeVersionId: null, discoveredAt: Date.now(), appliedAt: null, deadlineAt: null, notes: null,
})

const eventForm = ref<CreateCalendarEventInput>({
  title: '', eventType: 'other', startAt: Date.now(), endAt: Date.now() + 60 * 60 * 1000,
  isAllDay: false, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, location: null, description: null, reminderMinutes: null,
})

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
const sidebarWidth = computed(() => Math.min(220, Math.max(168, Math.round(viewportWidth.value * 0.145))))

const statusOptions = computed(() => statuses.value.map((item) => ({ label: item.label, value: item.id })))
const industryOptions = computed(() => industries.value.map((item) => ({ label: item.name, value: item.id })))
const companyOptions = computed(() => companies.value.map((item) => ({ label: item.name, value: item.id })))
const resumeOptions = computed(() => resumes.value.map((item) => ({ label: item.name, value: item.id })))
const managedCompanies = computed(() => {
  const keyword = companyManagementSearch.value.trim().toLocaleLowerCase()
  if (!keyword) return companies.value
  return companies.value.filter((company) => [company.name, company.industryName, company.careerUrl, ...company.aliases]
    .some((value) => value?.toLocaleLowerCase().includes(keyword)))
})
const eventTypeOptions = computed(() => [
  { label: t('calendar.types.interview'), value: 'interview' },
  { label: t('calendar.types.writtenTest'), value: 'written_test' },
  { label: t('calendar.types.deadline'), value: 'deadline' },
  { label: t('calendar.types.reminder'), value: 'reminder' },
  { label: t('calendar.types.other'), value: 'other' },
])
const reminderOptions = computed(() => [
  { label: t('calendar.reminder5Minutes'), value: 5 },
  { label: t('calendar.reminder10Minutes'), value: 10 },
  { label: t('calendar.reminder15Minutes'), value: 15 },
  { label: t('calendar.reminder30Minutes'), value: 30 },
  { label: t('calendar.reminder1Hour'), value: 60 },
  { label: t('calendar.reminder2Hours'), value: 120 },
  { label: t('calendar.reminder1Day'), value: 1440 },
])
const weekdays = computed(() => locale.value === 'zh-CN' ? ['日', '一', '二', '三', '四', '五', '六'] : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'])
const selectedDayEvents = computed(() => eventsForDay(selectedCalendarDay.value))
const monthEventCount = computed(() => events.value.filter((event) => {
  const date = new Date(event.startAt)
  return date.getFullYear() === calendarMonth.value.getFullYear() && date.getMonth() === calendarMonth.value.getMonth()
}).length)

const theme = computed(() => {
  const isDark = config.value?.themeMode === 'dark' || (config.value?.themeMode === 'system' && prefersDark.value)
  return isDark ? darkTheme : lightTheme
})
const naiveLocale = computed(() => locale.value === 'zh-CN' ? zhCN : enUS)
const { message } = createDiscreteApi(['message'], {
  configProviderProps: computed(() => ({ theme: theme.value, locale: naiveLocale.value })),
})

const columns = computed<DataTableColumns<Opportunity>>(() => [
  { title: t('opportunity.company'), key: 'companyName', width: '15%', ellipsis: { tooltip: true } },
  { title: t('opportunity.position'), key: 'title', width: '22%', ellipsis: { tooltip: true } },
  {
    title: t('opportunity.status'), key: 'statusLabel', width: '13%',
    render: (row) => h(NTag, { type: row.statusLabel === 'Offer' ? 'success' : 'info', bordered: false }, { default: () => row.statusLabel }),
  },
  { title: t('opportunity.appliedAt'), key: 'appliedAt', width: '15%', render: (row) => formatDate(row.appliedAt) },
  {
    title: t('opportunity.url'), key: 'jobUrl', width: '18%', ellipsis: { tooltip: true },
    render: (row) => row.jobUrl
      ? h('a', {
          class: 'external-link', href: normalizeExternalUrl(row.jobUrl), title: row.jobUrl,
          onClick: (event: MouseEvent) => { event.preventDefault(); openEventLink(row.jobUrl) },
        }, row.jobUrl)
      : '—',
  },
  {
    title: t('common.edit'), key: 'actions', width: '17%',
    render: (row) => h(NSpace, { size: 8, wrap: true }, {
      default: () => [
        h(NButton, { size: 'small', onClick: () => openOpportunity(row) }, { default: () => t('common.edit') }),
        h(NPopconfirm, { onPositiveClick: () => deleteOpportunity(row.id) }, {
          trigger: () => h(NButton, { size: 'small', tertiary: true, type: 'error' }, { default: () => t('common.delete') }),
          default: () => t('opportunity.deleteConfirm'),
        }),
      ],
    }),
  },
])

const statusColumns = computed<DataTableColumns<Status>>(() => [
  {
    title: '', key: 'order', width: '12%',
    render: (row) => orderControls(row.id, statuses.value, moveStatus),
  },
  { title: t('management.statusName'), key: 'label', width: '68%', ellipsis: { tooltip: true } },
  {
    title: t('common.edit'), key: 'actions', width: '20%',
    render: (row) => row.isBuiltin && !isDevelopment.value ? h('span', { class: 'muted-text', title: t('management.builtinLocked') }, '—') : h(NSpace, { size: 8, wrap: true }, {
      default: () => [
        h(NButton, { size: 'small', onClick: () => openStatusEditor(row) }, { default: () => t('common.edit') }),
        h(NPopconfirm, { onPositiveClick: () => deleteStatus(row) }, {
          trigger: () => h(NButton, { size: 'small', tertiary: true, type: 'error' }, { default: () => t('common.delete') }),
          default: () => t('management.statusDeleteConfirm'),
        }),
      ],
    }),
  },
])

const industryColumns = computed<DataTableColumns<Industry>>(() => [
  {
    title: '', key: 'order', width: '12%',
    render: (row) => orderControls(row.id, industries.value, moveIndustry),
  },
  { title: t('management.industryName'), key: 'name', width: '68%', ellipsis: { tooltip: true } },
  {
    title: t('common.edit'), key: 'actions', width: '20%',
    render: (row) => row.isBuiltin && !isDevelopment.value ? h('span', { class: 'muted-text', title: t('management.builtinLocked') }, '—') : h(NSpace, { size: 8, wrap: true }, {
      default: () => [
        h(NButton, { size: 'small', onClick: () => openIndustryEditor(row) }, { default: () => t('common.edit') }),
        h(NPopconfirm, { onPositiveClick: () => deleteIndustry(row) }, {
          trigger: () => h(NButton, { size: 'small', tertiary: true, type: 'error' }, { default: () => t('common.delete') }),
          default: () => t('management.industryDeleteConfirm'),
        }),
      ],
    }),
  },
])

const resumeColumns = computed<DataTableColumns<ResumeVersion>>(() => [
  {
    title: '', key: 'order', width: '12%',
    render: (row) => orderControls(row.id, resumes.value, moveResume),
  },
  { title: t('management.resumeName'), key: 'name', width: '17%', ellipsis: { tooltip: true } },
  { title: t('management.resumeFile'), key: 'relativePath', width: '23%', ellipsis: { tooltip: true } },
  {
    title: t('management.resumeSize'), key: 'sizeBytes', width: '10%',
    render: (row) => row.sizeBytes ? `${Math.ceil(row.sizeBytes / 1024)} KB` : '—',
  },
  { title: t('management.resumeNote'), key: 'note', width: '19%', ellipsis: { tooltip: true }, render: (row) => row.note ?? '—' },
  {
    title: t('common.edit'), key: 'actions', width: '19%',
    render: (row) => h(NSpace, { size: 8, wrap: true }, {
      default: () => [
        h(NButton, { size: 'small', onClick: () => openResumeEditor(row) }, { default: () => t('common.edit') }),
        h(NButton, { size: 'small', onClick: () => openResume(row.id) }, { default: () => t('common.open') }),
        h(NPopconfirm, { onPositiveClick: () => deleteResume(row) }, {
          trigger: () => h(NButton, { size: 'small', tertiary: true, type: 'error' }, { default: () => t('common.delete') }),
          default: () => t('management.resumeDeleteConfirm'),
        }),
      ],
    }),
  },
])

const companyColumns = computed<DataTableColumns<Company>>(() => [
  { title: t('management.companyName'), key: 'name', width: '18%', ellipsis: { tooltip: true } },
  { title: t('management.companyIndustry'), key: 'industryName', width: '14%', ellipsis: { tooltip: true }, render: (row) => row.industryName ?? '—' },
  {
    title: t('management.companyCareerUrl'), key: 'careerUrl', width: '30%', ellipsis: { tooltip: true },
    render: (row) => {
      const url = row.careerUrl
      return url ? h('a', {
        class: 'external-link', href: url, title: url,
        onClick: (event: MouseEvent) => { event.preventDefault(); void openCompanyCareerLink(row) },
      }, url) : '—'
    },
  },
  {
    title: t('management.companyReadStatus'), key: 'readStatus', width: '12%',
    render: (row) => h(NTag, { type: isCompanyRead(row) ? 'success' : 'warning', bordered: false }, { default: () => isCompanyRead(row) ? t('management.readTag') : t('management.unreadTag') }),
  },
  {
    title: t('management.companyFavorite'), key: 'isFavorite', width: '8%',
    render: (row) => h(NButton, {
      circle: true,
      quaternary: true,
      size: 'small',
      type: row.isFavorite ? 'warning' : 'default',
      title: row.isFavorite ? t('management.unfavorite') : t('management.favorite'),
      'aria-label': row.isFavorite ? t('management.unfavorite') : t('management.favorite'),
      class: 'favorite-button',
      onClick: () => toggleCompanyFavorite(row),
    }, { default: () => h('svg', {
      class: ['favorite-svg', { active: row.isFavorite }],
      viewBox: '0 0 24 24',
      'aria-hidden': 'true',
    }, [h('path', { d: 'M12 3.75l2.57 5.2 5.74.83-4.15 4.05.98 5.72L12 16.85l-5.14 2.7.98-5.72-4.15-4.05 5.74-.83L12 3.75z' })]) }),
  },
  {
    title: t('common.edit'), key: 'actions', width: '18%',
    render: (row) => row.isBuiltin && !isDevelopment.value ? h('span', { class: 'muted-text', title: t('management.builtinLocked') }, '—') : h(NSpace, { size: 8, wrap: true }, {
      default: () => [
        h(NButton, { size: 'small', onClick: () => openCompanyEditor(row) }, { default: () => t('common.edit') }),
        h(NPopconfirm, { onPositiveClick: () => deleteCompany(row) }, {
          trigger: () => h(NButton, { size: 'small', tertiary: true, type: 'error' }, { default: () => t('common.delete') }),
          default: () => t('management.companyDeleteConfirm'),
        }),
      ],
    }),
  },
])

const monthLabel = computed(() => new Intl.DateTimeFormat(locale.value, { year: 'numeric', month: 'long' }).format(calendarMonth.value))
const calendarDays = computed(() => {
  const first = calendarMonth.value
  const start = new Date(first.getFullYear(), first.getMonth(), 1 - first.getDay())
  return Array.from({ length: 42 }, (_, index) => {
    const day = new Date(start)
    day.setDate(start.getDate() + index)
    return day
  })
})

function formatDate(timestamp: number | null): string {
  if (!timestamp) return '—'
  return new Intl.DateTimeFormat(locale.value, { year: 'numeric', month: '2-digit', day: '2-digit' }).format(timestamp)
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat(locale.value, { hour: '2-digit', minute: '2-digit' }).format(timestamp)
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
  const label = typeof option.label === 'string' ? option.label : company?.name ?? ''
  return [label, ...(company?.aliases ?? [])].some((value) => value.toLocaleLowerCase().includes(keyword))
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

function eventsForDay(day: Date): CalendarEvent[] {
  return events.value.filter((event) => isSameDay(new Date(event.startAt), day))
}

function selectCalendarDay(day: Date): void {
  selectedCalendarDay.value = day
  if (day.getFullYear() !== calendarMonth.value.getFullYear() || day.getMonth() !== calendarMonth.value.getMonth()) {
    calendarMonth.value = new Date(day.getFullYear(), day.getMonth(), 1)
  }
}

const eventTypeTranslationKeys = {
  interview: 'interview', written_test: 'writtenTest', deadline: 'deadline', reminder: 'reminder', other: 'other',
} as const

function eventTypeLabel(eventType: string): string {
  const type = eventTypeTranslationKeys[eventType as keyof typeof eventTypeTranslationKeys] ?? eventTypeTranslationKeys.other
  return t(`calendar.types.${type}`)
}

const eventTagTypes = {
  interview: 'info', written_test: 'warning', deadline: 'error', reminder: 'success', other: 'default',
} as const

function eventTypeTagType(eventType: string): typeof eventTagTypes[keyof typeof eventTagTypes] {
  return eventTagTypes[eventType as keyof typeof eventTagTypes] ?? eventTagTypes.other
}

function orderControls<T extends { id: number }>(id: number, items: T[], move: (id: number, offset: number) => Promise<void>) {
  const index = items.findIndex((item) => item.id === id)
  return h('div', { class: 'order-controls' }, [
    h(NButton, {
      circle: true,
      quaternary: true,
      size: 'small',
      class: 'order-arrow-button',
      disabled: index <= 0,
      title: t('management.moveUp'),
      'aria-label': t('management.moveUp'),
      onClick: () => { void move(id, -1) },
    }, { default: () => h('span', { class: 'order-arrow' }, '↑') }),
    h(NButton, {
      circle: true,
      quaternary: true,
      size: 'small',
      class: 'order-arrow-button',
      disabled: index < 0 || index >= items.length - 1,
      title: t('management.moveDown'),
      'aria-label': t('management.moveDown'),
      onClick: () => { void move(id, 1) },
    }, { default: () => h('span', { class: 'order-arrow' }, '↓') }),
  ])
}

function errorMessage(error: unknown): string {
  return getErrorMessage(error, t)
}

function showError(error: unknown): void {
  message.error(errorMessage(error))
}

function serializeDto<T extends object>(value: T): T {
  return structuredClone(toRaw(value))
}

async function openExternal(url: string): Promise<void> {
  try { await window.zhijiApi.system.openExternal(url) } catch (error) { showError(error) }
}

async function openCompanyCareerLink(company: Company): Promise<void> {
  if (!company.careerUrl) return
  try {
    const updated = await window.zhijiApi.companies.markRead(company.id)
    companies.value = companies.value.map((item) => item.id === updated.id ? updated : item)
    await openExternal(normalizeExternalUrl(company.careerUrl))
  } catch (error) { showError(error) }
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

async function moveStatus(id: number, offset: number): Promise<void> {
  const reordered = statuses.value.map((status) => status.id)
  const index = reordered.indexOf(id)
  const target = index + offset
  if (index < 0 || target < 0 || target >= reordered.length) return
  ;[reordered[index], reordered[target]] = [reordered[target], reordered[index]]
  try {
    statuses.value = await window.zhijiApi.statuses.reorder(reordered)
    message.success(t('feedback.reorderSuccess'))
  } catch (error) { showError(error) }
}

async function moveIndustry(id: number, offset: number): Promise<void> {
  const reordered = industries.value.map((industry) => industry.id)
  const index = reordered.indexOf(id)
  const target = index + offset
  if (index < 0 || target < 0 || target >= reordered.length) return
  ;[reordered[index], reordered[target]] = [reordered[target], reordered[index]]
  try {
    industries.value = await window.zhijiApi.industries.reorder(reordered)
    message.success(t('feedback.reorderSuccess'))
  } catch (error) { showError(error) }
}

async function moveResume(id: number, offset: number): Promise<void> {
  const reordered = resumes.value.map((resume) => resume.id)
  const index = reordered.indexOf(id)
  const target = index + offset
  if (index < 0 || target < 0 || target >= reordered.length) return
  ;[reordered[index], reordered[target]] = [reordered[target], reordered[index]]
  try {
    resumes.value = await window.zhijiApi.resumes.reorder(reordered)
    message.success(t('feedback.reorderSuccess'))
  } catch (error) { showError(error) }
}

function updateViewportWidth(): void {
  viewportWidth.value = window.innerWidth
}

async function loadAll(): Promise<void> {
  loading.value = true
  const results = await Promise.allSettled([
    settingsStore.load(), window.velopackApi.getVersion(), statusesStore.load(),
    industriesStore.load(), resumesStore.load(), companiesStore.load(), window.zhijiApi.system.isDevelopment(),
  ])
  const [configResult, versionResult, statusResult, industryResult, resumeResult, companyResult, developmentResult] = results
  if (configResult.status === 'fulfilled' && config.value) locale.value = config.value.locale
  else if (configResult.status === 'rejected') showError(configResult.reason)
  if (versionResult.status === 'fulfilled') { currentVersion.value = versionResult.value } else { showError(versionResult.reason) }
  if (statusResult.status === 'rejected') showError(statusResult.reason)
  if (industryResult.status === 'rejected') showError(industryResult.reason)
  if (resumeResult.status === 'rejected') showError(resumeResult.reason)
  if (companyResult.status === 'rejected') showError(companyResult.reason)
  if (developmentResult.status === 'fulfilled') isDevelopment.value = developmentResult.value
  else showError(developmentResult.reason)
  await Promise.allSettled([loadOpportunities(), loadCalendar()]).then((settled) => settled.forEach((result) => { if (result.status === 'rejected') showError(result.reason) }))
  loading.value = false
}

async function loadOpportunities(): Promise<void> {
  await opportunitiesStore.load({
    search: search.value,
    statusId: selectedStatusId.value,
    companyId: selectedCompanyId.value,
  })
}

async function loadCalendar(): Promise<void> {
  const month = calendarMonth.value
  const start = new Date(month.getFullYear(), month.getMonth(), 1 - month.getDay())
  const end = new Date(start)
  end.setDate(start.getDate() + 42)
  await calendarStore.load({ startAt: start.getTime(), endAt: end.getTime() })
}

async function loadCompanies(): Promise<void> {
  await companiesStore.load()
}

function newOpportunity(): void {
  editingOpportunityId.value = null
  opportunityForm.value = {
    companyId: companies.value[0]?.id ?? 0, title: '', department: null, location: null, source: null,
    jobUrl: null, description: null, statusId: statuses.value.find((item) => item.label === '待投递')?.id ?? statuses.value[0]?.id ?? 0,
    resumeVersionId: null, discoveredAt: Date.now(), appliedAt: null, deadlineAt: null, notes: null,
  }
  showOpportunityModal.value = true
}

function openOpportunity(row: Opportunity): void {
  editingOpportunityId.value = row.id
  opportunityForm.value = {
    companyId: row.companyId, title: row.title, department: row.department, location: row.location, source: row.source,
    jobUrl: row.jobUrl, description: row.description, statusId: row.statusId, resumeVersionId: row.resumeVersionId,
    discoveredAt: row.discoveredAt, appliedAt: row.appliedAt, deadlineAt: row.deadlineAt, notes: row.notes,
  }
  showOpportunityModal.value = true
}

async function saveOpportunity(): Promise<void> {
  if (!opportunityForm.value.companyId || !opportunityForm.value.title.trim() || !opportunityForm.value.statusId) {
    message.error(t('error.required'))
    return
  }
  try {
  const isEditing = editingOpportunityId.value !== null
    const input = serializeDto(opportunityForm.value)
    if (isEditing) await window.zhijiApi.opportunities.update(editingOpportunityId.value!, input)
    else await window.zhijiApi.opportunities.create(input)
    showOpportunityModal.value = false
    await loadOpportunities()
    message.success(t(isEditing ? 'feedback.editSuccess' : 'feedback.addSuccess'))
  } catch (error) { showError(error) }
}

async function deleteOpportunity(id: number): Promise<void> {
  try {
    await window.zhijiApi.opportunities.delete(id)
    await Promise.all([loadOpportunities(), loadCalendar()])
    message.success(t('feedback.deleteSuccess'))
  } catch (error) { showError(error) }
}

function newEvent(day = selectedCalendarDay.value): void {
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 10, 0, 0)
  editingEventId.value = null
  eventForm.value = {
    title: '', eventType: 'other', startAt: start.getTime(), endAt: start.getTime() + 60 * 60 * 1000,
    isAllDay: false, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, location: null, description: null, reminderMinutes: null,
  }
  showEventModal.value = true
}

function openEvent(event: CalendarEvent): void {
  editingEventId.value = event.id
  eventForm.value = {
    opportunityId: event.opportunityId, title: event.title, eventType: event.eventType, startAt: event.startAt, endAt: event.endAt,
    isAllDay: event.isAllDay, timezone: event.timezone, location: event.location, description: event.description, reminderMinutes: event.reminderMinutes,
  }
  showEventModal.value = true
}

async function openCalendarEventFromReminder(notification: CalendarReminderNotification): Promise<void> {
  try {
    const day = new Date(notification.startAt)
    activeView.value = 'calendar'
    selectedCalendarDay.value = day
    calendarMonth.value = new Date(day.getFullYear(), day.getMonth(), 1)
    await loadCalendar()
    const event = events.value.find((item) => item.id === notification.eventId)
    if (event) openEvent(event)
    else message.error(t('calendar.eventNotFound'))
  } catch (error) { showError(error) }
}

async function saveEvent(): Promise<void> {
  if (!eventForm.value.title.trim()) { message.error(t('error.required')); return }
  try {
  const isEditing = editingEventId.value !== null
    const input = serializeDto(eventForm.value)
    if (isEditing) await window.zhijiApi.calendar.update(editingEventId.value!, input)
    else await window.zhijiApi.calendar.create(input)
    showEventModal.value = false
    await loadCalendar()
    message.success(t(isEditing ? 'feedback.editSuccess' : 'feedback.addSuccess'))
  } catch (error) { showError(error) }
}

async function deleteEvent(id: number): Promise<void> {
  try {
    await window.zhijiApi.calendar.delete(id)
    await loadCalendar()
    message.success(t('feedback.deleteSuccess'))
  } catch (error) { showError(error) }
}

async function completeEvent(event: CalendarEvent): Promise<void> {
  try {
    await window.zhijiApi.calendar.complete(event.id, !event.isCompleted)
    await loadCalendar()
    message.success(t('feedback.completeSuccess'))
  } catch (error) { showError(error) }
}

function previousMonth(): void { calendarMonth.value = new Date(calendarMonth.value.getFullYear(), calendarMonth.value.getMonth() - 1, 1) }
function nextMonth(): void { calendarMonth.value = new Date(calendarMonth.value.getFullYear(), calendarMonth.value.getMonth() + 1, 1) }
function goToday(): void { const today = new Date(); calendarMonth.value = new Date(today.getFullYear(), today.getMonth(), 1); selectedCalendarDay.value = today }

async function saveConfig(input: Partial<AppConfig>): Promise<void> {
  if (!config.value) return
  try {
    await settingsStore.update(input)
    if (!config.value) return
    locale.value = config.value.locale
    message.success(t('feedback.saveSuccess'))
  } catch (error) { showError(error) }
}

function setCloseBehavior(value: CloseBehavior): void {
  void saveConfig({ closeBehavior: value })
}

function setLaunchAtStartup(value: boolean): void {
  void saveConfig({ launchAtStartup: value })
}

function openStatusEditor(status?: Status): void {
  editingStatusId.value = status?.id ?? null
  statusForm.value = { label: status?.label ?? '' }
  showStatusModal.value = true
}

async function saveStatus(): Promise<void> {
  if (!statusForm.value.label.trim()) { message.error(t('error.required')); return }
  try {
  const isEditing = editingStatusId.value !== null
    const input = serializeDto(statusForm.value)
    if (isEditing) await window.zhijiApi.statuses.update(editingStatusId.value!, input)
    else await window.zhijiApi.statuses.create(input)
    statuses.value = await window.zhijiApi.statuses.list()
    showStatusModal.value = false
    await loadOpportunities()
    message.success(t(isEditing ? 'feedback.editSuccess' : 'feedback.addSuccess'))
  } catch (error) { showError(error) }
}

async function deleteStatus(status: Status): Promise<void> {
  try {
    await window.zhijiApi.statuses.delete(status.id)
    statuses.value = statuses.value.filter((item) => item.id !== status.id)
    await loadOpportunities()
    message.success(t('feedback.deleteSuccess'))
  } catch (error) { showError(error) }
}

async function importResume(): Promise<void> {
  try {
    const result = await window.zhijiApi.resumes.import()
    if (result) {
      resumes.value = await window.zhijiApi.resumes.list()
      message.success(t('feedback.importSuccess'))
    }
  } catch (error) { showError(error) }
}

function openResumeEditor(resume: ResumeVersion): void {
  editingResumeId.value = resume.id
  resumeForm.value = { name: resume.name, note: resume.note }
  showResumeModal.value = true
}

async function saveResume(): Promise<void> {
  if (!resumeForm.value.name?.trim() || !editingResumeId.value) { message.error(t('error.required')); return }
  try {
    await window.zhijiApi.resumes.update(editingResumeId.value, serializeDto(resumeForm.value))
    resumes.value = await window.zhijiApi.resumes.list()
    showResumeModal.value = false
    await loadOpportunities()
    message.success(t('feedback.editSuccess'))
  } catch (error) { showError(error) }
}

async function deleteResume(resume: ResumeVersion): Promise<void> {
  try {
    await window.zhijiApi.resumes.delete(resume.id)
    resumes.value = await window.zhijiApi.resumes.list()
    message.success(t('feedback.deleteSuccess'))
  } catch (error) { showError(error) }
}

async function openResume(id: number): Promise<void> {
  try { await window.zhijiApi.resumes.open(id) } catch (error) { showError(error) }
}

function openIndustryEditor(industry?: Industry): void {
  editingIndustryId.value = industry?.id ?? null
  industryForm.value = { name: industry?.name ?? '' }
  showIndustryModal.value = true
}

async function saveIndustry(): Promise<void> {
  if (!industryForm.value.name.trim()) { message.error(t('error.required')); return }
  try {
  const isEditing = editingIndustryId.value !== null
    const input = serializeDto(industryForm.value)
    if (isEditing) await window.zhijiApi.industries.update(editingIndustryId.value!, input)
    else await window.zhijiApi.industries.create(input)
    industries.value = await window.zhijiApi.industries.list()
    await loadCompanies()
    showIndustryModal.value = false
    message.success(t(isEditing ? 'feedback.editSuccess' : 'feedback.addSuccess'))
  } catch (error) { showError(error) }
}

async function deleteIndustry(industry: Industry): Promise<void> {
  try {
    await window.zhijiApi.industries.delete(industry.id)
    industries.value = await window.zhijiApi.industries.list()
    message.success(t('feedback.deleteSuccess'))
  } catch (error) { showError(error) }
}

function openCompanyEditor(company?: Company): void {
  editingCompanyId.value = company?.id ?? null
  companyForm.value = {
    name: company?.name ?? '',
    industryIds: [...company?.industryIds ?? []],
    careerUrl: company?.careerUrl ?? null,
    aliases: normalizeAliases(company?.aliases ?? []),
  }
  companyAliasInput.value = ''
  showCompanyModal.value = true
}

function normalizeAliases(values: string[]): string[] {
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))]
}

function commitCompanyAliasInput(): void {
  const pendingAliases = companyAliasInput.value.split(/[,，\n]/)
  companyForm.value.aliases = normalizeAliases([...companyForm.value.aliases, ...pendingAliases])
  companyAliasInput.value = ''
}

function removeCompanyAlias(index: number): void {
  companyForm.value.aliases = companyForm.value.aliases.filter((_alias, aliasIndex) => aliasIndex !== index)
}

async function saveCompany(): Promise<void> {
  if (!companyForm.value.name.trim()) { message.error(t('error.required')); return }
  const input = {
    name: companyForm.value.name,
    industryIds: [...companyForm.value.industryIds],
    careerUrl: companyForm.value.careerUrl,
    aliases: normalizeAliases(companyForm.value.aliases),
  }
  try {
  const isEditing = editingCompanyId.value !== null
    if (isEditing) await window.zhijiApi.companies.update(editingCompanyId.value!, input)
    else await window.zhijiApi.companies.create(input)
    await loadCompanies()
    showCompanyModal.value = false
    message.success(t(isEditing ? 'feedback.editSuccess' : 'feedback.addSuccess'))
  } catch (error) { showError(error) }
}

async function toggleCompanyFavorite(company: Company): Promise<void> {
  try {
    await window.zhijiApi.companies.update(company.id, { isFavorite: !company.isFavorite })
    await loadCompanies()
    message.success(t(company.isFavorite ? 'feedback.unfavoriteSuccess' : 'feedback.favoriteSuccess'))
  } catch (error) { showError(error) }
}

async function deleteCompany(company: Company): Promise<void> {
  try {
    await window.zhijiApi.companies.delete(company.id)
    await Promise.all([loadCompanies(), loadOpportunities()])
    message.success(t('feedback.deleteSuccess'))
  } catch (error) { showError(error) }
}

async function checkForUpdates(): Promise<void> {
  if (checkingForUpdates.value) return
  if (isDevelopment.value) {
    message.info(t('settings.updateUnavailableDevelopment'))
    return
  }
  checkingForUpdates.value = true
  let statusMessage: { destroy: () => void } | null = message.loading(t('settings.checking'), { duration: 0 })
  try {
    updateInfo.value = await window.velopackApi.checkForUpdates()
    statusMessage.destroy()
    statusMessage = null
    if (!updateInfo.value) {
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
    message.error(t(result === 'development' ? 'settings.uninstallDevelopment' : 'settings.uninstallUnavailable'))
  } catch (error) {
    showError(error)
  } finally {
    if (!started) uninstalling.value = false
  }
}

watch([search, selectedStatusId, selectedCompanyId], () => { void loadOpportunities().catch(showError) })
watch(calendarMonth, () => { void loadCalendar().catch(showError) })

let removeReminderClickListener: (() => void) | undefined
let readStatusTimer: number | undefined
let removePreferredColorSchemeListener: (() => void) | undefined
onMounted(() => {
  window.addEventListener('resize', updateViewportWidth)
  readStatusTimer = window.setInterval(() => { currentTime.value = Date.now() }, 60_000)
  removeReminderClickListener = window.zhijiApi.calendar.onReminderClick((notification) => {
    void openCalendarEventFromReminder(notification)
  })
  if (window.matchMedia) {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    prefersDark.value = media.matches
    const listener = (event: MediaQueryListEvent) => { prefersDark.value = event.matches }
    media.addEventListener('change', listener)
    removePreferredColorSchemeListener = () => media.removeEventListener('change', listener)
  }
  void loadAll()
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', updateViewportWidth)
  if (readStatusTimer !== undefined) window.clearInterval(readStatusTimer)
  removeReminderClickListener?.()
  removePreferredColorSchemeListener?.()
})
</script>

<template>
  <n-config-provider :theme="theme" :locale="naiveLocale">
    <div class="window-root">
      <Titlebar :title="t('appName')" :minimize="windowControls.minimize" :maximize="windowControls.toggleMaximize" :close="windowControls.close">
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
              <n-button v-if="activeView === 'opportunities'" type="primary" @click="newOpportunity">{{ t('common.add') }}</n-button>
              <n-button v-if="activeView === 'statuses'" type="primary" @click="openStatusEditor()">{{ t('common.add') }}</n-button>
              <n-button v-if="activeView === 'industries'" type="primary" @click="openIndustryEditor()">{{ t('common.add') }}</n-button>
              <n-button v-if="activeView === 'resumes'" type="primary" @click="importResume">{{ t('common.import') }}</n-button>
              <n-button v-if="activeView === 'companies'" type="primary" @click="openCompanyEditor()">{{ t('common.add') }}</n-button>
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
            @refresh="loadOpportunities"
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
            :format-time="formatTime"
            :event-type-label="eventTypeLabel"
            :event-type-tag-type="eventTypeTagType"
            :is-external-url="isExternalUrl"
            :normalize-external-url="normalizeExternalUrl"
            @previous="previousMonth"
            @next="nextMonth"
            @today="goToday"
            @select-day="selectCalendarDay"
            @add-day="newEvent"
            @open-event="openEvent"
            @add="newEvent(selectedCalendarDay)"
            @complete="completeEvent"
            @edit="openEvent"
            @delete="deleteEvent"
            @open-link="openEventLink"
          />
          <StatusesView v-if="activeView === 'statuses'" :columns="statusColumns" :data="statuses" :pagination="statusPagination" />
          <IndustriesView v-if="activeView === 'industries'" :columns="industryColumns" :data="industries" :pagination="industryPagination" />
          <ResumesView v-if="activeView === 'resumes'" :columns="resumeColumns" :data="resumes" :pagination="resumePagination" />
          <CompaniesView v-if="activeView === 'companies'" :columns="companyColumns" :data="managedCompanies" :pagination="companyPagination" :search="companyManagementSearch" @update:search="companyManagementSearch = $event" />
            <SettingsView v-if="activeView === 'settings'" :config="config" :current-version="currentVersion" :checking-for-updates="checkingForUpdates" :uninstalling="uninstalling" :check-for-updates="checkForUpdates" :uninstall-app="uninstallApp" @update-config="saveConfig" @close-behavior="setCloseBehavior" @launch-at-startup="setLaunchAtStartup" />

        </n-layout-content>
      </n-layout>
      </n-layout>
    </div>

    <n-modal v-model:show="showOpportunityModal">
      <n-card class="opportunity-modal" :title="editingOpportunityId ? t('opportunity.edit') : t('opportunity.add')" closable @close="showOpportunityModal = false">
        <n-form class="opportunity-form" label-placement="top">
          <div class="form-grid two-columns">
            <n-form-item :label="t('opportunity.company')" required><n-select v-model:value="opportunityForm.companyId" filterable :filter="filterCompanyOption" :options="companyOptions" :placeholder="t('opportunity.noCompany')" /></n-form-item>
            <n-form-item :label="t('opportunity.position')" required><n-input v-model:value="opportunityForm.title" :placeholder="t('opportunity.positionPlaceholder')" /></n-form-item>
            <n-form-item :label="t('opportunity.status')" required><n-select v-model:value="opportunityForm.statusId" :options="statusOptions" :placeholder="t('opportunity.statusPlaceholder')" /></n-form-item>
            <n-form-item :label="t('opportunity.resume')"><n-select v-model:value="opportunityForm.resumeVersionId" clearable :options="resumeOptions" :placeholder="t('opportunity.resumePlaceholder')" /></n-form-item>
            <n-form-item :label="t('opportunity.department')"><n-input v-model:value="opportunityForm.department" :placeholder="t('opportunity.departmentPlaceholder')" /></n-form-item>
            <n-form-item :label="t('opportunity.location')"><n-input v-model:value="opportunityForm.location" :placeholder="t('opportunity.locationPlaceholder')" /></n-form-item>
            <n-form-item :label="t('opportunity.source')"><n-input v-model:value="opportunityForm.source" :placeholder="t('opportunity.sourcePlaceholder')" /></n-form-item>
            <n-form-item :label="t('opportunity.url')"><n-input v-model:value="opportunityForm.jobUrl" :placeholder="t('opportunity.urlPlaceholder')" /></n-form-item>
          </div>
          <div class="form-grid three-columns opportunity-date-grid">
            <n-form-item :label="t('opportunity.discoveredAt')"><n-date-picker v-model:value="opportunityForm.discoveredAt" type="date" clearable :placeholder="t('opportunity.discoveredAtPlaceholder')" /></n-form-item>
            <n-form-item :label="t('opportunity.appliedAt')"><n-date-picker v-model:value="opportunityForm.appliedAt" type="date" clearable :placeholder="t('opportunity.appliedAtPlaceholder')" /></n-form-item>
            <n-form-item :label="t('opportunity.deadlineAt')"><n-date-picker v-model:value="opportunityForm.deadlineAt" type="date" clearable :placeholder="t('opportunity.deadlineAtPlaceholder')" /></n-form-item>
          </div>
          <n-form-item :label="t('opportunity.description')"><n-input v-model:value="opportunityForm.description" type="textarea" :placeholder="t('opportunity.descriptionPlaceholder')" :autosize="{ minRows: 3, maxRows: 8 }" /></n-form-item>
          <n-form-item :label="t('opportunity.notes')"><n-input v-model:value="opportunityForm.notes" type="textarea" :placeholder="t('opportunity.notesPlaceholder')" :autosize="{ minRows: 2, maxRows: 5 }" /></n-form-item>
        </n-form>
        <template #footer><n-space justify="end"><n-button @click="showOpportunityModal = false">{{ t('common.cancel') }}</n-button><n-button type="primary" @click="saveOpportunity">{{ t('common.save') }}</n-button></n-space></template>
      </n-card>
    </n-modal>

    <n-modal v-model:show="showEventModal">
      <n-card class="event-modal" :title="editingEventId ? t('calendar.edit') : t('calendar.add')" closable @close="showEventModal = false">
        <n-form label-placement="top">
          <n-form-item :label="t('calendar.eventTitle')" required><n-input v-model:value="eventForm.title" :placeholder="t('calendar.eventTitlePlaceholder')" /></n-form-item>
          <div class="form-grid two-columns">
            <n-form-item :label="t('calendar.eventType')"><n-select v-model:value="eventForm.eventType" :options="eventTypeOptions" :placeholder="t('calendar.eventTypePlaceholder')" /></n-form-item>
            <n-form-item :label="t('calendar.opportunity')"><n-select v-model:value="eventForm.opportunityId" clearable :options="opportunities.map((item) => ({ label: `${item.companyName} · ${item.title}`, value: item.id }))" :placeholder="t('calendar.opportunityPlaceholder')" /></n-form-item>
            <n-form-item :label="t('calendar.start')"><n-date-picker v-model:value="eventForm.startAt" type="datetime" :placeholder="t('calendar.startPlaceholder')" /></n-form-item>
            <n-form-item :label="t('calendar.end')"><n-date-picker v-model:value="eventForm.endAt" type="datetime" :placeholder="t('calendar.endPlaceholder')" /></n-form-item>
            <n-form-item :label="t('calendar.reminder')"><n-select v-model:value="eventForm.reminderMinutes" clearable :options="reminderOptions" :placeholder="t('calendar.reminderPlaceholder')" /></n-form-item>
          </div>
          <n-form-item :label="t('calendar.location')"><n-input v-model:value="eventForm.location" :placeholder="t('calendar.locationPlaceholder')" /></n-form-item>
          <n-form-item :label="t('calendar.description')"><n-input v-model:value="eventForm.description" type="textarea" :placeholder="t('calendar.descriptionPlaceholder')" /></n-form-item>
        </n-form>
        <template #footer><n-space justify="end"><n-button @click="showEventModal = false">{{ t('common.cancel') }}</n-button><n-button type="primary" @click="saveEvent">{{ t('common.save') }}</n-button></n-space></template>
      </n-card>
    </n-modal>

    <n-modal v-model:show="showIndustryModal">
      <n-card class="management-modal" :title="editingIndustryId ? t('management.editIndustry') : t('management.addIndustry')" closable @close="showIndustryModal = false">
        <n-form label-placement="top">
          <n-form-item :label="t('management.industryName')" required>
            <n-input v-model:value="industryForm.name" :placeholder="t('management.industryNamePlaceholder')" @keyup.enter="saveIndustry" />
          </n-form-item>
        </n-form>
        <template #footer><n-space justify="end"><n-button @click="showIndustryModal = false">{{ t('common.cancel') }}</n-button><n-button type="primary" @click="saveIndustry">{{ t('common.save') }}</n-button></n-space></template>
      </n-card>
    </n-modal>

    <n-modal v-model:show="showStatusModal">
      <n-card class="management-modal" :title="editingStatusId ? t('management.editStatus') : t('management.addStatus')" closable @close="showStatusModal = false">
        <n-input v-model:value="statusForm.label" :placeholder="t('management.statusPlaceholder')" @keyup.enter="saveStatus" />
        <template #footer><n-space justify="end"><n-button @click="showStatusModal = false">{{ t('common.cancel') }}</n-button><n-button type="primary" @click="saveStatus">{{ t('common.save') }}</n-button></n-space></template>
      </n-card>
    </n-modal>

    <n-modal v-model:show="showResumeModal">
      <n-card class="management-modal" :title="t('management.editResume')" closable @close="showResumeModal = false">
        <n-form label-placement="top">
          <n-form-item :label="t('management.resumeName')" required>
            <n-input v-model:value="resumeForm.name" :placeholder="t('management.resumeNamePlaceholder')" />
          </n-form-item>
          <n-form-item :label="t('management.resumeNote')">
            <n-input v-model:value="resumeForm.note" type="textarea" :placeholder="t('management.resumeNotePlaceholder')" />
          </n-form-item>
        </n-form>
        <template #footer><n-space justify="end"><n-button @click="showResumeModal = false">{{ t('common.cancel') }}</n-button><n-button type="primary" @click="saveResume">{{ t('common.save') }}</n-button></n-space></template>
      </n-card>
    </n-modal>

    <n-modal v-model:show="showCompanyModal">
      <n-card class="management-modal" :title="editingCompanyId ? t('management.editCompany') : t('management.addCompany')" closable @close="showCompanyModal = false">
        <n-form label-placement="top">
          <n-form-item :label="t('management.companyName')" required>
            <n-input v-model:value="companyForm.name" :placeholder="t('management.companyNamePlaceholder')" />
          </n-form-item>
          <n-form-item :label="t('management.companyIndustry')">
            <n-select v-model:value="companyForm.industryIds" multiple clearable filterable max-tag-count="responsive" :options="industryOptions" :placeholder="t('management.companyIndustryPlaceholder')" />
          </n-form-item>
          <n-form-item :label="t('management.companyAliases')">
            <div class="company-alias-editor">
              <n-tag v-for="(alias, index) in companyForm.aliases" :key="alias" closable round @close="removeCompanyAlias(index)">{{ alias }}</n-tag>
              <n-input
                v-model:value="companyAliasInput"
                class="company-alias-input"
                :bordered="false"
                :placeholder="companyForm.aliases.length ? '' : t('management.companyAliasesPlaceholder')"
                @keydown.enter.prevent="commitCompanyAliasInput"
                @blur="commitCompanyAliasInput"
              />
            </div>
          </n-form-item>
          <n-form-item :label="t('management.companyCareerUrl')">
            <n-input v-model:value="companyForm.careerUrl" :placeholder="t('management.companyCareerUrlPlaceholder')" />
          </n-form-item>
        </n-form>
        <template #footer><n-space justify="end"><n-button @click="showCompanyModal = false">{{ t('common.cancel') }}</n-button><n-button type="primary" @click="saveCompany">{{ t('common.save') }}</n-button></n-space></template>
      </n-card>
    </n-modal>
  </n-config-provider>
</template>
