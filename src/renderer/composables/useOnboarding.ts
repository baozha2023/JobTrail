import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import type { Driver, PopoverDOM } from 'driver.js'
import 'driver.js/dist/driver.css'
import '../onboarding.css'
import type {
  AppConfig,
  AppConfigUpdate,
  AppTourStepId,
  DiscoveryTourStepId,
  TourId,
} from '../../shared/types'
import type { ViewKey } from '../types'
import { reportRendererFault } from '../diagnostics'
import { visibleTourTarget, waitForTourLayout } from '../utils/tour-dom'

export const appTourSteps = [
  'opportunities',
  'calendar',
  'statuses',
  'industries',
  'resumes',
  'companies',
  'discovery',
  'agent',
  'settings',
] as const satisfies readonly AppTourStepId[]
export const discoveryTourSteps = [
  'accounts',
  'account-list',
  'qr-panel',
  'platforms',
  'keyword',
  'city',
  'salary',
  'search',
  'results',
  'details',
  'new-search',
  'history',
] as const satisfies readonly DiscoveryTourStepId[]
export interface DiscoveryTourHost {
  prepareTour(step: DiscoveryTourStepId | null, signal: AbortSignal): Promise<void>
  endTour(): void
  tourBlocked: boolean
}
interface Options {
  config: Ref<AppConfig | null>
  activeView: Ref<ViewKey>
  ready: Ref<boolean>
  dark: Ref<boolean>
  locale: Ref<string>
  discovery: Ref<DiscoveryTourHost | undefined>
  save: (patch: AppConfigUpdate) => Promise<void>
  t: (key: string) => string
  showError: (error: unknown) => void
}

