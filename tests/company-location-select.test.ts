// @vitest-environment jsdom
import { shallowMount, flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NSelect } from 'naive-ui'
import CompanyLocationSelect from '../src/renderer/components/CompanyLocationSelect.vue'
import { i18n } from '../src/renderer/i18n'
import type { CompanyLocationQuery, PageResult } from '../src/shared/types'

const wrappers: ReturnType<typeof shallowMount>[] = []
function mount(
  searchLocations: (query: CompanyLocationQuery) => Promise<PageResult<string>>,
  value: string[] = [],
  allowCreate = false,
) {
  Object.defineProperty(window, 'zhijiApi', {
    configurable: true,
    value: { companies: { searchLocations } },
  })
  const wrapper = shallowMount(CompanyLocationSelect, {
    props: { value, allowCreate, revision: 0 },
    global: { plugins: [i18n] },
  })
  wrappers.push(wrapper)
  return { wrapper, select: wrapper.findComponent(NSelect) }
}
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount())
  vi.useRealTimers()
})

describe('company location suggestions', () => {
  it('loads only when opened, pages results, and keeps selections outside the current page', async () => {
    const search = vi.fn(async (query: CompanyLocationQuery) => ({
      ...query,
      total: 55,
      items: Array.from(
        { length: query.page === 1 ? 50 : 5 },
        (_, i) => `Office ${(query.page - 1) * 50 + i}`,
      ),
    }))
    const { select } = mount(search, ['上海'])
    expect(search).not.toHaveBeenCalled()
    select.vm.$emit('update:show', true)
    await flushPromises()
    expect(search).toHaveBeenCalledExactlyOnceWith({ prefix: '', page: 1, pageSize: 50 })
    expect(select.props('options')).toHaveLength(51)
    select.vm.$emit('scroll', { target: { scrollTop: 100, scrollHeight: 200, clientHeight: 100 } })
    await flushPromises()
    expect(search).toHaveBeenLastCalledWith({ prefix: '', page: 2, pageSize: 50 })
    expect(select.props('options')).toHaveLength(56)
    select.vm.$emit('scroll', { target: { scrollTop: 100, scrollHeight: 200, clientHeight: 100 } })
    await flushPromises()
    expect(search).toHaveBeenCalledTimes(2)
  })

  it('debounces prefixes and ignores a late response from the previous search', async () => {
    vi.useFakeTimers()
    let resolveOld!: (value: PageResult<string>) => void
    const search = vi.fn((query: CompanyLocationQuery) =>
      query.prefix === ''
        ? new Promise<PageResult<string>>((resolve) => {
            resolveOld = resolve
          })
        : Promise.resolve({ ...query, items: ['上海'], total: 1 }),
    )
    const { select } = mount(search)
    select.vm.$emit('update:show', true)
    select.vm.$emit('search', '北')
    await vi.advanceTimersByTimeAsync(100)
    select.vm.$emit('search', '上')
    await vi.advanceTimersByTimeAsync(199)
    expect(search).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await flushPromises()
    resolveOld({ page: 1, pageSize: 50, total: 1, items: ['旧地点'] })
    await flushPromises()
    expect(select.props('options')).toEqual([{ label: '上海', value: '上海' }])
    expect(search).toHaveBeenLastCalledWith({ prefix: '上', page: 1, pageSize: 50 })
  })

  it('refreshes on invalidation, preserves draft selections, and only writes via the parent company form', async () => {
    const search = vi.fn(async (query: CompanyLocationQuery) => ({ ...query, items: [], total: 0 }))
    const { wrapper, select } = mount(search, ['已删除地点'], true)
    select.vm.$emit('update:show', true)
    await flushPromises()
    select.vm.$emit('update:value', [' 已删除地点 ', '已删除地点', 'New York, US'])
    expect(wrapper.emitted('update:value')?.[0]).toEqual([['已删除地点', 'New York, US']])
    await wrapper.setProps({ revision: 1 })
    await flushPromises()
    expect(search).toHaveBeenCalledTimes(2)
    expect(select.props('options')).toEqual([{ label: '已删除地点', value: '已删除地点' }])
    select.vm.$emit('update:value', [' '])
    await flushPromises()
    expect(wrapper.emitted('update:value')).toHaveLength(1)
    expect(wrapper.find('[role="alert"]').exists()).toBe(true)
  })

  it('offers a new label locally only in the editor and hides unrelated selected values from the prefix menu', async () => {
    const search = vi.fn(async (query: CompanyLocationQuery) => ({ ...query, items: [], total: 0 }))
    const editor = mount(search, ['北京'], true)
    editor.select.vm.$emit('update:show', true)
    await flushPromises()
    editor.select.vm.$emit('search', ' 苏州 ')
    await flushPromises()
    expect(editor.select.props('options')).toEqual([{ label: '苏州', value: '苏州' }])
    expect(editor.select.props('value')).toEqual(['北京'])
    expect(editor.wrapper.emitted('update:value')).toBeUndefined()
    const filter = mount(search, ['北京'])
    filter.select.vm.$emit('search', '苏州')
    await flushPromises()
    expect(filter.select.props('options')).toEqual([])
    expect(filter.select.props('value')).toEqual(['北京'])
  })

  it('displays localized failures and can retry by reopening', async () => {
    const search = vi
      .fn()
      .mockRejectedValueOnce({ code: 'VALIDATION_ERROR' })
      .mockImplementation(async (query: CompanyLocationQuery) => ({
        ...query,
        items: ['北京'],
        total: 1,
      }))
    const { wrapper, select } = mount(search)
    select.vm.$emit('update:show', true)
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(true)
    select.vm.$emit('update:show', false)
    select.vm.$emit('update:show', true)
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(select.props('options')).toEqual([{ label: '北京', value: '北京' }])
  })
})
