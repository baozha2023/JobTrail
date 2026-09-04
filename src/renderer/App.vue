<script setup lang="ts">
import { computed, h, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import logoUrl from './assets/icon.png'
import {
  darkTheme,
  enUS,
  lightTheme,
  NButton,
  NCard,
  NCheckbox,
  NConfigProvider,
  NDataTable,
  NDatePicker,
  NEmpty,
  NForm,
  NFormItem,
  NInput,
  NLayout,
  NLayoutContent,
  NLayoutSider,
  NList,
  NListItem,
  NMenu,
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
} from '../shared/types'

const { t, locale } = useI18n()
const windowControls = window.windowControlsApi
const viewportWidth = ref(window.innerWidth)
const activeView = ref('opportunities')
const config = ref<AppConfig | null>(null)
const statuses = ref<Status[]>([])
const industries = ref<Industry[]>([])
const companies = ref<Company[]>([])
const resumes = ref<ResumeVersion[]>([])
const opportunities = ref<Opportunity[]>([])
const events = ref<CalendarEvent[]>([])
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
const resumeForm = ref<UpdateResumeVersionInput>({ name: '', note: null, isActive: true })
const showCompanyModal = ref(false)
const editingCompanyId = ref<number | null>(null)
const companyManagementSearch = ref('')
const companyForm = ref<CreateCompanyInput & { aliasesText: string }>({ name: '', industryId: null, careerUrl: null, aliasesText: '' })
const showIndustryModal = ref(false)
const editingIndustryId = ref<number | null>(null)
const industryForm = ref<CreateIndustryInput>({ name: '' })
const calendarMonth = ref(new Date(new Date().getFullYear(), new Date().getMonth(), 1))
const selectedCalendarDay = ref(new Date())
const updateInfo = ref<unknown | null>(null)
const updateMessage = ref('')
const currentVersion = ref('0.1.0')
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
const weekdays = computed(() => locale.value === 'zh-CN' ? ['日', '一', '二', '三', '四', '五', '六'] : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'])

const theme = computed(() => {
  const isDark = config.value?.themeMode === 'dark' || (config.value?.themeMode === 'system' && prefersDark.value)
  return isDark ? darkTheme : lightTheme
})
const naiveLocale = computed(() => locale.value === 'zh-CN' ? zhCN : enUS)
const { message } = createDiscreteApi(['message'], {
  configProviderProps: computed(() => ({ theme: theme.value, locale: naiveLocale.value })),
})

const columns = computed<DataTableColumns<Opportunity>>(() => [
  { title: t('opportunity.company'), key: 'companyName', width: '13%', ellipsis: { tooltip: true } },
  { title: t('opportunity.position'), key: 'title', width: '17%', ellipsis: { tooltip: true } },
  {
    title: t('opportunity.status'), key: 'statusLabel', width: '10%',
    render: (row) => h(NTag, { type: row.statusLabel === 'Offer' ? 'success' : 'info', bordered: false }, { default: () => row.statusLabel }),
  },
  { title: t('opportunity.resume'), key: 'resumeVersionName', width: '12%', render: (row) => row.resumeVersionName ?? '—' },
  { title: t('opportunity.location'), key: 'location', width: '11%', render: (row) => row.location ?? '—' },
  { title: t('opportunity.deadlineAt'), key: 'deadlineAt', width: '11%', render: (row) => formatDate(row.deadlineAt) },
  { title: t('opportunity.appliedAt'), key: 'appliedAt', width: '11%', render: (row) => formatDate(row.appliedAt) },
  {
    title: t('common.edit'), key: 'actions', width: '15%',
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
    render: (row) => h(NSpace, { size: 8, wrap: true }, {
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
    render: (row) => h(NSpace, { size: 8, wrap: true }, {
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
  { title: t('management.resumeName'), key: 'name', width: '17%', ellipsis: { tooltip: true } },
  { title: t('management.resumeFile'), key: 'relativePath', width: '23%', ellipsis: { tooltip: true } },
  {
    title: t('management.resumeSize'), key: 'sizeBytes', width: '10%',
    render: (row) => row.sizeBytes ? `${Math.ceil(row.sizeBytes / 1024)} KB` : '—',
  },
  { title: t('management.resumeNote'), key: 'note', width: '19%', ellipsis: { tooltip: true }, render: (row) => row.note ?? '—' },
  {
    title: t('management.resumeActive'), key: 'isActive', width: '10%',
    render: (row) => h(NTag, { type: row.isActive ? 'success' : 'default', bordered: false }, { default: () => row.isActive ? t('management.activeTag') : t('management.inactiveTag') }),
  },
  {
    title: t('common.edit'), key: 'actions', width: '21%',
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
  { title: t('management.companyName'), key: 'name', width: '20%', ellipsis: { tooltip: true } },
  { title: t('management.companyIndustry'), key: 'industryName', width: '16%', ellipsis: { tooltip: true }, render: (row) => row.industryName ?? '—' },
  {
    title: t('management.companyCareerUrl'), key: 'careerUrl', width: '38%', ellipsis: { tooltip: true },
    render: (row) => {
      const url = row.careerUrl
      return url ? h('a', {
        class: 'external-link', href: url, title: url,
        onClick: (event: MouseEvent) => { event.preventDefault(); void openExternal(url) },
      }, url) : '—'
    },
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
    render: (row) => h(NSpace, { size: 8, wrap: true }, {
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

function formatDateTime(timestamp: number): string {
  return new Intl.DateTimeFormat(locale.value, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(timestamp)
}

function filterCompanyOption(pattern: string, option: SelectOption): boolean {
  const keyword = pattern.trim().toLocaleLowerCase()
  if (!keyword) return true
  const company = companies.value.find((item) => item.id === Number(option.value))
  const label = typeof option.label === 'string' ? option.label : company?.name ?? ''
  return [label, ...(company?.aliases ?? [])].some((value) => value.toLocaleLowerCase().includes(keyword))
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

function eventsForDay(day: Date): CalendarEvent[] {
  return events.value.filter((event) => isSameDay(new Date(event.startAt), day))
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
  const message = error instanceof Error ? error.message : String(error)
  return message.includes(': ') ? message.slice(message.indexOf(': ') + 2) : message
}

function showError(error: unknown): void {
  message.error(errorMessage(error))
}

async function openExternal(url: string): Promise<void> {
  try { await window.jobTrailApi.system.openExternal(url) } catch (error) { showError(error) }
}

async function moveStatus(id: number, offset: number): Promise<void> {
  const reordered = statuses.value.map((status) => status.id)
  const index = reordered.indexOf(id)
  const target = index + offset
  if (index < 0 || target < 0 || target >= reordered.length) return
  ;[reordered[index], reordered[target]] = [reordered[target], reordered[index]]
  try {
    statuses.value = await window.jobTrailApi.statuses.reorder(reordered)
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
    industries.value = await window.jobTrailApi.industries.reorder(reordered)
    message.success(t('feedback.reorderSuccess'))
  } catch (error) { showError(error) }
}

function updateViewportWidth(): void {
  viewportWidth.value = window.innerWidth
}

async function loadAll(): Promise<void> {
  loading.value = true
  try {
    config.value = await window.jobTrailApi.config.get()
    locale.value = config.value.locale
    currentVersion.value = await window.velopackApi.getVersion()
    statuses.value = await window.jobTrailApi.statuses.list()
    industries.value = await window.jobTrailApi.industries.list()
    await loadCompanies()
    resumes.value = await window.jobTrailApi.resumes.list()
    await loadOpportunities()
    await loadCalendar()
  } catch (error) {
    showError(error)
  } finally {
    loading.value = false
  }
}

async function loadOpportunities(): Promise<void> {
  opportunities.value = await window.jobTrailApi.opportunities.list({
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
  events.value = await window.jobTrailApi.calendar.list({ startAt: start.getTime(), endAt: end.getTime() })
}

async function loadCompanies(): Promise<void> {
  companies.value = await window.jobTrailApi.companies.search('')
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
    const isEditing = Boolean(editingOpportunityId.value)
    if (isEditing) await window.jobTrailApi.opportunities.update(editingOpportunityId.value!, opportunityForm.value)
    else await window.jobTrailApi.opportunities.create(opportunityForm.value)
    showOpportunityModal.value = false
    await loadOpportunities()
    message.success(t(isEditing ? 'feedback.editSuccess' : 'feedback.addSuccess'))
  } catch (error) { showError(error) }
}

async function deleteOpportunity(id: number): Promise<void> {
  try {
    await window.jobTrailApi.opportunities.delete(id)
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

async function saveEvent(): Promise<void> {
  if (!eventForm.value.title.trim()) { message.error(t('error.required')); return }
  try {
    const isEditing = Boolean(editingEventId.value)
    if (isEditing) await window.jobTrailApi.calendar.update(editingEventId.value!, eventForm.value)
    else await window.jobTrailApi.calendar.create(eventForm.value)
    showEventModal.value = false
    await loadCalendar()
    message.success(t(isEditing ? 'feedback.editSuccess' : 'feedback.addSuccess'))
  } catch (error) { showError(error) }
}

async function deleteEvent(id: number): Promise<void> {
  try {
    await window.jobTrailApi.calendar.delete(id)
    await loadCalendar()
    message.success(t('feedback.deleteSuccess'))
  } catch (error) { showError(error) }
}

async function completeEvent(event: CalendarEvent): Promise<void> {
  try {
    await window.jobTrailApi.calendar.complete(event.id, !event.isCompleted)
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
    config.value = await window.jobTrailApi.config.update(input)
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
    const isEditing = Boolean(editingStatusId.value)
    if (isEditing) await window.jobTrailApi.statuses.update(editingStatusId.value!, statusForm.value)
    else await window.jobTrailApi.statuses.create(statusForm.value)
    statuses.value = await window.jobTrailApi.statuses.list()
    showStatusModal.value = false
    await loadOpportunities()
    message.success(t(isEditing ? 'feedback.editSuccess' : 'feedback.addSuccess'))
  } catch (error) { showError(error) }
}

async function deleteStatus(status: Status): Promise<void> {
  try {
    await window.jobTrailApi.statuses.delete(status.id)
    statuses.value = statuses.value.filter((item) => item.id !== status.id)
    await loadOpportunities()
    message.success(t('feedback.deleteSuccess'))
  } catch (error) { showError(error) }
}

async function importResume(): Promise<void> {
  try {
    const result = await window.jobTrailApi.resumes.import()
    if (result) {
      resumes.value = await window.jobTrailApi.resumes.list()
      message.success(t('feedback.importSuccess'))
    }
  } catch (error) { showError(error) }
}

function openResumeEditor(resume: ResumeVersion): void {
  editingResumeId.value = resume.id
  resumeForm.value = { name: resume.name, note: resume.note, isActive: resume.isActive }
  showResumeModal.value = true
}

async function saveResume(): Promise<void> {
  if (!resumeForm.value.name?.trim() || !editingResumeId.value) { message.error(t('error.required')); return }
  try {
    await window.jobTrailApi.resumes.update(editingResumeId.value, resumeForm.value)
    resumes.value = await window.jobTrailApi.resumes.list()
    showResumeModal.value = false
    await loadOpportunities()
    message.success(t('feedback.editSuccess'))
  } catch (error) { showError(error) }
}

async function deleteResume(resume: ResumeVersion): Promise<void> {
  try {
    await window.jobTrailApi.resumes.delete(resume.id)
    resumes.value = await window.jobTrailApi.resumes.list()
    message.success(t('feedback.deleteSuccess'))
  } catch (error) { showError(error) }
}

async function openResume(id: number): Promise<void> {
  try { await window.jobTrailApi.resumes.open(id) } catch (error) { showError(error) }
}

function openIndustryEditor(industry?: Industry): void {
  editingIndustryId.value = industry?.id ?? null
  industryForm.value = { name: industry?.name ?? '' }
  showIndustryModal.value = true
}

async function saveIndustry(): Promise<void> {
  if (!industryForm.value.name.trim()) { message.error(t('error.required')); return }
  try {
    const isEditing = Boolean(editingIndustryId.value)
    if (isEditing) await window.jobTrailApi.industries.update(editingIndustryId.value!, industryForm.value)
    else await window.jobTrailApi.industries.create(industryForm.value)
    industries.value = await window.jobTrailApi.industries.list()
    await loadCompanies()
    showIndustryModal.value = false
    message.success(t(isEditing ? 'feedback.editSuccess' : 'feedback.addSuccess'))
  } catch (error) { showError(error) }
}

async function deleteIndustry(industry: Industry): Promise<void> {
  try {
    await window.jobTrailApi.industries.delete(industry.id)
    industries.value = await window.jobTrailApi.industries.list()
    message.success(t('feedback.deleteSuccess'))
  } catch (error) { showError(error) }
}

function openCompanyEditor(company?: Company): void {
  editingCompanyId.value = company?.id ?? null
  companyForm.value = {
    name: company?.name ?? '',
    industryId: company?.industryId ?? null,
    careerUrl: company?.careerUrl ?? null,
    aliasesText: company?.aliases.join(', ') ?? '',
  }
  showCompanyModal.value = true
}

function parseAliasText(value: string): string[] {
  return [...new Set(value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean))]
}

async function saveCompany(): Promise<void> {
  if (!companyForm.value.name.trim()) { message.error(t('error.required')); return }
  const input = {
    name: companyForm.value.name,
    industryId: companyForm.value.industryId,
    careerUrl: companyForm.value.careerUrl,
    aliases: parseAliasText(companyForm.value.aliasesText),
  }
  try {
    const isEditing = Boolean(editingCompanyId.value)
    if (isEditing) await window.jobTrailApi.companies.update(editingCompanyId.value!, input)
    else await window.jobTrailApi.companies.create(input)
    await loadCompanies()
    showCompanyModal.value = false
    message.success(t(isEditing ? 'feedback.editSuccess' : 'feedback.addSuccess'))
  } catch (error) { showError(error) }
}

async function toggleCompanyFavorite(company: Company): Promise<void> {
  try {
    await window.jobTrailApi.companies.update(company.id, { isFavorite: !company.isFavorite })
    await loadCompanies()
    message.success(t(company.isFavorite ? 'feedback.unfavoriteSuccess' : 'feedback.favoriteSuccess'))
  } catch (error) { showError(error) }
}

async function deleteCompany(company: Company): Promise<void> {
  try {
    await window.jobTrailApi.companies.delete(company.id)
    await Promise.all([loadCompanies(), loadOpportunities()])
    message.success(t('feedback.deleteSuccess'))
  } catch (error) { showError(error) }
}

async function checkForUpdates(): Promise<void> {
  updateMessage.value = t('common.loading')
  try {
    updateInfo.value = await window.velopackApi.checkForUpdates()
    updateMessage.value = updateInfo.value ? t('settings.updateAvailable') : t('settings.noUpdate')
    if (updateInfo.value && window.confirm(t('settings.updateAvailable'))) {
      updateMessage.value = t('settings.updating')
      await window.velopackApi.downloadUpdates(updateInfo.value)
      await window.velopackApi.applyUpdates(updateInfo.value)
    }
  } catch (error) { updateMessage.value = errorMessage(error) }
}

watch([search, selectedStatusId, selectedCompanyId], () => { void loadOpportunities() })
watch(calendarMonth, () => { void loadCalendar() })

onMounted(() => {
  window.addEventListener('resize', updateViewportWidth)
  if (window.matchMedia) {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    prefersDark.value = media.matches
    media.addEventListener('change', (event) => { prefersDark.value = event.matches })
  }
  void loadAll()
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', updateViewportWidth)
})
</script>

<template>
  <n-config-provider :theme="theme" :locale="naiveLocale">
    <div class="window-root">
      <div class="window-titlebar">
        <div class="window-titlebar-brand">
          <img :src="logoUrl" alt="职迹" />
          <span>{{ t('appName') }}</span>
        </div>
        <div class="window-controls">
          <button class="window-control" type="button" :aria-label="t('window.minimize')" @click="windowControls.minimize">−</button>
          <button class="window-control" type="button" :aria-label="t('window.maximize')" @click="windowControls.toggleMaximize">□</button>
          <button class="window-control close" type="button" :aria-label="t('window.close')" @click="windowControls.close">×</button>
        </div>
      </div>

      <n-layout has-sider class="app-shell">
      <n-layout-sider bordered :width="sidebarWidth" class="sidebar">
        <div class="brand">
          <img class="brand-logo" :src="logoUrl" alt="职迹" />
          <div class="brand-name">{{ t('appName') }}</div>
        </div>
        <n-menu v-model:value="activeView" :options="menuOptions" />
      </n-layout-sider>

      <n-layout>
        <n-layout-content class="content">
          <header class="page-header">
            <div>
              <h1>{{ pageTitle }}</h1>
            </div>
            <n-space>
              <n-button v-if="activeView === 'opportunities'" type="primary" @click="newOpportunity">{{ t('common.add') }}</n-button>
              <n-button v-if="activeView === 'calendar'" type="primary" @click="newEvent()">{{ t('common.add') }}</n-button>
              <n-button v-if="activeView === 'statuses'" type="primary" @click="openStatusEditor()">{{ t('common.add') }}</n-button>
              <n-button v-if="activeView === 'industries'" type="primary" @click="openIndustryEditor()">{{ t('common.add') }}</n-button>
              <n-button v-if="activeView === 'resumes'" type="primary" @click="importResume">{{ t('common.import') }}</n-button>
              <n-button v-if="activeView === 'companies'" type="primary" @click="openCompanyEditor()">{{ t('common.add') }}</n-button>
            </n-space>
          </header>

          <section v-if="activeView === 'opportunities'" class="page-section">
            <n-card bordered class="toolbar-card">
              <n-space align="center" wrap>
                <n-input v-model:value="search" clearable class="opportunity-search" :placeholder="t('common.search')" />
                <n-select v-model:value="selectedStatusId" clearable filterable class="opportunity-filter" :options="statusOptions" :placeholder="t('opportunity.status')" />
                <n-select v-model:value="selectedCompanyId" clearable filterable :filter="filterCompanyOption" class="opportunity-filter" :options="companyOptions" :placeholder="t('opportunity.company')" />
                <n-button quaternary @click="loadOpportunities">{{ t('common.refresh') }}</n-button>
              </n-space>
            </n-card>
            <n-card bordered class="table-card">
              <n-data-table class="responsive-table" table-layout="fixed" paginate-single-page :columns="columns" :data="opportunities" :loading="loading" :pagination="opportunityPagination">
                <template #empty>{{ t('opportunity.empty') }}</template>
              </n-data-table>
            </n-card>
          </section>

          <section v-else-if="activeView === 'calendar'" class="page-section">
            <div class="calendar-toolbar">
              <n-space align="center">
                <n-button quaternary @click="previousMonth">‹ {{ t('calendar.previous') }}</n-button>
                <strong>{{ monthLabel }}</strong>
                <n-button quaternary @click="nextMonth">{{ t('calendar.next') }} ›</n-button>
                <n-button secondary @click="goToday">{{ t('calendar.today') }}</n-button>
              </n-space>
            </div>
            <n-card bordered class="calendar-card">
              <div class="weekday-row"><span v-for="day in weekdays" :key="day">{{ day }}</span></div>
              <div class="calendar-grid">
                <button v-for="day in calendarDays" :key="day.toISOString()" class="calendar-day" :class="{ muted: day.getMonth() !== calendarMonth.getMonth(), today: isSameDay(day, new Date()), selected: isSameDay(day, selectedCalendarDay) }" @click="selectedCalendarDay = day; newEvent(day)">
                  <span class="day-number">{{ day.getDate() }}</span>
                  <span v-for="event in eventsForDay(day).slice(0, 3)" :key="event.id" class="calendar-event" :class="{ completed: event.isCompleted }" @click.stop="openEvent(event)">{{ event.title }}</span>
                  <span v-if="eventsForDay(day).length > 3" class="more-events">+{{ eventsForDay(day).length - 3 }}</span>
                </button>
              </div>
            </n-card>
            <n-card bordered class="day-list-card">
              <template #header>{{ formatDate(selectedCalendarDay.getTime()) }}</template>
              <n-empty v-if="eventsForDay(selectedCalendarDay).length === 0" :description="t('calendar.empty')" />
              <n-list v-else>
                <n-list-item v-for="event in eventsForDay(selectedCalendarDay)" :key="event.id">
                  <div class="event-row">
                    <div><strong>{{ event.title }}</strong><div class="muted-text">{{ event.companyName ?? '' }} {{ formatDateTime(event.startAt) }}</div></div>
                    <n-space><n-tag :bordered="false">{{ event.eventType }}</n-tag><n-button size="small" @click="completeEvent(event)">{{ event.isCompleted ? t('calendar.completed') : t('common.complete') }}</n-button><n-button size="small" @click="openEvent(event)">{{ t('common.edit') }}</n-button><n-button size="small" type="error" tertiary @click="deleteEvent(event.id)">{{ t('common.delete') }}</n-button></n-space>
                  </div>
                </n-list-item>
              </n-list>
            </n-card>
          </section>

          <section v-else-if="activeView === 'industries'" class="page-section management-page">
            <n-card bordered class="table-card">
              <n-data-table class="responsive-table" table-layout="fixed" paginate-single-page :columns="industryColumns" :data="industries" :pagination="industryPagination">
                <template #empty>{{ t('management.industryEmpty') }}</template>
              </n-data-table>
            </n-card>
          </section>

          <section v-else-if="activeView === 'statuses'" class="page-section management-page">
            <n-card bordered class="table-card">
              <n-data-table class="responsive-table" table-layout="fixed" paginate-single-page :columns="statusColumns" :data="statuses" :pagination="statusPagination">
                <template #empty>{{ t('management.statusEmpty') }}</template>
              </n-data-table>
            </n-card>
          </section>

          <section v-else-if="activeView === 'resumes'" class="page-section management-page">
            <n-card bordered class="table-card">
              <n-data-table class="responsive-table" table-layout="fixed" paginate-single-page :columns="resumeColumns" :data="resumes" :pagination="resumePagination">
                <template #empty>{{ t('management.resumeEmpty') }}</template>
              </n-data-table>
            </n-card>
          </section>

          <section v-else-if="activeView === 'companies'" class="page-section management-page">
            <n-card bordered class="toolbar-card">
              <n-input v-model:value="companyManagementSearch" clearable :placeholder="t('management.companySearch')" />
            </n-card>
            <n-card bordered class="table-card">
              <n-data-table class="responsive-table" table-layout="fixed" paginate-single-page :columns="companyColumns" :data="managedCompanies" :pagination="companyPagination">
                <template #empty>{{ t('management.companyEmpty') }}</template>
              </n-data-table>
            </n-card>
          </section>

          <section v-else class="page-section settings-page">
            <div class="settings-layout">
              <n-card bordered class="settings-card" :title="t('settings.appearance')">
                <n-form class="settings-form" label-placement="top">
                  <div class="settings-form-grid">
                    <n-form-item :label="t('settings.theme')">
                      <n-select :value="config?.themeMode" :options="[{ label: t('settings.light'), value: 'light' }, { label: t('settings.dark'), value: 'dark' }, { label: t('settings.system'), value: 'system' }]" :placeholder="t('settings.themePlaceholder')" @update:value="(value) => saveConfig({ themeMode: value })" />
                    </n-form-item>
                    <n-form-item :label="t('settings.language')">
                      <n-select :value="config?.locale" :options="[{ label: '简体中文', value: 'zh-CN' }, { label: 'English', value: 'en-US' }]" :placeholder="t('settings.languagePlaceholder')" @update:value="(value) => saveConfig({ locale: value })" />
                    </n-form-item>
                    <n-form-item class="settings-form-item-wide" :label="t('settings.closeBehavior')">
                      <n-radio-group :value="config?.closeBehavior" @update:value="setCloseBehavior">
                        <n-space wrap>
                          <n-radio value="tray">{{ t('settings.minimizeToTray') }}</n-radio>
                          <n-radio value="quit">{{ t('settings.quitDirectly') }}</n-radio>
                        </n-space>
                      </n-radio-group>
                    </n-form-item>
                    <n-form-item class="settings-form-item-wide" :label="t('settings.launchAtStartup')">
                      <n-radio-group :value="config?.launchAtStartup" @update:value="setLaunchAtStartup">
                        <n-space wrap>
                          <n-radio :value="true">{{ t('settings.enable') }}</n-radio>
                          <n-radio :value="false">{{ t('settings.disable') }}</n-radio>
                        </n-space>
                      </n-radio-group>
                    </n-form-item>
                  </div>
                </n-form>
              </n-card>

              <n-card bordered class="settings-card settings-update-card" :title="t('settings.update')">
                <div class="settings-update-panel">
                  <div class="settings-version-block">
                    <span class="muted-text">{{ t('settings.version') }}</span>
                    <strong>{{ currentVersion }}</strong>
                  </div>
                  <p class="muted-text settings-update-message">{{ updateMessage || (config?.velopack.githubRepository ? '' : t('settings.noUpdateSource')) }}</p>
                  <n-button :loading="updateMessage === t('common.loading')" @click="checkForUpdates">{{ t('settings.checkUpdate') }}</n-button>
                </div>
              </n-card>
            </div>
          </section>
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
          <n-checkbox v-model:checked="resumeForm.isActive">{{ t('management.resumeActive') }}</n-checkbox>
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
            <n-select v-model:value="companyForm.industryId" clearable filterable :options="industryOptions" :placeholder="t('management.companyIndustryPlaceholder')" />
          </n-form-item>
          <n-form-item :label="t('management.companyAliases')">
            <n-input v-model:value="companyForm.aliasesText" :placeholder="t('management.companyAliasesPlaceholder')" />
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
