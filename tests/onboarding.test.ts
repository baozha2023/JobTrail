// @vitest-environment jsdom
import { defineComponent, h, nextTick, ref } from 'vue'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { NButton, NConfigProvider, NMenu } from 'naive-ui'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  useOnboarding,
  appTourSteps,
  discoveryTourSteps,
  type DiscoveryTourHost,
} from '../src/renderer/composables/useOnboarding'
import JobDiscoveryView from '../src/renderer/views/JobDiscoveryView.vue'
import { CONFIG_V2_DEFAULTS } from '../src/main/persistence/config-v2'
import type { AppConfig, AppConfigUpdate } from '../src/shared/types'
import type { ViewKey } from '../src/renderer/types'
import { platforms } from '../src/shared/job-discovery'
import { i18n } from '../src/renderer/i18n'

let wrapper: VueWrapper | undefined
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  )
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }))
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const hidden = this.closest('[style*="display: none"]')
    return {
      x: 20,
      y: 20,
      top: 20,
      left: 20,
      bottom: hidden ? 20 : 80,
      right: hidden ? 20 : 220,
      width: hidden ? 0 : 200,
      height: hidden ? 0 : 60,
      toJSON() {},
    }
  })
  HTMLElement.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal('diagnosticsApi', { report: vi.fn().mockResolvedValue(undefined) })
})
afterEach(async () => {
  wrapper?.unmount()
  wrapper = undefined
  await flushPromises()
  document.body.innerHTML = ''
  document.body.className = ''
  i18n.global.locale.value = 'zh-CN'
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function fixture(saved = structuredClone(CONFIG_V2_DEFAULTS), realDiscovery = false) {
  const config = ref<AppConfig | null>(saved)
  const activeView = ref<ViewKey>('opportunities')
  const ready = ref(true),
    dark = ref(false)
  const discovery = ref<DiscoveryTourHost>()
  const businessClick = vi.fn()
  const save = vi.fn(async (patch: AppConfigUpdate) => {
    config.value = {
      ...config.value!,
      ...patch,
      onboarding: { ...config.value!.onboarding, ...patch.onboarding },
      ai: { ...config.value!.ai, ...patch.ai },
      mcp: { ...config.value!.mcp, ...patch.mcp },
    }
  })
  const showError = vi.fn()
  const api = {
    status: vi.fn(async () =>
      platforms.map((platform) => ({
        platform,
        state: 'unknown',
        checkedAt: null,
        limitations: [],
      })),
    ),
    region: vi.fn(async () => {}),
    verification: vi.fn(async () => null),
    browser: vi.fn(async () => {}),
    onBrowserLoading: vi.fn(() => () => {}),
    qrLogin: vi.fn(),
    start: vi.fn(),
    save: vi.fn(),
    cancel: vi.fn(),
  }
  vi.stubGlobal('zhijiApi', { discovery: api })
  let tour!: ReturnType<typeof useOnboarding>
  wrapper = mount(
    defineComponent({
      setup() {
        tour = useOnboarding({
          config,
          activeView,
          ready,
          dark,
          locale: i18n.global.locale,
          discovery,
          save,
          t: i18n.global.t,
          showError,
        })
        return () =>
          h(NConfigProvider, null, {
            default: () => [
              h(NMenu, {
                nodeProps: (option) => ({ 'data-tour': `app-${option.key}` }),
                options: appTourSteps.map((step) => ({
                  key: step,
                  label: step,
                  props: { class: 'test-nav', 'data-tour': `app-${step}` },
                })),
                'onUpdate:value': businessClick,
              }),
              h(
                'div',
                { style: { display: activeView.value === 'discovery' ? '' : 'none' } },
                realDiscovery
                  ? [
                      ...['accounts', 'new-search', 'history'].map((step) =>
                        h(
                          NButton,
                          { 'data-tour': `discovery-${step}`, onClick: businessClick },
                          { default: () => step },
                        ),
                      ),
                      h(JobDiscoveryView, {
                        ref: discovery,
                        active: activeView.value === 'discovery',
                        tourActive: tour.active.value,
                        companies: [],
                        statuses: [],
                        resumes: [],
                      }),
                    ]
                  : discoveryTourSteps.map((step) =>
                      h(
                        'button',
                        { 'data-tour': `discovery-${step}`, onClick: businessClick },
                        step,
                      ),
                    ),
              ),
            ],
          })
      },
    }),
    { attachTo: document.body, global: { plugins: [i18n], stubs: { transition: false } } },
  )
  return { config, activeView, ready, dark, discovery, tour, save, showError, businessClick, api }
}
const button = (part: 'next' | 'prev' | 'close') =>
  document.querySelector<HTMLButtonElement>(`.jobtrail-tour .driver-popover-${part}-btn`)!
async function at(id: string) {
  await vi.waitFor(() =>
    expect(document.querySelector('.driver-active-element')?.getAttribute('data-tour')).toBe(id),
  )
  await vi.waitFor(() => expect(button('next').disabled).toBe(false))
}

it('walks real navigation without navigating, serializes input and remembers the stable step', async () => {
  const f = fixture()
  await at('app-opportunities')
  expect(button('prev').disabled).toBe(true)
  expect(document.querySelector('.driver-popover-progress-text')?.textContent).toBe('1 / 9')
  button('next').click()
  button('next').click()
  await at('app-calendar')
  expect(f.save).toHaveBeenCalledTimes(2)
  expect(f.config.value?.onboarding.app).toEqual({ status: 'inProgress', stepId: 'calendar' })
  expect(f.activeView.value).toBe('opportunities')
  expect(f.businessClick).not.toHaveBeenCalled()
  button('prev').click()
  await at('app-opportunities')
  button('close').click()
  await vi.waitFor(() => expect(f.tour.active.value).toBe(false))
  expect(f.config.value?.onboarding.app.status).toBe('skipped')
  expect(f.config.value?.onboarding.discovery.status).toBe('pending')
  f.activeView.value = 'discovery'
  await at('discovery-accounts')
})

it('blocks business clicks while the first progress write is pending', async () => {
  const f = fixture()
  const original = f.save.getMockImplementation()!
  let release!: () => void
  f.save.mockImplementationOnce(async (patch) => {
    await new Promise<void>((resolve) => {
      release = resolve
    })
    await original(patch)
  })
  await vi.waitFor(() => expect(f.save).toHaveBeenCalledTimes(1))
  document.querySelector<HTMLElement>('[data-tour="app-calendar"] .n-menu-item-content')!.click()
  expect(f.businessClick).not.toHaveBeenCalled()
  release()
  await at('app-opportunities')
})

it('resumes on remount, finishes once, supports restart and keeps keyboard focus on the popover', async () => {
  const saved = structuredClone(CONFIG_V2_DEFAULTS)
  saved.onboarding.app = { status: 'inProgress', stepId: 'settings' }
  const f = fixture(saved)
  await at('app-settings')
  expect(button('next').textContent).toBe('完成')
  button('close').focus()
  window.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
  )
  expect(document.activeElement).toBe(button('prev'))
  button('next').click()
  await vi.waitFor(() => expect(f.config.value?.onboarding.app.status).toBe('completed'))
  await vi.waitFor(() => expect(document.querySelector('.jobtrail-tour')).toBeNull())
  f.tour.restart('app')
  await at('app-opportunities')
  f.dark.value = true
  i18n.global.locale.value = 'en-US'
  await nextTick()
  expect(document.querySelector('.jobtrail-tour')?.classList.contains('is-dark')).toBe(true)
  expect(button('close').textContent).toBe('Skip')
  wrapper!.unmount()
  wrapper = undefined
  expect(f.config.value?.onboarding.app).toEqual({ status: 'inProgress', stepId: 'opportunities' })
  expect(document.querySelector('.driver-overlay')).toBeNull()
})

it('waits for discovery entry and recreates real account modal steps without requesting a QR code', async () => {
  const saved = structuredClone(CONFIG_V2_DEFAULTS)
  saved.onboarding.app = { status: 'completed', stepId: null }
  saved.onboarding.discovery = { status: 'inProgress', stepId: 'qr-panel' }
  const f = fixture(saved, true)
  await flushPromises()
  expect(f.tour.active.value).toBe(false)
  f.activeView.value = 'discovery'
  await at('discovery-qr-panel')
  expect(document.querySelector('.discovery-accounts')).not.toBeNull()
  expect(f.api.qrLogin).not.toHaveBeenCalled()
  expect(f.api.start).not.toHaveBeenCalled()
  button('prev').click()
  await at('discovery-account-list')
  button('prev').click()
  await at('discovery-accounts')
  await vi.waitFor(() => expect(document.querySelector('.discovery-accounts')).toBeNull())
  button('next').click()
  await at('discovery-account-list')
  window.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
  )
  await vi.waitFor(() => expect(f.tour.active.value).toBe(false))
  expect(f.config.value?.onboarding.discovery.status).toBe('skipped')
  expect(f.api.save).not.toHaveBeenCalled()
  expect(f.api.cancel).not.toHaveBeenCalled()
  expect(f.showError).not.toHaveBeenCalled()
})

