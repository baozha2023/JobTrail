// @vitest-environment jsdom
import { flushPromises, mount, shallowMount } from '@vue/test-utils'
import { NSelect } from 'naive-ui'
import { expect, it, vi } from 'vitest'
import JobDiscoveryView from '../src/renderer/views/JobDiscoveryView.vue'
import { discoveryCities } from '../src/shared/discovery-cities'
import { i18n } from '../src/renderer/i18n'

// Install before Naive UI initializes its shared observer; jsdom has no layout engine.
vi.hoisted(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) {
        if (target.classList.contains('v-vl'))
          queueMicrotask(() =>
            this.callback(
              [{ target, contentRect: { width: 240, height: 240 } } as ResizeObserverEntry],
              this as unknown as ResizeObserver,
            ),
          )
      }
      unobserve() {}
      disconnect() {}
    },
  )
})

it('keeps city choices unique when opening, searching and scrolling the real select', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo')
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value(this: HTMLElement, options: ScrollToOptions) {
      this.scrollTop = options.top ?? this.scrollTop
      this.dispatchEvent(new Event('scroll'))
    },
  })
  Object.defineProperty(window, 'zhijiApi', {
    configurable: true,
    value: {
      discovery: {
        browser: vi.fn(async () => {}),
        region: vi.fn(async () => {}),
        verification: vi.fn(async () => null),
      },
    },
  })
  const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const wrapper = shallowMount(JobDiscoveryView, {
    attachTo: document.body,
    props: { active: false, statuses: [], resumes: [] },
    global: { plugins: [i18n] },
  })
  const updateValue = vi.fn()
  const select = mount(NSelect, {
    attachTo: document.body,
    props: {
      options: wrapper.findComponent(NSelect).props('options'),
      filterable: wrapper.findComponent(NSelect).props('filterable'),
      clearable: wrapper.findComponent(NSelect).props('clearable'),
      'onUpdate:value': updateValue,
    },
  })
  try {
    const options = select.props('options')!
    expect(options.every((option) => !option.type && !option.children)).toBe(true)
    const values = options.map((option) => option.value)
    expect(new Set(values).size).toBe(values.length)
    expect(values).toEqual(discoveryCities.map((city) => city.name))

    await select.get('.n-base-selection').trigger('click')
    await flushPromises()
    const menu = () => document.querySelector('.n-base-select-menu')!
    const cityLabels = () =>
      Array.from(menu().querySelectorAll('.n-base-select-option__content')).map(
        (element) => element.textContent,
      )
    for (const city of ['北京', '上海', '天津', '重庆']) {
      expect(cityLabels().filter((name) => name === city)).toHaveLength(1)
    }
    const input = select.get('input')
    for (const city of ['天津', '吉林', '上海', '重庆']) {
      await input.setValue(city)
      await flushPromises()
      expect(cityLabels()).toEqual(
        discoveryCities.filter((item) => item.name.includes(city)).map((item) => item.name),
      )
    }
    await input.setValue('')
    await flushPromises()
    const scroller = menu().querySelector<HTMLElement>('.v-vl')!
    for (const top of [160, 400, 0, 160, 0]) {
      scroller.scrollTop = top
      scroller.dispatchEvent(new Event('scroll'))
      await flushPromises()
      const labels = cityLabels()
      expect(labels.length).toBeGreaterThan(0)
      expect(new Set(labels).size).toBe(labels.length)
      if (top === 0) expect(labels.slice(0, 4)).toEqual(['北京', '上海', '天津', '重庆'])
      else expect(labels).not.toContain('北京')
    }
    for (const city of ['天津', '吉林', '上海']) {
      await input.setValue(city)
      await flushPromises()
      const option = menu().querySelector<HTMLElement>('.n-base-select-option')!
      option.click()
      await flushPromises()
      expect(updateValue.mock.calls.at(-1)![0]).toBe(city)
      await select.get('.n-base-selection').trigger('mouseenter')
      await select.get('[data-clear]').trigger('click')
      await flushPromises()
      expect(updateValue.mock.calls.at(-1)![0]).toBe(null)
      await select.get('.n-base-selection').trigger('click')
      await flushPromises()
    }
    expect(warnings.mock.calls.filter((call) => /Duplicate keys/.test(String(call[0])))).toEqual([])
  } finally {
    select.unmount()
    wrapper.unmount()
    warnings.mockRestore()
    vi.unstubAllGlobals()
    if (originalScrollTo) Object.defineProperty(HTMLElement.prototype, 'scrollTo', originalScrollTo)
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo')
  }
})
