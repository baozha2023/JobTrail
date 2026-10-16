import { ref, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import type {
  JobPlatform,
  PlatformStatus,
  QrLoginMethod,
  QrLoginState,
  SourceState,
  SourceVerificationState,
  DiscoveryRecoveryTarget,
} from '../../shared/job-discovery'
import { getErrorMessage } from '../utils/errors'

// Both chat and job discovery use the same official QR attempts and Main recheck.
export function useDiscoveryRecovery(options: {
  refreshAccounts(): Promise<void>
  refreshRun(): Promise<void>
  hideBrowser(): Promise<void>
  restoreBrowser(): Promise<void>
  account(platform: JobPlatform): PlatformStatus | undefined
  fail(error: unknown): void
  recovered?(target: DiscoveryRecoveryTarget): void
}) {
  const { t } = useI18n()
  const api = window.zhijiApi.discovery
  const accounts = ref(false)
  const loginPlatform = ref<JobPlatform | null>(null)
  const qrState = ref<QrLoginState | null>(null)
  const qrBusy = ref(false)
  const qrError = ref('')
  const sourceLogin = shallowRef<DiscoveryRecoveryTarget | null>(null)
  const verificationState = ref<SourceVerificationState | null>(null)
  const verificationBusy = ref(false)
  let qrSequence = 0
  let verificationSequence = 0
  let disposed = false
  let ownedVerification: { runId: string | null; platform: JobPlatform } | null = null

  async function closeVerification() {
    ++verificationSequence
    verificationState.value = null
    ownedVerification = null
    await api.verification({ action: 'close' })
  }

  async function openAccounts(target?: DiscoveryRecoveryTarget) {
    const seq = ++qrSequence
    await closeVerification()
    if (disposed || seq !== qrSequence) return
    sourceLogin.value = target ?? null
    accounts.value = true
    qrError.value = ''
    loginPlatform.value = null
    await options.hideBrowser()
    if (disposed || seq !== qrSequence) return
    await options.refreshAccounts()
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
    if (disposed) return
    await options.refreshAccounts()
    await options.restoreBrowser()
  }

  async function resumeAfterLogin(state: QrLoginState | null) {
    const target = sourceLogin.value
    if (!accounts.value || !target || state?.state !== 'authenticated') return
    if (state.platform !== target.platform || state.platform !== loginPlatform.value) return
    // Close on official confirmation even if scheduling the search recheck fails.
    // Keep the confirmed attempt alive until Main has validated its attemptId.
    accounts.value = false
    const seq = ++verificationSequence
    try {
      if (target.runId) {
        ownedVerification = { runId: target.runId, platform: target.platform }
        const current = await api.verification({
          action: 'recheck',
          runId: target.runId,
          platform: target.platform,
          attemptId: state.attemptId,
        })
        if (seq !== verificationSequence || sourceLogin.value !== target || disposed) return
        verificationState.value = current
        await options.refreshRun()
      }
    } finally {
      if (sourceLogin.value === target) {
        sourceLogin.value = null
        await closeAccounts()
        if (!target.runId && !disposed) options.recovered?.(target)
      }
    }
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
      if (seq !== qrSequence || disposed) return
      const result = await api.qrLogin({ action: 'start', platform, ...(method ? { method } : {}) })
      if (seq === qrSequence && accounts.value && !disposed) {
        qrState.value = result
        await resumeAfterLogin(result)
      } else if (result)
        await api.qrLogin({ action: 'cancel', platform, attemptId: result.attemptId })
    } catch (error) {
      if (seq === qrSequence) qrError.value = getErrorMessage(error, t)
    } finally {
      if (seq === qrSequence) qrBusy.value = false
    }
  }

  async function chooseAccount(platform: JobPlatform) {
    if (options.account(platform)?.state !== 'authenticated') return login(platform)
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
    if (action === 'retry') qrBusy.value = true
    try {
      const result = await api.qrLogin({
        action,
        platform: current.platform,
        attemptId: current.attemptId,
      })
      if (seq === qrSequence && accounts.value && !disposed) {
        qrState.value = result
        await resumeAfterLogin(result)
      } else if (result && result.attemptId !== current.attemptId)
        await api.qrLogin({
          action: 'cancel',
          platform: result.platform,
          attemptId: result.attemptId,
        })
    } catch (error) {
      if (seq === qrSequence) qrError.value = getErrorMessage(error, t)
    } finally {
      if (seq === qrSequence) qrBusy.value = false
    }
  }

  async function openVerification(target: DiscoveryRecoveryTarget, state: SourceState) {
    if (verificationBusy.value || disposed) return false
    verificationBusy.value = true
    try {
      if (state === 'login_required' || state === 'session_expired') {
        await openAccounts(target)
        if (accounts.value && sourceLogin.value === target) await login(target.platform)
      } else if (state === 'challenge') {
        const seq = ++verificationSequence
        ownedVerification = { runId: target.runId ?? null, platform: target.platform }
        const current = await api.verification(
          target.runId
            ? { action: 'open', runId: target.runId, platform: target.platform }
            : { action: 'account', platform: target.platform },
        )
        if (seq === verificationSequence && !disposed) verificationState.value = current
      }
      return true
    } catch (error) {
      options.fail(error)
      return false
    } finally {
      verificationBusy.value = false
    }
  }

  async function pollQr() {
    const current = qrState.value
    const seq = qrSequence
    if (
      !accounts.value ||
      !current ||
      !['loading', 'waiting', 'scanned', 'challenge'].includes(current.state)
    )
      return
    const next = await api.qrLogin({
      action: 'get',
      platform: current.platform,
      attemptId: current.attemptId,
    })
    if (seq === qrSequence && !disposed && qrState.value?.attemptId === current.attemptId) {
      qrState.value = next
      await resumeAfterLogin(next)
    }
  }

  async function pollVerification() {
    const seq = verificationSequence
    const current = await api.verification({ action: 'get' })
    if (seq === verificationSequence && !disposed) {
      verificationState.value = current
      if (
        !current ||
        current.runId !== ownedVerification?.runId ||
        current.platform !== ownedVerification.platform
      )
        ownedVerification = null
    }
  }

  function reset() {
    ++verificationSequence
    verificationState.value = null
    verificationBusy.value = false
  }

  function forgetAccount() {
    ++qrSequence
    loginPlatform.value = null
    qrState.value = null
  }

  async function dispose() {
    disposed = true
    ++qrSequence
    ++verificationSequence
    await closeOwnedVerification()
    if (loginPlatform.value) await api.qrLogin({ action: 'cancel', platform: loginPlatform.value })
  }

  async function closeOwnedVerification() {
    const owner = ownedVerification
    if (!owner) return
    const current = await api.verification({ action: 'get' })
    if (owner !== ownedVerification) return
    if (current?.runId === owner.runId && current.platform === owner.platform)
      await closeVerification()
    else ownedVerification = null
  }

  return {
    accounts,
    loginPlatform,
    qrState,
    qrBusy,
    qrError,
    sourceLogin,
    verificationState,
    verificationBusy,
    openAccounts,
    closeAccounts,
    login,
    chooseAccount,
    verifyLogin,
    openVerification,
    closeVerification,
    pollQr,
    pollVerification,
    reset,
    forgetAccount,
    dispose,
    closeOwnedVerification,
  }
}
