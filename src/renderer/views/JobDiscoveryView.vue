<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  NButton,
  NCard,
  NModal,
  NSelect,
  NInput,
  NInputNumber,
  NCheckbox,
  NCheckboxGroup,
  NAlert,
  NTag,
  NPagination,
  NSpin,
  type SelectOption,
} from 'naive-ui'
import {
  platforms,
  platformNames,
  searchQuerySchema,
  needsHumanAction,
  type JobPlatform,
  type SearchRun,
  type DiscoveredJob,
  type PlatformStatus,
  type JobPage,
  type QrLoginState,
  type QrLoginMethod,
  type SourceVerificationState,
  type SourceState,
  type SourceProgress,
} from '../../shared/job-discovery'
import type { CompanySummary, Status, ResumeVersion } from '../../shared/types'
import { commonCities, platformCity } from '../../shared/discovery-cities'
import { cityNamesEn } from '../discovery-city-names'
import { errorCode, getErrorMessage } from '../utils/errors'
import DiscoveryLoginPanel from '../components/DiscoveryLoginPanel.vue'
const props = defineProps<{
  active: boolean
  companies: CompanySummary[]
  statuses: Status[]
  resumes: ResumeVersion[]
}>()
const emit = defineEmits<{ saved: [] }>()
const { t, te } = useI18n(),
  api = window.zhijiApi.discovery
const keyword = ref(''),
  city = ref<string | null>(null),
  selectedPlatforms = ref<JobPlatform[]>([]),
  filtersOpen = ref(false)
const salaryMin = ref<number | null>(null),
  salaryMax = ref<number | null>(null)
const run = ref<SearchRun | null>(null),
  viewId = ref<string>(),
  results = ref<JobPage | null>(null),
  selected = ref<DiscoveredJob | null>(null),
  selectedId = ref('')
const jobOffline = ref(false)
const browserLoading = ref(false)
let browserRequestId: string | null = null
let removeBrowserLoadingListener: (() => void) | undefined
const page = ref(1),
  pageSize = ref<10 | 20 | 50>(20),
  sort = ref<'relevance' | 'salary' | 'discovered'>('relevance')
const error = ref(''),
  busy = ref(false),
  detailBusy = ref(false),
  webMode = ref(false),
  narrowDetails = ref(false),
  split = ref(40)
const queryLocked = ref(false)
const inputsDisabled = computed(() => queryLocked.value || busy.value)
const accounts = ref(false),
  historyOpen = ref(false),
  saveOpen = ref(false),
  clearPlatform = ref<JobPlatform | null>(null),
  loginPlatform = ref<JobPlatform | null>(null)
const qrState = ref<QrLoginState | null>(null),
  qrBusy = ref(false),
  qrError = ref('')
const sourceLogin = ref<{ runId: string; platform: JobPlatform } | null>(null)
let qrSequence = 0
const accountStates = ref<PlatformStatus[]>([]),
  history = ref<SearchRun[]>([]),
  historyPage = ref(1),
  historyTotal = ref(0),
  historySelected = ref<string[]>([]),
  deleteHistory = ref(false),
  historyBusy = ref(false),
  historyDeleting = ref(false),
  historyError = ref('')
let historySequence = 0
let accountSequence = 0
let accountRefresh = Promise.resolve()
const authenticatedPlatforms = computed(
  () =>
    new Set(accountStates.value.filter((s) => s.state === 'authenticated').map((s) => s.platform)),
)
const deletableHistory = computed(() =>
  history.value.filter((item) => !['queued', 'running'].includes(item.state)),
)
const allHistorySelected = computed(
  () =>
    deletableHistory.value.length > 0 &&
    deletableHistory.value.every((item) => historySelected.value.includes(item.id)),
)
const selectedAccount = computed(() =>
  accountStates.value.find((item) => item.platform === loginPlatform.value),
)
const existingCompany = ref<number | null>(null),
  newCompany = ref(false),
  newCompanyName = ref(''),
  statusId = ref<number | null>(null),
  resumeId = ref<number | null>(null)
const region = ref<HTMLElement>(),
  panes = ref<HTMLElement>(),
  openMenus = ref(new Set<string>())
let poll: ReturnType<typeof setTimeout> | undefined,
  resize: ResizeObserver | undefined,
  overlays: MutationObserver | undefined,
  detailSequence = 0,
  listSequence = 0,
  disposed = false,
  lastRegion = '',
  regionFrame = 0
