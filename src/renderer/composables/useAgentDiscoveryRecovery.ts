import { computed, onBeforeUnmount, reactive, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { z } from 'zod'
import type { AgentMessage } from '../../shared/types'
import {
  discoveryRunOutputSchema,
  discoveryStatusOutputSchema,
  discoveryJobOutputSchema,
  needsHumanAction,
  platforms as allPlatforms,
  type JobPlatform,
  type PlatformStatus,
  type SearchRun,
  type SourceState,
  type DiscoveryRecoveryTarget,
} from '../../shared/job-discovery'
import { useDiscoveryRecovery } from './useDiscoveryRecovery'
import { errorCode, getErrorMessage } from '../utils/errors'
import { reportRendererFault } from '../diagnostics'

export function useAgentDiscoveryRecovery(
  props: {
    messages: AgentMessage[]
    conversationId: string | null
    enabled: boolean
  },
  recovered: (target: DiscoveryRecoveryTarget) => void,
) {
  const { t } = useI18n()
  const api = window.zhijiApi.discovery
  const runs = ref<Record<string, SearchRun>>({})
  const accountStates = ref<PlatformStatus[]>([])
  const jobPlatforms = ref<JobPlatform[]>([])
  const error = ref('')
  const pendingRecovery = shallowRef<DiscoveryRecoveryTarget | null>(null)
  const unavailableRuns = reactive(new Set<string>())
  let sequence = 0
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const runTools = new Set([
    'start_job_search',
    'get_job_search',
    'continue_job_search',
    'cancel_job_search',
    'list_discovered_jobs',
    'list_job_search_history',
    'get_discovered_job',
  ])

  function object(text: string | null): Record<string, unknown> {
    if (!text) return {}
    try {
      const value: unknown = JSON.parse(text)
      return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {}
    } catch {
      return {}
    }
  }

  const contexts = computed(() => {
    const searches = new Map<string, SearchRun | null>()
    const platforms = new Map<JobPlatform, PlatformStatus | null>()
    const jobs = new Set<string>()
    for (const message of props.messages) {
      if (message.role !== 'tool' || message.result === null) continue
      const result = object(message.result)
      const args = object(message.args)
      if (runTools.has(message.name)) {
        const id = z.string().uuid().safeParse(args.runId)
        if (id.success) searches.set(id.data, searches.get(id.data) ?? null)
        const items =
          message.name === 'list_job_search_history' && Array.isArray(result.items)
            ? result.items
            : [result.item]
        for (const item of items) {
          const run = discoveryRunOutputSchema.safeParse(item)
          if (run.success && z.string().uuid().safeParse(run.data.id).success)
            searches.set(run.data.id, run.data)
        }
        if (message.name === 'get_discovered_job' && !id.success) {
          const job = discoveryJobOutputSchema.safeParse(result.item)
          if (job.success) platforms.set(job.data.platform, null)
          else if (typeof args.jobId === 'string' && args.jobId.length <= 100) jobs.add(args.jobId)
        }
      }
      if (message.name === 'get_job_platform_status') {
        for (const platform of allPlatforms) platforms.set(platform, null)
        for (const item of Array.isArray(result.items) ? result.items : []) {
          const account = discoveryStatusOutputSchema.safeParse(item)
          if (account.success) platforms.set(account.data.platform, account.data)
        }
      }
    }
    return { searches, platforms, jobs }
  })

  type RecoveryCard = DiscoveryRecoveryTarget & { state: SourceState; key: string }
  const cards = computed<RecoveryCard[]>(() => {
    if (!props.enabled) return []
    const items: RecoveryCard[] = []
    const covered = new Set<JobPlatform>()
    for (const [id, original] of contexts.value.searches) {
      if (unavailableRuns.has(id)) continue
      const run = runs.value[id] ?? original
      if (!run || run.state === 'cancelled' || run.state === 'interrupted') continue
      for (const source of run.sources) {
        if (!needsHumanAction(source.state)) continue
        covered.add(source.platform)
        items.push({
          runId: id,
          platform: source.platform,
          state: source.state,
          key: id + source.platform,
        })
      }
    }
    const accounts = new Map(contexts.value.platforms)
    for (const platform of jobPlatforms.value) accounts.set(platform, null)
    for (const [platform, original] of accounts) {
      const account = accountStates.value.find((item) => item.platform === platform) ?? original
      if (!covered.has(platform) && account && needsHumanAction(account.state))
        items.push({ platform, state: account.state, key: platform })
    }
    return items
  })

  function fail(cause: unknown) {
    reportRendererFault('agent.discovery-recovery', cause)
    error.value = getErrorMessage(cause, t)
  }
  async function refreshAccounts() {
    if (!props.enabled || disposed) return
    const seq = sequence
    const items = await api.status()
    if (seq === sequence && !disposed) accountStates.value = items
  }
  async function refreshRuns() {
    if (!props.enabled || disposed) return
    const seq = sequence
    const ids = [...contexts.value.searches.keys()].filter((id) => !unavailableRuns.has(id))
    const results = await Promise.allSettled(ids.map((id) => api.run(id)))
    if (seq !== sequence || disposed) return
    for (const [index, result] of results.entries()) {
      if (result.status === 'fulfilled') runs.value[ids[index]] = result.value
      else if (errorCode(result.reason) === 'NOT_FOUND') unavailableRuns.add(ids[index])
      else fail(result.reason)
    }
  }
  const recovery = useDiscoveryRecovery({
    refreshAccounts,
    refreshRun: refreshRuns,
    hideBrowser: () => api.region({ x: 0, y: 0, width: 0, height: 0, visible: false }),
    restoreBrowser: async () => {},
    account: (platform) => accountStates.value.find((item) => item.platform === platform),
    fail,
    recovered: (target) => {
      if (pendingRecovery.value !== target || disposed || !props.enabled) return
      pendingRecovery.value = null
      recovered(target)
    },
  })
  const { accounts, loginPlatform, qrState, qrBusy, qrError, verificationState, verificationBusy } =
    recovery
  const selectedAccount = computed(() =>
    accountStates.value.find((item) => item.platform === loginPlatform.value),
  )

  async function tick() {
    timer = undefined
    const seq = sequence
    try {
      await recovery.pollQr()
      if (seq !== sequence || disposed) return
      await recovery.pollVerification()
      if (seq !== sequence || disposed) return
      await refreshRuns()
      await refreshAccounts()
      if (seq !== sequence || disposed) return
      const target = pendingRecovery.value
      const run = target?.runId ? runs.value[target.runId] : null
      if (run?.state === 'cancelled' || run?.state === 'interrupted') {
        pendingRecovery.value = null
        return
      }
      const source = run?.sources.find((item) => item.platform === target?.platform)
      if (
        target &&
        !verificationState.value &&
        !accounts.value &&
        ((source && (source.state === 'completed' || source.state === 'partial')) ||
          (!target.runId &&
            accountStates.value.find((item) => item.platform === target.platform)?.state ===
              'authenticated'))
      ) {
        pendingRecovery.value = null
        recovered(target)
      }
    } catch (cause) {
      if (seq === sequence) fail(cause)
    } finally {
      if (
        seq === sequence &&
        !disposed &&
        props.enabled &&
        (cards.value.length ||
          verificationState.value ||
          accounts.value ||
          Object.values(runs.value).some((run) => ['queued', 'running'].includes(run.state)))
      )
        timer = setTimeout(() => void tick(), 1600)
    }
  }

  async function open(card: RecoveryCard) {
    const seq = sequence
    error.value = ''
    pendingRecovery.value = card
    const opened = await recovery.openVerification(card, card.state)
    if (seq !== sequence || disposed) return
    if (!opened) pendingRecovery.value = null
    if (!timer) timer = setTimeout(() => void tick(), 1600)
  }
  async function close() {
    pendingRecovery.value = null
    try {
      await recovery.closeAccounts()
    } catch (cause) {
      fail(cause)
    }
  }

  watch(
    () => [props.conversationId, props.enabled, contexts.value] as const,
    async (value, previous) => {
      const seq = ++sequence
      clearTimeout(timer)
      timer = undefined
      if (!previous || value[0] !== previous[0] || !value[1]) {
        runs.value = {}
        accountStates.value = []
        jobPlatforms.value = []
        unavailableRuns.clear()
        error.value = ''
        pendingRecovery.value = null
        if (previous) {
          try {
            await recovery.closeAccounts()
            await recovery.closeOwnedVerification()
          } catch (cause) {
            fail(cause)
          }
        }
      }
      if (seq !== sequence || !value[1] || disposed) return
      for (const [id, run] of contexts.value.searches)
        if (run && !runs.value[id]) runs.value[id] = run
      for (const jobId of contexts.value.jobs) {
        try {
          const job = await api.detail({ jobId, mode: 'snapshot' })
          if (seq !== sequence || disposed) return
          if (!jobPlatforms.value.includes(job.platform)) jobPlatforms.value.push(job.platform)
        } catch (cause) {
          if (seq === sequence && !disposed) fail(cause)
        }
      }
      if (
        contexts.value.searches.size ||
        contexts.value.platforms.size ||
        jobPlatforms.value.length
      )
        await tick()
    },
    { immediate: true },
  )

  onBeforeUnmount(() => {
    disposed = true
    ++sequence
    clearTimeout(timer)
    void recovery.dispose().catch((cause) => reportRendererFault('agent.discovery-cleanup', cause))
  })
  return {
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
  }
}
