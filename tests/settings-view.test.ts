// @vitest-environment jsdom

import { flushPromises, mount } from '@vue/test-utils'
import { NModal, NRadioGroup, NSelect, NSwitch } from 'naive-ui'
import { describe, expect, it, vi } from 'vitest'
import { i18n } from '../src/renderer/i18n'
import { getErrorMessage } from '../src/renderer/utils/errors'
import SettingsView from '../src/renderer/views/SettingsView.vue'
import type { AppConfig } from '../src/shared/types'
import { version as currentVersion } from '../package.json'
import { formatVersion, catalogVersion } from '../resource/jobtrail-company-catalog.json'

const baseProps = {
  config: null,
  dark: false,
  mcpConnectionInfo: null,
  currentVersion,
  checkingForUpdates: false,
  uninstalling: false,
  checkForUpdates: vi.fn(),
  uninstallApp: vi.fn(),
  catalogStatus: { formatVersion, catalogVersion, appliedAt: 1 },
  catalogModalVisible: true,
  catalogUpdating: true,
  catalogPhase: 'sync' as const,
  catalogProgress: 88,
  catalogResult: null,
  catalogError: '',
  updateCompanyCatalog: vi.fn(),
  closeCatalogModal: vi.fn(),
  backupBusy: false,
  backupStatus: '',
  backupAction: vi.fn(),
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
Object.defineProperty(window, 'zhijiApi', {
  value: {
    diagnostics: {
      openDirectory: async () => {},
      exportBundle: async () => 'exported',
    },
    agent: {
      saveSettings: async () => null,
    },
  },
  configurable: true,
})

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
          convertedToCustom: 5,
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
    expect(modal.text()).toContain('转为自定义：5')
    const closeButton = modal.findAll('button').find((button) => button.text() === '关闭')
    expect(closeButton).toBeDefined()
    closeButton!.trigger('click')
    expect(close).toHaveBeenCalledOnce()
  })
})

describe('设置页', () => {
  it('saves model settings and forwards failures for message feedback without inline errors', async () => {
    const config: AppConfig = {
      configVersion: 1,
      themeMode: 'light',
      statusFlowTheme: 'violet',
      locale: 'zh-CN',
      closeBehavior: 'quit',
      launchAtStartup: false,
      companyReadValidityMonths: 3,
      mcp: { enabled: true, requireWriteConfirmation: true },
      ai: {
        baseUrl: 'https://api.example.com/v1',
        modelId: 'test-model',
        apiKey: 'sk-existing',
        multimodal: false,
        contextWindowK: 256,
        compactThresholdPercent: 80,
      },
    }
    const saveError = Object.assign(new Error('raw diagnostics'), { code: 'VALIDATION_ERROR' })
    const clearedConfig = { ...config, ai: { ...config.ai, apiKey: '' } }
    const saveSettings = vi
      .fn()
      .mockResolvedValueOnce(config)
      .mockRejectedValueOnce(saveError)
      .mockResolvedValueOnce(config)
      .mockResolvedValueOnce(clearedConfig)
    Object.defineProperty(window, 'zhijiApi', {
      value: {
        agent: { saveSettings },
      },
      configurable: true,
    })
    const wrapper = mount(SettingsView, {
      props: { ...baseProps, config, catalogModalVisible: false },
      global,
    })
    const keyInput = wrapper.find('input[placeholder="输入 API Key"]')
    expect((keyInput.element as HTMLInputElement).value).toBe('sk-existing')
    await keyInput.setValue('sk-example')
    const saveButton = wrapper.findAll('button').find((button) => button.text() === '保存模型设置')
    expect(saveButton).toBeDefined()
    expect(wrapper.text()).not.toContain('保存 API Key')
    await saveButton!.trigger('click')
    await flushPromises()
    expect(saveSettings).toHaveBeenCalledWith({ ...config.ai, apiKey: 'sk-example' })
    expect(wrapper.emitted('aiSaved')?.[0]).toEqual([config])
    await saveButton!.trigger('click')
    await flushPromises()
    expect(wrapper.emitted('error')).toEqual([[saveError]])
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('输入内容无效')
    expect(wrapper.text()).not.toContain('raw diagnostics')
    expect(wrapper.emitted('aiSaved')).toHaveLength(1)
    expect((keyInput.element as HTMLInputElement).value).toBe('sk-example')
    await saveButton!.trigger('click')
    await flushPromises()
    expect(saveSettings).toHaveBeenCalledTimes(3)
    expect(wrapper.emitted('aiSaved')).toHaveLength(2)
    await keyInput.setValue('   ')
    await saveButton!.trigger('click')
    await flushPromises()
    expect(saveSettings).toHaveBeenLastCalledWith({ ...config.ai, apiKey: '' })
    expect(wrapper.emitted('aiSaved')?.[2]).toEqual([clearedConfig])
    await wrapper.setProps({ config: clearedConfig })
    expect((keyInput.element as HTMLInputElement).value).toBe('')
    expect(wrapper.emitted('error')).toHaveLength(1)
    wrapper.unmount()
  })

  it('explains when the published company catalog is missing', () => {
    expect(getErrorMessage({ code: 'CATALOG_ASSET_MISSING' }, (key) => i18n.global.t(key))).toBe(
      '缺少内置公司数据，无法更新',
    )
  })

  it('keeps preference and MCP changes connected to their original settings actions', () => {
    const config: AppConfig = {
      configVersion: 1,
      themeMode: 'light',
      statusFlowTheme: 'violet',
      locale: 'zh-CN',
      closeBehavior: 'quit',
      launchAtStartup: false,
      companyReadValidityMonths: 3,
      mcp: { enabled: true, requireWriteConfirmation: true },
      ai: {
        baseUrl: 'https://api.openai.com/v1',
        modelId: '',
        apiKey: '',
        multimodal: false,
        contextWindowK: 256,
        compactThresholdPercent: 80,
      },
    }
    const wrapper = mount(SettingsView, {
      props: { ...baseProps, config, catalogModalVisible: false },
      global,
    })

    wrapper.findAllComponents(NSelect)[0].vm.$emit('update:value', 'dark')
    wrapper.findComponent(NRadioGroup).vm.$emit('update:value', 'tray')
    wrapper.findAllComponents(NSwitch)[1].vm.$emit('update:value', false)

    expect(wrapper.emitted('updateConfig')).toEqual([
      [{ themeMode: 'dark' }],
      [{ mcp: { enabled: false } }],
    ])
    expect(wrapper.emitted('closeBehavior')).toEqual([['tray']])
    wrapper.unmount()
  })
})