it('retains the saved step on write failure, retries and supports a temporary exit', async () => {
  const f = fixture()
  await at('app-opportunities')
  f.save.mockRejectedValueOnce(new Error('disk full'))
  button('next').click()
  await vi.waitFor(() => expect(button('next').textContent).toBe('重试'))
  expect(f.config.value?.onboarding.app.stepId).toBe('opportunities')
  expect(button('prev').disabled).toBe(true)
  button('next').click()
  await at('app-calendar')
  f.save.mockRejectedValueOnce(new Error('disk full'))
  button('close').click()
  await vi.waitFor(() => expect(button('close').textContent).toBe('暂时退出'))
  button('close').click()
  await flushPromises()
  expect(f.tour.active.value).toBe(false)
  expect(f.config.value?.onboarding.app).toEqual({ status: 'inProgress', stepId: 'calendar' })
})

it('gives business modals priority and does not turn a pause into a skip', async () => {
  const f = fixture()
  await at('app-opportunities')
  const dialog = document.createElement('div')
  dialog.className = 'n-modal'
  document.body.append(dialog)
  await vi.waitFor(() => expect(f.tour.active.value).toBe(false))
  expect(f.config.value?.onboarding.app.status).toBe('inProgress')
  dialog.remove()
  await at('app-opportunities')
})

it('restores a recreated account modal after a failed step write before retrying', async () => {
  const saved = structuredClone(CONFIG_V2_DEFAULTS)
  saved.onboarding.app = { status: 'completed', stepId: null }
  saved.onboarding.discovery = { status: 'inProgress', stepId: 'qr-panel' }
  const f = fixture(saved, true)
  f.activeView.value = 'discovery'
  await at('discovery-qr-panel')
  f.save.mockImplementationOnce(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400))
    throw new Error('disk full')
  })
  button('next').click()
  await vi.waitFor(() => expect(button('next').textContent).toBe('重试'))
  await at('discovery-qr-panel')
  expect(f.config.value?.onboarding.discovery.stepId).toBe('qr-panel')
  button('next').click()
  await at('discovery-platforms')
  expect(f.api.qrLogin).not.toHaveBeenCalled()
  expect(f.api.start).not.toHaveBeenCalled()
})
