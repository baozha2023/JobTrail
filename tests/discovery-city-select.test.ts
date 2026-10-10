// @vitest-environment jsdom
import { flushPromises, mount, shallowMount } from '@vue/test-utils'
import { NSelect, NCheckboxGroup } from 'naive-ui'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import JobDiscoveryView from '../src/renderer/views/JobDiscoveryView.vue'
import { commonCities, platformCities } from '../src/shared/discovery-cities'
import { platforms } from '../src/shared/job-discovery'
import { cityNamesEn } from '../src/renderer/discovery-city-names'
import { i18n } from '../src/renderer/i18n'

// Install before Naive UI initializes its shared observer; jsdom has no layout engine.
const { MockResizeObserver } = vi.hoisted(() => {
  class MockResizeObserver {
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
  }
  vi.stubGlobal('ResizeObserver', MockResizeObserver)
  return { MockResizeObserver }
})
const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo')
beforeEach(() => {
  i18n.global.locale.value = 'zh-CN'
  vi.stubGlobal('ResizeObserver', MockResizeObserver)
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value(this: HTMLElement, options: ScrollToOptions) {
      this.scrollTop = options.top ?? this.scrollTop
      this.dispatchEvent(new Event('scroll'))
    },
  })
})
afterEach(() => {
  i18n.global.locale.value = 'zh-CN'
  vi.unstubAllGlobals()
  if (originalScrollTo) Object.defineProperty(HTMLElement.prototype, 'scrollTo', originalScrollTo)
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo')
})

it('provides distinct English labels for every city from any platform', () => {
  const names = new Set(platforms.flatMap((p) => platformCities(p).map((city) => city.name)))
  expect(new Set(Object.keys(cityNamesEn))).toEqual(names)
  const translations = [...names].map((name) => cityNamesEn[name])
  expect(new Set(translations).size).toBe(names.size)
  for (const name of names) {
    expect(i18n.global.t('discoveryCities.' + name, {}, { locale: 'zh-CN' })).toBe(name)
    expect(i18n.global.t('discoveryCities.' + name, {}, { locale: 'en-US' })).toBe(
      cityNamesEn[name],
    )
    expect(cityNamesEn[name]).not.toMatch(/\p{Script=Han}/u)
  }
  expect(cityNamesEn.蚌埠).toBe('Bengbu')
  expect(cityNamesEn.长治).toBe('Changzhi')
  expect(cityNamesEn.苏州).not.toBe(cityNamesEn.宿州)
})

it('searches both languages in the real selector and translates labels without changing values', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  Object.defineProperty(window, 'zhijiApi', {
    configurable: true,
    value: {
      discovery: {
        browser: vi.fn(async () => {}),
        onBrowserLoading: vi.fn(() => () => {}),
        region: vi.fn(async () => {}),
        verification: vi.fn(async () => null),
      },
    },
  })
  const wrapper = mount(JobDiscoveryView, {
    attachTo: document.body,
    props: { active: false, companies: [], statuses: [], resumes: [] },
    global: { plugins: [i18n] },
  })
  const select = () => wrapper.findComponent(NSelect)
  try {
    wrapper.findComponent(NCheckboxGroup).vm.$emit('update:value', ['boss'])
    await flushPromises()
    await select().get('.n-base-selection').trigger('click')
    await select().get('input').setValue('BEI JING')
    await flushPromises()
    expect(document.querySelector('.n-base-select-option__content')?.textContent).toBe('北京')
    document.querySelector<HTMLElement>('.n-base-select-option')!.click()
    await flushPromises()
    expect(select().props('value')).toBe('北京')
    i18n.global.locale.value = 'en-US'
    await flushPromises()
    expect(select().props('value')).toBe('北京')
    expect(select().get('.n-base-selection-label').text()).toContain('Beijing')
    await select().get('.n-base-selection').trigger('click')
    for (const [pattern, expected] of [
      ['北京', ['Beijing']],
      ['BEI JING', ['Beijing']],
      ['Ürümqi', ['Urumqi']],
      ['suzhou', ['Suzhou (Anhui)', 'Suzhou (Jiangsu)']],
    ] as const) {
      await select().get('input').setValue(pattern)
      await flushPromises()
      expect(
        [...document.querySelectorAll('.n-base-select-option__content')]
          .map((e) => e.textContent)
          .sort(),
      ).toEqual([...expected].sort())
    }
    await select().get('input').trigger('keydown', { key: 'Escape' })
    // Historical aliases can be absent from the current option values.
    select().vm.$emit('update:value', '恩施土家族苗族自治州')
    await flushPromises()
    expect(select().get('.n-base-selection-label').text()).toContain('Enshi')
    i18n.global.locale.value = 'zh-CN'
    await flushPromises()
    expect(select().props('value')).toBe('恩施土家族苗族自治州')
    expect(select().get('.n-base-selection-label').text()).toContain('恩施')
    select().vm.$emit('update:value', '历史城市')
    i18n.global.locale.value = 'en-US'
    await flushPromises()
    expect(select().get('.n-base-selection-label').text()).toContain('历史城市')
  } finally {
    wrapper.unmount()
  }
})

