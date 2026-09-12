// @vitest-environment jsdom

import { mount } from '@vue/test-utils'
import { NModal } from 'naive-ui'
import { describe, expect, it, vi } from 'vitest'
import { i18n } from '../src/renderer/i18n'
import SettingsView from '../src/renderer/views/SettingsView.vue'

const baseProps = {
  config: null,
  mcpConnectionInfo: null,
  currentVersion: '0.5.0',
  checkingForUpdates: false,
  uninstalling: false,
  checkForUpdates: vi.fn(),
  uninstallApp: vi.fn(),
  catalogStatus: { formatVersion: 1, catalogVersion: 1, appliedAt: 1 },
  catalogModalVisible: true,
  catalogUpdating: true,
  catalogPhase: 'sync' as const,
  catalogProgress: 88,
  catalogResult: null,
  catalogError: '',
  updateCompanyCatalog: vi.fn(),
  closeCatalogModal: vi.fn(),
}

const global = {
  plugins: [i18n],
  stubs: { teleport: true, transition: false },
}

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(globalThis, 'ResizeObserver', { value: ResizeObserverStub })

describe('内置公司更新弹窗', () => {
  it('cannot be dismissed while an update is running', () => {
    const wrapper = mount(SettingsView, {
      props: baseProps,
      global,
    })
    const modal = wrapper.findComponent(NModal)
    expect(modal.props('show')).toBe(true)
    expect(modal.props('maskClosable')).toBe(false)
    expect(modal.props('closeOnEsc')).toBe(false)
    expect(modal.text()).toContain('正在同步公司数据')
    expect(modal.text()).not.toContain('关闭')
  })

  it('shows result counts and a close action only after completion', () => {
    const close = vi.fn()
    const wrapper = mount(SettingsView, {
      props: {
        ...baseProps,
        catalogUpdating: false,
        catalogProgress: 100,
        catalogResult: {
          status: 'updated' as const,
          previousVersion: 1,
          currentVersion: 2,
          added: 2,
          updated: 3,
          adopted: 4,
          unchanged: 492,
        },
        closeCatalogModal: close,
      },
      global,
    })
    const modal = wrapper.findComponent(NModal)
    expect(modal.text()).toContain('更新完成')
    expect(modal.text()).toContain('新增：2')
    expect(modal.text()).toContain('转为内置：4')
    const closeButton = modal.findAll('button').find((button) => button.text() === '关闭')
    expect(closeButton).toBeDefined()
    closeButton!.trigger('click')
    expect(close).toHaveBeenCalledOnce()
  })
})