const running = computed(() => run.value && ['queued', 'running'].includes(run.value.state))
const sourceErrorStates = new Set<SourceState>([
  'login_required',
  'session_expired',
  'challenge',
  'unsupported_city',
  'scope_unverified',
  'parse_error',
  'timeout',
  'network_error',
])
const sourceWarnings = computed(() =>
  (run.value?.sources ?? []).filter(
    (source) => sourceErrorStates.has(source.state) || source.message === 'batch_save_failed',
  ),
)
const warningQueue = ref<JobPlatform[]>([])
const verificationState = ref<SourceVerificationState | null>(null)
const verificationBusy = ref(false)
let verificationSequence = 0
watch([() => run.value?.id, sourceWarnings], ([id, sources], [previousId]) => {
  const pending = sources
    .filter((source) => needsHumanAction(source.state))
    .map((source) => source.platform)
  const previous = id === previousId ? warningQueue.value : []
  warningQueue.value = [
    ...previous.filter((p) => pending.includes(p)),
    ...pending.filter((p) => !previous.includes(p)),
  ]
})
const currentWarning = computed(() =>
  sourceWarnings.value.find((source) => source.platform === warningQueue.value[0]),
)
const otherWarnings = computed(() =>
  sourceWarnings.value.filter((source) => !needsHumanAction(source.state)),
)
function sourceLabel(source: Pick<SourceProgress, 'state' | 'message'>): string {
  return label(
    source.state === 'parse_error' && source.message === 'authentication_check_inconclusive'
      ? source.message
      : source.state,
  )
}
const statusOptions = computed(() => props.statuses.map((s) => ({ label: s.label, value: s.id })))
const companyOptions = computed(() =>
  props.companies.map((company) => ({ label: company.name, value: company.id })),
)
const resumeOptions = computed(() => props.resumes.map((s) => ({ label: s.name, value: s.id })))
const citySelectionVersion = ref(0)
const cityOptions = computed(() =>
  commonCities(selectedPlatforms.value).map((city) => ({
    label: cityLabel(city.name),
    value: city.name,
  })),
)
function cityLabel(name: string, sites: readonly JobPlatform[] = selectedPlatforms.value): string {
  const canonical = sites.map((p) => platformCity(p, name)?.name).find(Boolean) ?? name
  const key = 'discoveryCities.' + canonical
  return te(key) ? t(key) : name
}
function cityFallback(value: string | number): SelectOption {
  return { value, label: cityLabel(String(value)) }
}
function filterCity(pattern: string, option: SelectOption): boolean {
  // Search either language, ignoring Latin case, accents and syllable separators.
  const searchable = (text: string) =>
    text
      .normalize('NFKD')
      .replace(/\p{M}|[\s'’]/gu, '')
      .toLowerCase()
  const name = String(option.value ?? '')
  return [name, cityNamesEn[name] ?? name].some((text) =>
    searchable(text).includes(searchable(pattern)),
  )
}
function selectPlatforms(value: readonly (string | number)[]) {
  if (queryLocked.value) return
  const next = platforms.filter((platform) => value.includes(platform))
  if (
    next.length !== selectedPlatforms.value.length ||
    next.some((platform) => !selectedPlatforms.value.includes(platform))
  ) {
    city.value = null
    citySelectionVersion.value++
    openMenus.value.delete('city')
  }
  selectedPlatforms.value = next
}
const missing = computed(() => Object.entries(selected.value?.missing || {}))
const fields: Record<string, string> = {
  title: 'fieldTitle',
  company: 'fieldCompany',
  city: 'fieldCity',
  salary: 'fieldSalary',
  experience: 'fieldExperience',
  education: 'fieldEducation',
  recruitment: 'fieldRecruitment',
  employment: 'fieldEmployment',
  jd: 'fieldJd',
  keyword: 'keyword',
  platform: 'platform',
}
const label = (key: string) =>
  t('discovery.' + key, { platform: loginPlatform.value ? platformNames[loginPlatform.value] : '' })
const fieldLabel = (key: string) => label(fields[key] || key)
const time = (value: number) => new Date(value).toLocaleString()
function fail(e: unknown) {
  error.value = getErrorMessage(e, t)
  if (accounts.value) qrError.value = error.value
}
async function safely(work: () => Promise<unknown>) {
  try {
    error.value = ''
    return await work()
  } catch (e) {
    fail(e)
  }
}
function menu(key: string, show: boolean) {
  const next = new Set(openMenus.value)
  show ? next.add(key) : next.delete(key)
  openMenus.value = next
  void syncRegion()
}
async function syncRegion() {
  await nextTick()
  if (disposed) return
  const target = !accounts.value && webMode.value ? region.value : undefined
  const rect = target?.getBoundingClientRect()
  // Native child views sit above DOM overlays: explicitly hide for all app menus/modals.
  const foreignOverlay = Array.from(
    document.querySelectorAll('.n-modal,.n-base-select-menu,.n-dropdown-menu,.n-popover'),
  ).some((e) => {
    const r = e.getBoundingClientRect()
    return r.width > 0 && r.height > 0 && !e.classList.contains('discovery-accounts')
  })
  const value = {
    x: rect?.x || 0,
    y: rect?.y || 0,
    width: rect?.width || 0,
    height: rect?.height || 0,
    visible:
      !!target &&
      props.active &&
      !browserLoading.value &&
      !historyOpen.value &&
      !saveOpen.value &&
      !clearPlatform.value &&
      !deleteHistory.value &&
      !openMenus.value.size &&
      !foreignOverlay,
  }
  const key = JSON.stringify(value)
  if (lastRegion === key) return
  lastRegion = key
  try {
    await api.region(value)
  } catch {
    /* Window may already be closing. */
  }
}
function scheduleRegion() {
  cancelAnimationFrame(regionFrame)
  regionFrame = requestAnimationFrame(() => void syncRegion())
}
async function loadResults() {
  if (!run.value) return
  const seq = ++listSequence
  try {
    const result = await api.list({
      runId: run.value.id,
      viewId: viewId.value,
      page: page.value,
      pageSize: pageSize.value,
      sort: sort.value,
    })
    if (seq !== listSequence || disposed) return
    viewId.value = result.viewId
    results.value = result
    if (page.value > 1 && !result.items.length) {
      page.value = Math.max(1, Math.ceil(result.total / pageSize.value))
    }
  } catch (e) {
    if (seq === listSequence && !disposed) throw e
  }
}
async function refreshResults() {
  jobOffline.value = false
  selectedId.value = ''
  selected.value = null
  detailSequence++
  listSequence++
  viewId.value = undefined
  if (page.value !== 1) page.value = 1
  else await loadResults()
}
async function refreshRun() {
  if (!run.value) return
  const id = run.value.id
  try {
    const updated = await api.run(id)
    if (run.value?.id !== id || disposed) return
    run.value = updated
    await loadResults()
  } catch (e) {
    if (run.value?.id === id && !disposed) throw e
  }
}
function refreshAccounts(): Promise<void> {
  const seq = ++accountSequence
  accountRefresh = (async () => {
    const states = await api.status()
    // A submit superseded by polling must wait until the newer selection is applied.
    if (seq !== accountSequence) return accountRefresh
    if (disposed) return
    const previous = authenticatedPlatforms.value
    accountStates.value = states
    if (queryLocked.value) return
    selectPlatforms(
      platforms.filter(
        (p) =>
          authenticatedPlatforms.value.has(p) &&
          (selectedPlatforms.value.includes(p) || !previous.has(p)),
      ),
    )
  })()
  return accountRefresh
}
async function tick() {
  if (disposed) return
  try {
    if (props.active && accounts.value) {
      const current = qrState.value
      if (current && ['loading', 'waiting', 'scanned', 'challenge'].includes(current.state)) {
        const next = await api.qrLogin({
          action: 'get',
          platform: current.platform,
          attemptId: current.attemptId,
        })
        if (qrState.value?.attemptId === current.attemptId) {
          qrState.value = next
          await resumeAfterLogin(next)
        }
      }
    }
    if (props.active) {
      const previous = verificationState.value
      if (previous || warningQueue.value.length) {
        const seq = ++verificationSequence
        const current = await api.verification({ action: 'get' })
        if (seq === verificationSequence) verificationState.value = current
      }
      if (running.value || previous || warningQueue.value.length) await refreshRun()
      await refreshAccounts()
    }
  } catch (e) {
    fail(e)
  } finally {
    if (!disposed) poll = setTimeout(tick, 1600)
  }
}
async function closeVerification() {
  ++verificationSequence
  verificationState.value = null
  await api.verification({ action: 'close' })
}
async function openVerification() {
  const source = currentWarning.value
  if (!source || !run.value || verificationBusy.value) return
  if (source.state === 'login_required' || source.state === 'session_expired') {
    const target = { runId: run.value.id, platform: source.platform }
    verificationBusy.value = true
    await safely(async () => {
      try {
        await openAccounts(target)
        if (accounts.value && sourceLogin.value?.runId === target.runId)
          await login(target.platform)
      } finally {
        verificationBusy.value = false
      }
    })
    return
  }
  const seq = ++verificationSequence
  verificationBusy.value = true
  await safely(async () => {
    try {
      const current = await api.verification({
        action: 'open',
        runId: run.value!.id,
        platform: source.platform,
      })
      if (seq === verificationSequence) verificationState.value = current
    } finally {
      verificationBusy.value = false
    }
  })
}
async function submitSearch() {
  if (busy.value) return
  await safely(async () => {
    busy.value = true
    try {
      if (running.value) {
        run.value = await api.cancel(run.value!.id)
        return
      }
      if (run.value) {
        if (verificationState.value) return
        run.value = await api.continue(run.value.id)
        await loadResults()
        return
      }
      await refreshAccounts()
      if (!selectedPlatforms.value.length) return
      await closeVerification()
      const query = searchQuerySchema.parse({
        keyword: keyword.value,
        city: city.value ?? '',
        platforms: selectedPlatforms.value,
        salaryMin: salaryMin.value ?? undefined,
        salaryMax: salaryMax.value ?? undefined,
      })
      queryLocked.value = true
      run.value = await api.start({ requestId: crypto.randomUUID(), query })
      viewId.value = undefined
      selected.value = null
      jobOffline.value = false
      selectedId.value = ''
      detailSequence++
      page.value = 1
      await api.browser({ action: 'close' })
      await loadResults()
    } finally {
      busy.value = false
    }
  })
}
function clearSearchPage() {
  // Invalidate reads before clearing the run so late results cannot restore the old page.
  detailSequence++
  listSequence++
  verificationSequence++
  run.value = null
  viewId.value = undefined
  results.value = null
  selected.value = null
  selectedId.value = ''
  jobOffline.value = false
  detailBusy.value = false
  verificationState.value = null
  verificationBusy.value = false
  warningQueue.value = []
  keyword.value = ''
  city.value = null
  citySelectionVersion.value++
  salaryMin.value = null
  salaryMax.value = null
  queryLocked.value = false
  selectPlatforms(platforms.filter((p) => authenticatedPlatforms.value.has(p)))
  filtersOpen.value = false
  page.value = 1
  pageSize.value = 20
  sort.value = 'relevance'
  narrowDetails.value = false
  webMode.value = false
  browserRequestId = null
  browserLoading.value = false
  saveOpen.value = false
  error.value = ''
}
async function newSearch() {
  if (busy.value) return
  await safely(async () => {
    busy.value = true
    try {
      await closeVerification()
      if (running.value) await api.cancel(run.value!.id)
      await api.browser({ action: 'close' })
      clearSearchPage()
      await refreshAccounts()
      await syncRegion()
    } finally {
      busy.value = false
    }
  })
}
async function selectJob(job: DiscoveredJob) {
  jobOffline.value = false
  selectedId.value = job.id
  selected.value = job
  narrowDetails.value = true
  const seq = ++detailSequence
  const runId = run.value?.id
  detailBusy.value = true
  try {
    if (webMode.value && !accounts.value) {
      await openJobPage(job.id)
      if (seq !== detailSequence) return
      lastRegion = ''
      await syncRegion()
    }
    const detail = await api.detail({
      jobId: job.id,
      runId,
      viewId: viewId.value,
      observationId: job.observationId,
      mode: 'ensure',
    })
    if (seq !== detailSequence) return
    selected.value = detail
  } catch (e) {
    if (errorCode(e) === 'DISCOVERY_JOB_OFFLINE') {
      if (seq === detailSequence) {
        jobOffline.value = true
        selected.value = null
        selectedId.value = ''
        saveOpen.value = false
        await browserMode(false)
      }
      if (run.value?.id === runId) {
        listSequence++
        if (results.value) {
          const previous = results.value
          results.value = {
            ...previous,
            items: previous.items.filter((item) => item.id !== job.id),
            total: Math.max(
              0,
              previous.total - Number(previous.items.some((item) => item.id === job.id)),
            ),
          }
        }
        if (seq !== detailSequence) await safely(loadResults)
      }
    } else if (seq === detailSequence) fail(e)
  } finally {
    if (seq === detailSequence) {
      detailBusy.value = false
      // Completed runs are not polled until a warning is known. Detail reads can
      // introduce a new login/challenge warning, including when they reject.
      if (!disposed && run.value?.id === runId) await refreshRun().catch(fail)
    }
  }
}
async function openJobPage(jobId: string) {
  const requestId = crypto.randomUUID()
  browserRequestId = requestId
  browserLoading.value = true
  await syncRegion()
  if (disposed || !webMode.value || browserRequestId !== requestId) return
  try {
    await api.browser({ action: 'open', jobId, requestId })
  } catch (e) {
    if (browserRequestId === requestId) {
      browserLoading.value = false
      await syncRegion()
      throw e
    }
  }
}
async function browserMode(value: boolean) {
  webMode.value = value
  if (!value) {
    browserRequestId = null
    browserLoading.value = false
  }
  await safely(async () => {
    if (value && selected.value) await openJobPage(selected.value.id)
    else await api.browser({ action: 'close' })
    lastRegion = ''
    await syncRegion()
  })
}
async function browserAction(action: 'back' | 'forward' | 'reload' | 'external') {
  await safely(() => api.browser({ action }))
}
async function openAccounts(target?: { runId: string; platform: JobPlatform }) {
  await closeVerification()
  sourceLogin.value = target ?? null
  accounts.value = true
  qrError.value = ''
  loginPlatform.value = null
  await api.region({ x: 0, y: 0, width: 0, height: 0, visible: false })
  await refreshAccounts()
}
async function login(platform: JobPlatform, method?: QrLoginMethod) {
  const seq = ++qrSequence
  const previous = loginPlatform.value
  loginPlatform.value = platform
  qrBusy.value = true
  qrError.value = ''
  qrState.value = null
  try {
    if (previous) await api.qrLogin({ action: 'cancel', platform: previous })
    if (seq !== qrSequence) return
    const result = await api.qrLogin({ action: 'start', platform, ...(method ? { method } : {}) })
    if (seq === qrSequence && accounts.value) {
      qrState.value = result
      await resumeAfterLogin(result)
    } else if (result)
      await api.qrLogin({ action: 'cancel', platform, attemptId: result.attemptId })
  } catch (e) {
    if (seq === qrSequence) qrError.value = getErrorMessage(e, t)
  } finally {
    if (seq === qrSequence) qrBusy.value = false
  }
}
async function chooseAccount(platform: JobPlatform) {
  if (accountStates.value.find((item) => item.platform === platform)?.state !== 'authenticated')
    return login(platform)
  ++qrSequence
  const previous = loginPlatform.value
  loginPlatform.value = platform
  qrState.value = null
  qrBusy.value = false
  qrError.value = ''
  if (previous) await api.qrLogin({ action: 'cancel', platform: previous })
}
async function verifyLogin(action: 'verify' | 'retry') {
  const current = qrState.value
  if (!current || qrBusy.value) return
  const seq = ++qrSequence
  qrError.value = ''
  // Opening the window returns immediately; it never waits for human verification.
  if (action === 'retry') qrBusy.value = true
  try {
    const result = await api.qrLogin({
      action,
      platform: current.platform,
      attemptId: current.attemptId,
    })
    if (seq === qrSequence && accounts.value) qrState.value = result
    else if (result && result.attemptId !== current.attemptId)
      await api.qrLogin({
        action: 'cancel',
        platform: result.platform,
        attemptId: result.attemptId,
      })
  } catch (e) {
    if (seq === qrSequence) qrError.value = getErrorMessage(e, t)
  } finally {
    if (seq === qrSequence) qrBusy.value = false
  }
}
async function closeAccounts() {
  ++qrSequence
  const platform = loginPlatform.value
  const cancelledSource = sourceLogin.value
  sourceLogin.value = null
  accounts.value = false
  loginPlatform.value = null
  qrState.value = null
  qrBusy.value = false
  if (cancelledSource) await closeVerification()
  if (platform) await api.qrLogin({ action: 'cancel', platform })
  await refreshAccounts()
  lastRegion = ''
  await syncRegion()
}
async function resumeAfterLogin(state: QrLoginState | null) {
  const target = sourceLogin.value
  if (!accounts.value || state?.state !== 'authenticated' || state.platform !== loginPlatform.value)
    return
  if (!target) return closeAccounts()
  if (state.platform !== target.platform || run.value?.id !== target.runId) return
  // Official login success closes the QR panel even if the following search
  // recheck fails. Keep the attempt alive until Main validates its evidence.
  accounts.value = false
  const seq = ++verificationSequence
  try {
    const current = await api.verification({
      action: 'recheck',
      ...target,
      attemptId: state.attemptId,
    })
    if (seq !== verificationSequence || sourceLogin.value !== target || disposed) return
    verificationState.value = current
    await refreshRun()
  } finally {
    if (sourceLogin.value === target) {
      sourceLogin.value = null
      await closeAccounts()
    }
  }
}
async function logout() {
  if (!clearPlatform.value) return
  const p = clearPlatform.value
  await safely(async () => {
    await api.browser({ action: 'clear', platform: p })
    if (loginPlatform.value === p) {
      ++qrSequence
      loginPlatform.value = null
      qrState.value = null
      qrBusy.value = false
      qrError.value = ''
    }
    await refreshAccounts()
    clearPlatform.value = null
  })
}
async function showHistory() {
  historyOpen.value = true
  historyError.value = ''
  historySelected.value = []
  await loadHistory()
  await syncRegion()
}
async function loadHistory() {
  const seq = ++historySequence
  historyBusy.value = true
  historyError.value = ''
  try {
    let result = await api.history(historyPage.value)
    if (seq !== historySequence || disposed) return
    const lastPage = Math.max(1, Math.ceil(result.total / 20))
    if (historyPage.value > lastPage) {
      historyPage.value = lastPage
      return
    }
    history.value = result.items
    historyTotal.value = result.total
    const removable = new Set(deletableHistory.value.map((item) => item.id))
    historySelected.value = historySelected.value.filter((id) => removable.has(id))
  } catch (e) {
    if (seq === historySequence) historyError.value = getErrorMessage(e, t)
  } finally {
    if (seq === historySequence) historyBusy.value = false
  }
}
function selectHistoryPage() {
  historySelected.value = allHistorySelected.value
    ? []
    : deletableHistory.value.map((item) => item.id)
}
function confirmHistoryDelete(id?: string) {
  if (id) historySelected.value = [id]
  if (historySelected.value.length) deleteHistory.value = true
}
async function cancelHistory(item: SearchRun) {
  try {
    await api.cancel(item.id)
    await loadHistory()
    if (run.value?.id === item.id) await refreshRun()
  } catch (e) {
    historyError.value = getErrorMessage(e, t)
  }
}
async function useHistory(item: SearchRun) {
  await closeVerification()
  queryLocked.value = true
  jobOffline.value = false
  run.value = item
  viewId.value = undefined
  const q = item.query
  keyword.value = q.keyword
  city.value = q.city || null
  citySelectionVersion.value++
  selectedPlatforms.value = [...q.platforms]
  salaryMin.value = q.salaryMin ?? null
  salaryMax.value = q.salaryMax ?? null
  selectedId.value = ''
  selected.value = null
  narrowDetails.value = false
  detailSequence++
  page.value = 1
  historyOpen.value = false
  await loadResults()
  await syncRegion()
}
async function removeHistory() {
  if (historyDeleting.value) return false
  // Vue refs expose Proxy arrays; Electron IPC requires a plain cloneable array.
  const ids = [...historySelected.value]
  historyDeleting.value = true
  historyError.value = ''
  try {
    if (run.value && ids.includes(run.value.id)) await closeVerification()
    await api.removeHistory(ids)
    if (run.value && ids.includes(run.value.id)) {
      clearSearchPage()
      await browserMode(false)
    }
    historySelected.value = []
    deleteHistory.value = false
    await loadHistory()
    return true
  } catch (e) {
    historyError.value = getErrorMessage(e, t)
    return false
  } finally {
    historyDeleting.value = false
  }
}
async function openSave() {
  const job = selected.value
  if (!job) return
  error.value = ''
  saveOpen.value = true
  existingCompany.value =
    props.companies.find((company) => company.name === job.company)?.id ?? null
  newCompany.value = false
  newCompanyName.value = job.company
  statusId.value = props.statuses[0]?.id ?? null
  resumeId.value = null
  await syncRegion()
}
async function save() {
  if (!selected.value || !statusId.value) return
  const job = selected.value
  await safely(async () => {
    const result = await api.save({
      jobId: job.id,
      observationId: job.observationId,
      companyId: !newCompany.value ? (existingCompany.value ?? undefined) : undefined,
      newCompanyName: newCompany.value ? newCompanyName.value : undefined,
      statusId: statusId.value!,
      resumeVersionId: resumeId.value,
    })
    if (selected.value?.id === job.id) selected.value.savedOpportunityId = result.opportunityId
    saveOpen.value = false
    emit('saved')
    await loadResults()
    await syncRegion()
  })
}
function drag(event: PointerEvent) {
  const target = event.currentTarget as HTMLElement
  target.setPointerCapture(event.pointerId)
  const move = (e: PointerEvent) => {
    const rect = panes.value?.getBoundingClientRect()
    if (rect) split.value = Math.max(28, Math.min(65, ((e.clientX - rect.left) / rect.width) * 100))
    scheduleRegion()
  }
  const end = () => {
    target.removeEventListener('pointermove', move)
    target.removeEventListener('pointerup', end)
    target.removeEventListener('pointercancel', end)
    void syncRegion()
  }
  target.addEventListener('pointermove', move)
  target.addEventListener('pointerup', end)
  target.addEventListener('pointercancel', end)
}
watch([page, pageSize, sort], (values, previous) => {
  if (values[2] !== previous[2]) viewId.value = undefined
  if (values.slice(1).some((value, i) => value !== previous[i + 1]) && page.value !== 1) {
    page.value = 1
    return
  }
  void safely(loadResults)
})
watch(historyPage, () => void loadHistory())
watch(
  () => props.active,
  () => {
    scheduleRegion()
    if (props.active)
      void safely(async () => {
        await refreshAccounts()
        await refreshRun()
      })
  },
)
watch([historyOpen, saveOpen, clearPlatform, deleteHistory, narrowDetails], scheduleRegion)
onMounted(() => {
  removeBrowserLoadingListener = api.onBrowserLoading((state) => {
    if (disposed || !webMode.value || state.requestId !== browserRequestId) return
    browserLoading.value = state.loading
    void syncRegion()
  })
  if (props.active) void safely(refreshAccounts)
  resize = new ResizeObserver(scheduleRegion)
  if (panes.value) resize.observe(panes.value)
  overlays = new MutationObserver(scheduleRegion)
  overlays.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style', 'class'],
  })
  window.addEventListener('resize', scheduleRegion)
  document.addEventListener('scroll', scheduleRegion, true)
  poll = setTimeout(tick, 1000)
})
onBeforeUnmount(() => {
  disposed = true
  browserRequestId = null
  removeBrowserLoadingListener?.()
  ++verificationSequence
  void api.verification({ action: 'close' }).catch(() => {})
  ++qrSequence
  if (loginPlatform.value) void api.qrLogin({ action: 'cancel', platform: loginPlatform.value })
  detailSequence++
  listSequence++
  clearTimeout(poll)
  cancelAnimationFrame(regionFrame)
  resize?.disconnect()
  overlays?.disconnect()
  window.removeEventListener('resize', scheduleRegion)
  document.removeEventListener('scroll', scheduleRegion, true)
  void api.browser({ action: 'close' }).catch(() => {})
})
defineExpose({
  openAccounts: () => safely(openAccounts),
  openHistory: () => safely(showHistory),
  newSearch,
  busy,
})
</script>