it('replaces the real city input on site changes, clearing both the selection and search text', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  Object.defineProperty(window, 'zhijiApi', {
    configurable: true,
    value: {
      discovery: {
        browser: vi.fn(async () => {}),
        onBrowserLoading: vi.fn(() => () => {}),
        region: vi.fn(async () => {}),
        verification: vi.fn(async () => null),
      },
    },
  })
  const wrapper = mount(JobDiscoveryView, {
    attachTo: document.body,
    props: { active: false, companies: [], statuses: [], resumes: [] },
    global: { plugins: [i18n] },
  })
  try {
    const group = wrapper.findComponent(NCheckboxGroup)
    const select = () => wrapper.findComponent(NSelect)
    expect(select().props('disabled')).toBe(true)
    group.vm.$emit('update:value', ['boss'])
    await flushPromises()
    await select().get('.n-base-selection').trigger('click')
    await select().get('input').setValue('白杨')
    await flushPromises()
    expect(document.querySelector('.n-base-select-option__content')?.textContent).toBe('白杨')
    document.querySelector<HTMLElement>('.n-base-select-option')!.click()
    await flushPromises()
    expect(select().props('value')).toBe('白杨')
    await select().get('.n-base-selection').trigger('click')
    await select().get('input').setValue('白杨')
    group.vm.$emit('update:value', ['boss', 'liepin'])
    await flushPromises()
    expect(select().props('value')).toBeNull()
    expect((select().get('input').element as HTMLInputElement).value).toBe('')
    expect(document.querySelector('.n-base-select-option__content')).toBeNull()
    await select().get('.n-base-selection').trigger('click')
    await flushPromises()
    expect(
      select()
        .props('options')!
        .some((c) => c.value === '白杨'),
    ).toBe(false)
    expect(document.querySelector('.n-base-select-option__content')?.textContent).toBe('北京')
  } finally {
    wrapper.unmount()
  }
})

it('keeps city choices unique when opening, searching and scrolling the real select', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  Object.defineProperty(window, 'zhijiApi', {
    configurable: true,
    value: {
      discovery: {
        browser: vi.fn(async () => {}),
        onBrowserLoading: vi.fn(() => () => {}),
        region: vi.fn(async () => {}),
        verification: vi.fn(async () => null),
      },
    },
  })
  const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const wrapper = shallowMount(JobDiscoveryView, {
    attachTo: document.body,
    props: { active: false, companies: [], statuses: [], resumes: [] },
    global: { plugins: [i18n] },
  })
  const updateValue = vi.fn()
  wrapper.findComponent(NCheckboxGroup).vm.$emit('update:value', ['boss'])
  await flushPromises()
  const discoveryCities = commonCities(['boss'])
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
  }
})
