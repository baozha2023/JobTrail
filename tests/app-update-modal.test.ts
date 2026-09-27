// @vitest-environment jsdom

import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { i18n } from '../src/renderer/i18n'
import AppUpdateModal from '../src/renderer/components/AppUpdateModal.vue'

function setup() {
  const downloadUpdates = vi.fn().mockResolvedValue(true)
  const applyUpdates = vi.fn().mockResolvedValue(true)
  Object.defineProperty(window, 'velopackApi', {
    value: { downloadUpdates, applyUpdates },
    configurable: true,
  })
  const wrapper = mount(AppUpdateModal, {
    props: { currentVersion: '1.0.0', targetVersion: '1.0.1' },
    global: { plugins: [i18n], stubs: { teleport: true, transition: false } },
  })
  const button = (label: string) => wrapper.findAll('button').find((item) => item.text() === label)!
  return { wrapper, downloadUpdates, applyUpdates, button }
}

describe('application update confirmation', () => {
  it('shows both versions and cancels without downloading', async () => {
    const { wrapper, button, downloadUpdates, applyUpdates } = setup()
    expect(wrapper.get('[role="dialog"]').text()).toContain('发现新版本')
    expect(wrapper.text()).toContain('1.0.0')
    expect(wrapper.text()).toContain('1.0.1')
    await button('取消').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
    expect(downloadUpdates).not.toHaveBeenCalled()
    expect(applyUpdates).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('prevents duplicate downloads and applies only after download completes', async () => {
    const { wrapper, button, downloadUpdates, applyUpdates } = setup()
    let finishDownload!: () => void
    downloadUpdates.mockImplementation(
      () => new Promise<void>((resolve) => (finishDownload = resolve)),
    )
    await button('下载并安装').trigger('click')
    await button('下载并安装').trigger('click')
    expect(downloadUpdates).toHaveBeenCalledOnce()
    expect(applyUpdates).not.toHaveBeenCalled()
    expect(button('取消').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[role="status"]').text()).toContain('正在下载并应用更新')
    finishDownload()
    await flushPromises()
    expect(applyUpdates).toHaveBeenCalledOnce()
    expect(button('取消').attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })

  it('shows a failed download in the dialog and supports retry', async () => {
    const { wrapper, button, downloadUpdates, applyUpdates } = setup()
    downloadUpdates.mockRejectedValueOnce(new Error('network unavailable'))
    await button('下载并安装').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('更新失败')
    expect(button('取消').attributes('disabled')).toBeUndefined()
    expect(applyUpdates).not.toHaveBeenCalled()
    await button('重试下载').trigger('click')
    await flushPromises()
    expect(downloadUpdates).toHaveBeenCalledTimes(2)
    expect(applyUpdates).toHaveBeenCalledOnce()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    wrapper.unmount()
  })
})