<template>
  <section class="discovery" :class="{ 'show-detail': narrowDetails }">
    <div v-if="webMode && selected" class="discovery-browser-toolbar">
      <n-button
        v-if="narrowDetails"
        class="discovery-back-list"
        size="small"
        @click="narrowDetails = false"
        >{{ label('goList') }}</n-button
      >
      <n-button size="small" @click="browserMode(false)">{{ label('details') }}</n-button>
      <n-button
        v-for="action in ['back', 'forward', 'reload', 'external'] as const"
        :key="action"
        size="small"
        @click="browserAction(action)"
        >{{ label(action === 'reload' ? 'refresh' : action) }}</n-button
      >
      <n-button
        class="discovery-browser-save"
        size="small"
        type="primary"
        :disabled="!!selected.savedOpportunityId"
        @click="openSave"
        >{{ label(selected.savedOpportunityId ? 'saved' : 'save') }}</n-button
      >
    </div>
    <div ref="panes" class="discovery-panes" :style="{ '--list-width': split + '%' }">
      <div class="discovery-list">
        <div class="discovery-search">
          <n-input
            v-model:value="keyword"
            :disabled="inputsDisabled"
            :placeholder="label('keyword')"
            @keyup.enter="submitSearch"
          />
          <n-select
            :key="citySelectionVersion"
            v-model:value="city"
            :disabled="inputsDisabled || !selectedPlatforms.length || !cityOptions.length"
            filterable
            clearable
            :options="cityOptions"
            :filter="filterCity"
            :fallback-option="cityFallback"
            :placeholder="
              label(
                !selectedPlatforms.length
                  ? 'selectPlatformsFirst'
                  : !cityOptions.length
                    ? 'noCommonCities'
                    : 'city',
              )
            "
            @update:show="menu('city', $event)"
          />
          <div class="discovery-search-buttons">
            <n-button
              type="primary"
              :loading="busy"
              :disabled="!running && (run ? !!verificationState : !selectedPlatforms.length)"
              @click="submitSearch"
            >
              <template v-if="running" #icon>
                <n-spin
                  :size="16"
                  :theme-overrides="{ color: 'currentColor' }"
                  aria-hidden="true"
                />
              </template>
              {{ label(running ? 'cancel' : results?.total ? 'continue' : 'search') }}
            </n-button>
            <n-button @click="filtersOpen = !filtersOpen">{{ label('moreFilters') }}</n-button>
            <n-button
              v-if="currentWarning"
              class="discovery-verification"
              type="warning"
              :loading="verificationBusy || verificationState?.phase === 'checking'"
              :disabled="verificationState?.phase === 'resuming'"
              :title="
                label(currentWarning.state === 'challenge' ? 'verificationHint' : 'sourceLoginHint')
              "
              aria-live="polite"
              @click="openVerification"
              >{{ platformNames[currentWarning.platform] }} ·
              {{ label(currentWarning.state) }}</n-button
            >
          </div>
        </div>
        <small v-if="verificationState" class="discovery-subtitle" role="status">{{
          label(
            verificationState.phase === 'resuming'
              ? 'verificationResuming'
              : verificationState.phase === 'checking'
                ? 'verificationChecking'
                : 'verificationHint',
          )
        }}</small>
        <n-checkbox-group
          :value="selectedPlatforms"
          class="discovery-platforms"
          @update:value="selectPlatforms"
          ><n-checkbox
            v-for="p in platforms"
            :key="p"
            :value="p"
            :label="platformNames[p]"
            :disabled="inputsDisabled || !authenticatedPlatforms.has(p)"
            :aria-disabled="inputsDisabled || !authenticatedPlatforms.has(p)"
        /></n-checkbox-group>
        <div v-if="filtersOpen" class="discovery-filters">
          <n-input-number
            v-model:value="salaryMin"
            :disabled="inputsDisabled"
            :min="0"
            :placeholder="label('salaryMin')"
          /><n-input-number
            v-model:value="salaryMax"
            :disabled="inputsDisabled"
            :min="0"
            :placeholder="label('salaryMax')"
          />
        </div>
        <n-alert v-if="error" type="error" closable @close="error = ''">{{ error }}</n-alert>
        <div v-if="otherWarnings.length" class="discovery-actions">
          <div class="discovery-source-warnings" aria-live="polite">
            <template v-for="source in otherWarnings" :key="source.platform">
              <n-tag size="small" type="warning" :title="label(source.message || source.state)"
                >{{ platformNames[source.platform] }} · {{ sourceLabel(source) }}</n-tag
              >
            </template>
          </div>
        </div>
        <div class="discovery-list-tools">
          <span>{{ t('discovery.resultCount', { count: results?.total ?? 0 }) }}</span>
          <n-select
            v-model:value="sort"
            size="small"
            :options="[
              { label: label('relevance'), value: 'relevance' },
              { label: label('salarySort'), value: 'salary' },
              { label: label('discovered'), value: 'discovered' },
            ]"
            @update:show="menu('sort', $event)"
          />
          <n-button size="small" :disabled="!run" @click="safely(refreshResults)">{{
            label('refreshResults')
          }}</n-button>
        </div>
        <p v-if="run" class="discovery-subtitle">{{ label('appendOrder') }}</p>
        <div class="discovery-cards">
          <p v-if="!results?.items.length" class="discovery-empty">
            {{ label(run ? 'empty' : 'intro') }}
          </p>
          <button
            v-for="job in results?.items || []"
            :key="job.id"
            class="discovery-job"
            :class="{ selected: selectedId === job.id }"
            @click="selectJob(job)"
          >
            <div class="discovery-job-heading">
              <strong>{{ job.title }}</strong
              ><span>{{ job.salary || label('none') }}</span>
            </div>
            <p>{{ job.company }} · {{ job.city || label('none') }}</p>
            <small
              >{{ platformNames[job.platform] }} · {{ job.experience || label('none') }} ·
              {{ job.education || label('none') }}</small
            >
            <small v-if="job.savedOpportunityId">{{ label('saved') }}</small>
          </button>
        </div>
        <n-pagination
          v-if="results"
          v-model:page="page"
          v-model:page-size="pageSize"
          :item-count="results.total"
          :page-sizes="[10, 20, 50]"
          :page-slot="4"
          show-size-picker
          @update:show-size-picker="menu('page', $event)"
        />
      </div>
      <div
        class="discovery-divider"
        role="separator"
        aria-orientation="vertical"
        tabindex="0"
        @pointerdown="drag"
        @keydown.left="split = Math.max(28, split - 2)"
        @keydown.right="split = Math.min(65, split + 2)"
      />
      <div class="discovery-detail" :class="{ 'discovery-detail-web': webMode && selected }">
        <n-button
          v-if="!webMode || !selected"
          class="discovery-back-list"
          size="small"
          @click="narrowDetails = false"
          >{{ label('goList') }}</n-button
        >
        <div v-if="jobOffline" class="discovery-offline" role="status">
          {{ t('error.DISCOVERY_JOB_OFFLINE') }}
        </div>
        <p v-else-if="!selected" class="discovery-empty">{{ label('select') }}</p>
        <template v-else
          ><div v-if="!webMode" class="discovery-detail-header">
            <h2>{{ selected.title }}</h2>
            <p>{{ selected.company }} · {{ selected.city }}</p>
            <n-tag v-if="selected.possibleDuplicate" type="warning">{{ label('duplicate') }}</n-tag>
          </div>
          <div
            v-if="webMode"
            ref="region"
            class="discovery-browser-region"
            :aria-busy="browserLoading"
          >
            <div v-if="browserLoading" class="discovery-browser-loading" role="status">
              <n-spin size="large" />
              <span>{{ label('webLoading') }}</span>
            </div>
          </div>
          <div v-else class="discovery-detail-body">
            <n-spin v-if="detailBusy" size="small" />
            <dl>
              <dt>{{ label('original') }}</dt>
              <dd>
                {{ selected.salary || label('none') }}
              </dd>
              <template
                v-for="field in ['experience', 'education', 'recruitment', 'employment'] as const"
                :key="field"
                ><dt>{{ fieldLabel(field) }}</dt>
                <dd>{{ selected[field] || label('none') }}</dd></template
              >
              <dt>{{ label('source') }}</dt>
              <dd>{{ platformNames[selected.platform] }}</dd>
              <dt>{{ label('readAt') }}</dt>
              <dd>{{ time(selected.readAt) }}</dd>
            </dl>
            <n-alert v-if="missing.length" type="warning" :title="label('missing')"
              ><div v-for="[field, reason] in missing" :key="field">
                {{ fieldLabel(field) }}：{{ label(reason!) }}
              </div>
            </n-alert>
            <n-alert v-if="selected.removedFromCurrentSearch" type="info">{{
              label('removedFromSearch')
            }}</n-alert>
            <h3>{{ label('jd') }}</h3>
            <p class="discovery-jd">{{ selected.jd || label('detail_not_read') }}</p>
            <small class="discovery-url">{{ selected.url }}</small>
          </div>
          <div v-if="!webMode" class="discovery-detail-actions">
            <n-button @click="browserMode(true)">{{ label('browser') }}</n-button
            ><n-button type="primary" :disabled="!!selected.savedOpportunityId" @click="openSave">{{
              label(selected.savedOpportunityId ? 'saved' : 'save')
            }}</n-button>
          </div>
        </template>
      </div>
    </div>
    <n-modal :show="accounts" :mask-closable="false" @update:show="!$event && closeAccounts()">
      <n-card
        class="discovery-dialog discovery-accounts"
        :class="{ 'discovery-source-login': sourceLogin }"
        :title="label(sourceLogin ? 'qrPanelTitle' : 'accounts')"
        closable
        @close="closeAccounts"
      >
        <div class="discovery-account-layout">
          <div v-if="!sourceLogin" class="discovery-account-left">
            <div class="discovery-account-grid">
              <div
                v-for="item in accountStates"
                :key="item.platform"
                class="discovery-account"
                :class="{ selected: loginPlatform === item.platform }"
              >
                <n-button
                  text
                  class="discovery-account-name"
                  @click="chooseAccount(item.platform)"
                  >{{ platformNames[item.platform] }}</n-button
                >
                <n-tag
                  size="small"
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
                  :type="loginPlatform === item.platform ? 'primary' : 'default'"
                  @click="chooseAccount(item.platform)"
                  >{{
                    item.state === 'authenticated' ? label('accountDetails') : label('login')
                  }}</n-button
                >
                <n-button
                  size="small"
                  ghost
                  :type="loginPlatform === item.platform ? 'primary' : 'default'"
                  @click="clearPlatform = item.platform"
                  >{{ label('logout') }}</n-button
                >
              </div>
            </div>
            <p class="discovery-subtitle discovery-login-hint">{{ label('loginHint') }}</p>
          </div>
          <DiscoveryLoginPanel
            :platform="loginPlatform"
            :account="selectedAccount"
            :state="qrState"
            :busy="qrBusy"
            :error="qrError"
            :hint="sourceLogin ? label('sourceLoginHint') : undefined"
            @login="login"
            @verify="verifyLogin"
          />
        </div>
        <template #footer
          ><div class="discovery-dialog-footer discovery-account-footer">
            <n-button @click="closeAccounts">{{ label('close') }}</n-button>
          </div></template
        >
      </n-card>
    </n-modal>
    <n-modal v-model:show="historyOpen" :mask-closable="!historyDeleting">
      <n-card
        class="discovery-dialog discovery-history"
        :title="label('history')"
        :closable="!historyDeleting"
        @close="historyOpen = false"
      >
        <div class="discovery-history-toolbar">
          <n-checkbox
            :checked="allHistorySelected"
            :indeterminate="!!historySelected.length && !allHistorySelected"
            :disabled="!deletableHistory.length || historyBusy || historyDeleting"
            @update:checked="selectHistoryPage"
            >{{ label('selectPage') }}</n-checkbox
          >
          <span class="discovery-subtitle">{{
            t('discovery.historySummary', { total: historyTotal, selected: historySelected.length })
          }}</span>
          <n-button
            size="small"
            :loading="historyBusy"
            :disabled="historyDeleting"
            @click="loadHistory"
            >{{ label('refresh') }}</n-button
          >
        </div>
        <p class="discovery-subtitle discovery-history-hint">
          {{ label('continueHint') }} {{ label('activeHistoryHint') }}
        </p>
        <n-alert v-if="historyError" type="error" class="discovery-history-error">{{
          historyError
        }}</n-alert>
        <div class="discovery-history-body" :aria-busy="historyBusy">
          <div v-if="!history.length" class="discovery-history-empty">
            <n-spin v-if="historyBusy" />
            <p v-else>{{ label('noHistory') }}</p>
          </div>
          <n-checkbox-group v-model:value="historySelected">
            <div v-for="item in history" :key="item.id" class="discovery-history-row">
              <n-checkbox
                :value="item.id"
                :aria-label="t('discovery.selectHistory', { keyword: item.query.keyword })"
                :disabled="historyDeleting || ['queued', 'running'].includes(item.state)"
              />
              <div class="discovery-history-info">
                <div class="discovery-history-heading">
                  <strong>{{ item.query.keyword }}</strong
                  ><n-tag v-if="item.query.city" size="small">{{
                    cityLabel(item.query.city, item.query.platforms)
                  }}</n-tag>
                </div>
                <time>{{ time(item.createdAt) }}</time>
                <div class="discovery-history-sources">
                  <span v-for="source in item.sources" :key="source.platform"
                    >{{ platformNames[source.platform] }} · {{ source.count
                    }}<template v-if="sourceErrorStates.has(source.state)">
                      · {{ sourceLabel(source) }}</template
                    ></span
                  >
                </div>
              </div>
              <div class="discovery-history-actions">
                <n-button
                  size="small"
                  :disabled="historyDeleting"
                  @click="safely(() => useHistory(item))"
                  >{{ label('openHistory') }}</n-button
                >
                <n-button
                  v-if="['queued', 'running'].includes(item.state)"
                  size="small"
                  @click="cancelHistory(item)"
                  >{{ label('cancel') }}</n-button
                >
                <n-button
                  v-else
                  size="small"
                  type="error"
                  secondary
                  :disabled="historyDeleting"
                  @click="confirmHistoryDelete(item.id)"
                  >{{ label('deleteOne') }}</n-button
                >
              </div>
            </div>
          </n-checkbox-group>
        </div>
        <template #footer
          ><div class="discovery-history-footer">
            <n-button
              type="error"
              secondary
              :disabled="!historySelected.length || historyBusy"
              :loading="historyDeleting"
              @click="confirmHistoryDelete()"
              >{{ label('delete') }}</n-button
            >
            <n-pagination
              v-model:page="historyPage"
              :item-count="historyTotal"
              :page-size="20"
              :page-slot="5"
              :disabled="historyDeleting"
            /></div
        ></template>
      </n-card>
    </n-modal>
    <n-modal v-model:show="saveOpen"
      ><n-card
        style="width: min(580px, 90vw)"
        :title="label('save')"
        closable
        @close="saveOpen = false"
        ><div class="discovery-save-form">
          <p>{{ label('chooseCompany') }}</p>
          <n-checkbox v-model:checked="newCompany">{{ label('createCompany') }}</n-checkbox
          ><n-input
            v-if="newCompany"
            v-model:value="newCompanyName"
            :placeholder="label('companyName')"
          /><n-select
            v-else
            v-model:value="existingCompany"
            filterable
            :options="companyOptions"
            :placeholder="label('existing')"
            @update:show="menu('company', $event)"
          /><label>{{ label('status') }}</label
          ><n-select
            v-model:value="statusId"
            :options="statusOptions"
            @update:show="menu('status', $event)"
          /><label>{{ label('resume') }}</label
          ><n-select
            v-model:value="resumeId"
            clearable
            :options="resumeOptions"
            @update:show="menu('resume', $event)"
          /><small>{{ label('saveHint') }}</small
          ><n-alert v-if="error" type="error">{{ error }}</n-alert>
        </div>
        <template #footer
          ><n-button
            type="primary"
            :disabled="
              !statusId ||
              (!newCompany && !existingCompany) ||
              (newCompany && !newCompanyName.trim())
            "
            @click="save"
            >{{ label('confirm') }}</n-button
          ></template
        ></n-card
      ></n-modal
    >
    <n-modal
      :show="!!clearPlatform"
      preset="dialog"
      :title="label('logout')"
      :content="label('logoutConfirm')"
      :positive-text="label('logout')"
      :negative-text="label('dismiss')"
      @positive-click="logout"
      @negative-click="clearPlatform = null"
      @close="clearPlatform = null"
    />
    <n-modal
      v-model:show="deleteHistory"
      preset="dialog"
      :title="label('delete')"
      :positive-text="label('delete')"
      :negative-text="label('dismiss')"
      @positive-click="removeHistory"
      :positive-button-props="{ loading: historyDeleting }"
      :mask-closable="!historyDeleting"
      :closable="!historyDeleting"
      :negative-button-props="{ disabled: historyDeleting }"
      ><p>{{ label('deleteConfirm') }}</p>
      <n-alert v-if="historyError" type="error">{{ historyError }}</n-alert></n-modal
    >
  </section>