export function useOnboarding(options: Options) {
  const current = ref<TourId | null>(null)
  const active = computed(() => current.value !== null)
  const busy = ref(false)
  const failed = ref(false)
  let index = 0
  let instance: Driver | undefined
  let popover: PopoverDOM | undefined
  let retry: (() => Promise<void>) | undefined
  let cancellation = new AbortController()
  let mounted = false
  let disposed = false
  let previousFocus: HTMLElement | null = null
  let observer: MutationObserver | undefined
  let resize: ResizeObserver | undefined
  let frame = 0
  let queued = false
  const suspended = new Set<TourId>()
  const steps = (id: TourId) => (id === 'app' ? appTourSteps : discoveryTourSteps)
  const selector = (id: TourId, at: number) => `[data-tour="${id}-${steps(id)[at]}"]`

  function blocked() {
    return (
      !options.ready.value ||
      document.visibilityState === 'hidden' ||
      !!options.discovery.value?.tourBlocked ||
      Array.from(
        document.querySelectorAll(
          '.n-modal,.n-dialog,.n-base-select-menu,.n-dropdown-menu,.n-popover',
        ),
      ).some(
        (element) => !element.hasAttribute('data-tour-owned-modal') && visibleTourTarget(element),
      )
    )
  }

  function paint() {
    const id = current.value
    if (!popover || !id) return
    const step = steps(id)[index]
    popover.wrapper.classList.toggle('is-dark', options.dark.value)
    popover.wrapper.lang = options.locale.value
    popover.title.textContent = options.t(`onboarding.${id}.${step}.title`)
    popover.description.textContent = options.t(`onboarding.${id}.${step}.description`)
    popover.progress.textContent = `${index + 1} / ${steps(id).length}`
    const { closeButton, previousButton, nextButton, footerButtons } = popover
    closeButton.classList.add('driver-popover-footer-btn')
    closeButton.textContent = options.t(failed.value ? 'onboarding.pause' : 'onboarding.skip')
    closeButton.setAttribute('aria-label', closeButton.textContent)
    footerButtons.prepend(closeButton)
    previousButton.style.display = 'inline-block'
    previousButton.textContent = options.t('onboarding.previous')
    nextButton.textContent = options.t(
      failed.value
        ? 'onboarding.retry'
        : index === steps(id).length - 1
          ? 'onboarding.done'
          : 'onboarding.next',
    )
    closeButton.disabled = busy.value
    previousButton.disabled = busy.value || failed.value || index === 0
    nextButton.disabled = busy.value
    for (const button of [previousButton, nextButton, closeButton])
      button.classList.toggle('driver-popover-btn-disabled', button.disabled)
    if (!busy.value && !popover.wrapper.contains(document.activeElement))
      closeButton.focus({ preventScroll: true })
    let error = popover.wrapper.querySelector<HTMLElement>('.tour-error')
    if (failed.value && !error) {
      error = document.createElement('p')
      error.className = 'tour-error'
      error.setAttribute('role', 'alert')
      popover.footer.before(error)
    }
    if (error) {
      error.textContent = options.t('onboarding.saveError')
      error.hidden = !failed.value
    }
  }

  function pause(suppress = false) {
    const id = current.value
    if (suppress && id) suspended.add(id)
    cancellation.abort()
    current.value = null
    resize?.disconnect()
    instance?.destroy()
    instance = undefined
    popover = undefined
    if (id) options.discovery.value?.endTour()
    failed.value = false
    retry = undefined
    previousFocus?.focus({ preventScroll: true })
    previousFocus = null
  }

  async function exclusive(work: () => Promise<void>) {
    if (busy.value || disposed) return
    busy.value = true
    paint()
    try {
      await work()
    } catch (error) {
      if (!cancellation.signal.aborted) {
        reportRendererFault('onboarding.transition', error)
        options.showError(error)
        pause(true)
      }
    } finally {
      busy.value = false
      paint()
      schedule()
    }
  }

  async function persist(patch: AppConfigUpdate, again: () => Promise<void>): Promise<boolean> {
    try {
      await options.save(patch)
      failed.value = false
      return true
    } catch (error) {
      if (cancellation.signal.aborted) return false
      reportRendererFault('onboarding.save', error)
      // Keep an existing step available for retry. Before the first popover, pause safely.
      if (!popover) {
        options.showError(error)
        pause(true)
      } else {
        failed.value = true
        retry = again
      }
      return false
    }
  }

  async function move(to: number) {
    const id = current.value
    if (!id || to < 0 || to >= steps(id).length) return
    const signal = cancellation.signal
    const oldIndex = index
    await options.discovery.value?.prepareTour(
      id === 'discovery' ? discoveryTourSteps[to] : null,
      signal,
    )
    await nextTick()
    await waitForTourLayout(
      () => visibleTourTarget(document.querySelector(selector(id, to))),
      signal,
    )
    const patch: AppConfigUpdate =
      id === 'app'
        ? { onboarding: { app: { status: 'inProgress', stepId: appTourSteps[to] } } }
        : { onboarding: { discovery: { status: 'inProgress', stepId: discoveryTourSteps[to] } } }
    if (!(await persist(patch, () => move(to)))) {
      if (popover && !signal.aborted) {
        await options.discovery.value?.prepareTour(
          id === 'discovery' ? discoveryTourSteps[oldIndex] : null,
          signal,
        )
        await nextTick()
        await waitForTourLayout(
          () => visibleTourTarget(document.querySelector(selector(id, oldIndex))),
          signal,
        )
        // Modal targets may have been unmounted and recreated while restoring the saved step.
        instance?.drive(oldIndex)
      }
      return
    }
    if (signal.aborted) return
    index = to
    instance?.drive(to)
    resize?.disconnect()
    const target = document.querySelector(selector(id, to))
    if (target) resize?.observe(target)
    paint()
  }

  async function finish(status: 'completed' | 'skipped') {
    const id = current.value
    if (!id) return
    const signal = cancellation.signal
    if (
      (await persist({ onboarding: { [id]: { status, stepId: null } } }, () => finish(status))) &&
      !signal.aborted
    ) {
      pause()
      schedule()
    }
  }

  function next() {
    void exclusive(() =>
      failed.value && retry
        ? retry()
        : current.value && index === steps(current.value).length - 1
          ? finish('completed')
          : move(index + 1),
    )
  }
  function close() {
    if (busy.value) return
    if (failed.value) pause(true)
    else void exclusive(() => finish('skipped'))
  }

  async function start(id: TourId, restart: boolean) {
    if (!options.config.value || blocked()) return
    const saved = options.config.value.onboarding[id]
    const at =
      !restart && saved.status === 'inProgress'
        ? steps(id).findIndex((step) => step === saved.stepId)
        : 0
    if (at < 0) throw new Error('Unknown tour step')
    const { driver } = await import('driver.js')
    if (disposed || blocked()) return
    cancellation = new AbortController()
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    current.value = id
    resize ??= new ResizeObserver(refresh)
    index = at
    instance = driver({
      animate: false,
      overlayOpacity: 0.5,
      stagePadding: 6,
      stageRadius: 8,
      popoverOffset: 12,
      allowKeyboardControl: false,
      disableActiveInteraction: true,
      overlayClickBehavior: 'none',
      showProgress: true,
      showButtons: ['close', 'previous', 'next'],
      popoverClass: 'jobtrail-tour',
      steps: steps(id).map((_, i) => ({
        element: selector(id, i),
        popover: {
          title: ' ',
          description: ' ',
          side: id === 'app' ? 'right' : 'bottom',
          align: 'start',
        },
      })),
      onPopoverRender: (dom) => {
        popover = dom
        paint()
        dom.closeButton.focus({ preventScroll: true })
      },
      onNextClick: next,
      onDoneClick: next,
      onPrevClick: () => {
        if (!failed.value) void exclusive(() => move(index - 1))
      },
      onCloseClick: close,
    })
    await move(at)
  }

  function reconcile() {
    queued = false
    if (!mounted || disposed) return
    if (
      current.value &&
      (blocked() || (current.value === 'discovery' && options.activeView.value !== 'discovery'))
    ) {
      pause()
      return
    }
    if (busy.value || blocked()) return
    if (current.value) {
      if (!visibleTourTarget(document.querySelector(selector(current.value, index)))) {
        const error = new Error('Tour target disappeared')
        reportRendererFault('onboarding.target', error)
        options.showError(error)
        pause(true)
      }
      return
    }
    const progress = options.config.value?.onboarding
    if (!progress) return
    for (const id of ['app', 'discovery'] as const) {
      if (id === 'discovery' && options.activeView.value !== 'discovery') continue
      if (suspended.has(id) || !['pending', 'inProgress'].includes(progress[id].status)) continue
      void exclusive(() => start(id, false))
      return
    }
  }
  function schedule() {
    if (queued || disposed) return
    queued = true
    queueMicrotask(reconcile)
  }
  function refresh() {
    if (!current.value || frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      instance?.refresh()
    })
  }
  function keyboard(event: KeyboardEvent) {
    if (!active.value) return
    const own = event.target instanceof Element && !!event.target.closest('.jobtrail-tour')
    // Driver's default focus loop also includes the target. Keep business controls read-only.
    if (event.key === 'Tab') {
      event.preventDefault()
      event.stopImmediatePropagation()
      const buttons = Array.from(
        popover?.footerButtons.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [],
      )
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
      buttons[(at + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus()
    } else if (event.key === 'Escape' || event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault()
      event.stopImmediatePropagation()
      if (event.key === 'Escape') close()
      else if (!failed.value && event.key === 'ArrowLeft') void exclusive(() => move(index - 1))
      else if (event.key === 'ArrowRight') next()
    } else if (!own) {
      event.preventDefault()
      event.stopImmediatePropagation()
    }
  }
  function focus(event: FocusEvent) {
    if (
      active.value &&
      popover &&
      event.target instanceof Element &&
      !event.target.closest('.jobtrail-tour')
    )
      popover.closeButton.focus({ preventScroll: true })
  }
  function pointer(event: Event) {
    if (
      active.value &&
      (!(event.target instanceof Element) || !event.target.closest('.jobtrail-tour'))
    ) {
      // Covers preparation / config writes before Driver has installed its own overlay.
      event.preventDefault()
      event.stopImmediatePropagation()
    }
  }
  function restart(id: TourId) {
    if (busy.value) return
    pause()
    suspended.delete(id)
    if (id === 'discovery') options.activeView.value = 'discovery'
    void exclusive(async () => {
      await nextTick()
      await start(id, true)
    })
  }
  watch([options.ready, options.config, options.activeView], schedule, { flush: 'post' })
  watch(options.activeView, (view) => {
    if (view === 'discovery') suspended.delete('discovery')
  })
  watch(
    [options.dark, options.locale],
    () => {
      paint()
      refresh()
    },
    { flush: 'post' },
  )
  onMounted(() => {
    mounted = true
    observer = new MutationObserver(schedule)
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style'],
    })
    window.addEventListener('resize', refresh)
    document.addEventListener('scroll', refresh, true)
    document.addEventListener('visibilitychange', schedule)
    window.addEventListener('keydown', keyboard, true)
    document.addEventListener('focusin', focus, true)
    document.addEventListener('pointerdown', pointer, true)
    document.addEventListener('click', pointer, true)
    window.addEventListener('pagehide', pauseOnHide)
    schedule()
  })
  function pauseOnHide() {
    pause()
  }
  onBeforeUnmount(() => {
    disposed = true
    observer?.disconnect()
    resize?.disconnect()
    cancelAnimationFrame(frame)
    window.removeEventListener('resize', refresh)
    document.removeEventListener('scroll', refresh, true)
    document.removeEventListener('visibilitychange', schedule)
    window.removeEventListener('keydown', keyboard, true)
    document.removeEventListener('focusin', focus, true)
    document.removeEventListener('pointerdown', pointer, true)
    document.removeEventListener('click', pointer, true)
    window.removeEventListener('pagehide', pauseOnHide)
    pause()
  })
  return { active, restart, pause }
}