</template>

<style scoped>
.discovery {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1;
  min-height: 0;
}
.discovery-actions,
.discovery-detail-actions,
.discovery-browser-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.discovery-browser-toolbar {
  flex-shrink: 0;
  min-width: 0;
  flex-wrap: nowrap;
  justify-content: safe flex-end;
  overflow-x: auto;
}
.discovery-browser-toolbar > .n-button {
  flex-shrink: 0;
}
.discovery-source-warnings {
  display: flex;
  flex: 1 1 240px;
  justify-content: flex-end;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 12px;
  min-width: 0;
  margin-left: auto;
}
.discovery-subtitle {
  font-size: 12px;
  opacity: 0.65;
}
.discovery-search {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(100px, 0.65fr);
  gap: 8px;
}
.discovery-search-buttons {
  grid-column: 1 / -1;
  display: flex;
  flex-wrap: nowrap;
  gap: 8px;
}
.discovery-search-buttons > :not(.discovery-verification) {
  flex-shrink: 0;
}
.discovery-verification {
  min-width: 0;
  flex-shrink: 1;
}
.discovery-verification :deep(.n-button__content) {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
}
.discovery-platforms {
  display: flex;
  gap: 8px 12px;
  flex-wrap: wrap;
}
.discovery-filters {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.discovery-panes {
  display: flex;
  flex: 1;
  min-height: 140px;
  overflow: hidden;
  border: 1px solid #8883;
  border-radius: 12px;
}
.discovery-list {
  display: flex;
  flex-direction: column;
  width: var(--list-width);
  min-width: 0;
  overflow: auto;
  padding: 12px;
  gap: 12px;
}
.discovery-list > :not(.discovery-cards) {
  flex-shrink: 0;
}
.discovery-list-tools {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.discovery-list-tools .n-select {
  width: 125px;
}
.discovery-cards {
  overflow: auto;
  flex: 1;
  min-height: 120px;
}
.discovery-job {
  display: block;
  width: 100%;
  text-align: left;
  font: inherit;
  color: inherit;
  background: transparent;
  border: 1px solid #8883;
  border-radius: 8px;
  margin-bottom: 8px;
  padding: 14px;
  cursor: pointer;
}
.discovery-job:hover {
  background: #18a0580a;
}
.discovery-job.selected {
  border-color: #18a058;
  background: #18a0580e;
}
.discovery-job-heading {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}
.discovery-job-heading span {
  color: #18a058;
  font-size: 12px;
  white-space: nowrap;
}
.discovery-job p {
  margin: 8px 0;
}
.discovery-job small {
  opacity: 0.65;
}
.discovery-reasons {
  font-size: 12px;
  color: #bf8b24;
  margin-top: 8px;
}
.discovery-divider {
  width: 6px;
  cursor: col-resize;
  background: #8881;
  touch-action: none;
  flex-shrink: 0;
}
.discovery-detail {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  padding: 16px;
  gap: 12px;
}
.discovery-detail-web {
  padding: 0;
  gap: 0;
}
.discovery-offline {
  flex: 1;
  display: grid;
  place-items: center;
  min-height: 160px;
  font-size: 40px;
  font-weight: 600;
}
.discovery-detail-header h2 {
  font-size: 20px;
  margin: 0 0 6px;
}
.discovery-detail-header p {
  margin: 0;
  opacity: 0.7;
}
.discovery-detail-body {
  overflow: auto;
  flex: 1;
  min-height: 0;
}
.discovery-detail-body dl {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 8px 14px;
}
.discovery-detail-body dt {
  opacity: 0.6;
}
.discovery-detail-body dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.discovery-jd {
  white-space: pre-wrap;
  line-height: 1.85;
  overflow-wrap: anywhere;
}
.discovery-url {
  word-break: break-all;
  opacity: 0.5;
}
.discovery-empty {
  padding: 40px 15px;
  opacity: 0.6;
  line-height: 1.8;
}
.discovery-browser-region {
  position: relative;
  flex: 1;
  min-height: 0;
}
.discovery-browser-loading {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
}
/* Both dialogs keep the requested viewport proportions; only their bodies scroll. */
.discovery-dialog {
  width: 70vw;
  height: 80vh;
  display: flex;
  flex-direction: column;
}
.discovery-dialog :deep(> .n-card-content) {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.discovery-dialog :deep(> .n-card-header),
.discovery-dialog :deep(> .n-card__footer) {
  flex-shrink: 0;
}
.discovery-dialog-footer {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}
.discovery-account-footer {
  justify-content: flex-end;
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
  min-height: 0;
  overflow: auto;
}
.discovery-account-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-auto-rows: minmax(min-content, 1fr);
  gap: 12px;
  flex: 1;
}
.discovery-account {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  justify-content: center;
  gap: 12px;
  padding: 16px 12px;
  border: 1px solid #8883;
  border-radius: 12px;
  min-width: 0;
}
.discovery-account.selected {
  border-color: #18a058;
  background: #18a0580b;
}
.discovery-account-name {
  font-size: 16px;
  font-weight: 650;
}
.discovery-account :deep(.n-tag) {
  align-self: flex-start;
  max-width: 100%;
}
.discovery-login-hint {
  line-height: 1.7;
  margin: 12px 0 0;
}
.discovery-history-toolbar,
.discovery-history-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-shrink: 0;
  flex-wrap: wrap;
}
.discovery-history-toolbar .discovery-subtitle {
  flex: 1;
}
.discovery-history-hint {
  margin: 12px 0;
  line-height: 1.6;
}
.discovery-history-error {
  margin-bottom: 12px;
  flex-shrink: 0;
}
.discovery-history-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.discovery-history-empty {
  display: grid;
  place-content: center;
  min-height: 140px;
  opacity: 0.65;
}
.discovery-history-row {
  display: flex;
  align-items: center;
  gap: 14px;
  border: 1px solid #8883;
  border-radius: 10px;
  padding: 16px;
  margin-bottom: 12px;
}
.discovery-history-info {
  flex: 1;
  min-width: 0;
}
.discovery-history-heading {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.discovery-history-heading strong {
  font-size: 16px;
  overflow-wrap: anywhere;
}
.discovery-history-info time {
  display: block;
  font-size: 12px;
  opacity: 0.6;
  margin-top: 7px;
}
.discovery-history-sources {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  margin-top: 10px;
  font-size: 12px;
}
.discovery-history-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex-shrink: 0;
}
@media (max-width: 1000px) {
  .discovery-dialog :deep(> .n-card-content),
  .discovery-dialog :deep(> .n-card__footer) {
    padding-left: 14px;
    padding-right: 14px;
  }
  .discovery-account-layout {
    gap: 10px;
  }
  .discovery-account-grid {
    gap: 8px;
  }
  .discovery-account {
    padding: 10px 8px;
    gap: 8px;
  }
  .discovery-account-name {
    font-size: 12px;
  }
  .discovery-account :deep(.n-button) {
    font-size: 11px;
  }
  .discovery-history-row {
    padding: 12px;
    gap: 8px;
  }
}
.discovery-save-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.discovery-back-list {
  display: none;
}
@media (max-width: 1000px) {
  .discovery-list {
    width: 100%;
  }
  .discovery-divider,
  .discovery-detail {
    display: none;
  }
  .show-detail .discovery-list {
    display: none;
  }
  .show-detail .discovery-detail {
    display: flex;
  }
  .discovery-back-list {
    display: inline-flex;
    align-self: flex-start;
  }
  .discovery-account-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}
</style>
