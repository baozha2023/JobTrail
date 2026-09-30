// @vitest-environment jsdom

import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { i18n } from '../src/renderer/i18n'
import AppUpdateModal from '../src/renderer/components/AppUpdateModal.vue'
import type { AppUpdateProgress } from '../src/shared/types'

function setup() {
  const downloadUpdates = vi.fn().mockResolvedValue(true)
  const applyUpdates = vi.fn().mockResolvedValue(true)
  const removeProgress = vi.fn()
  let listener: ((progress: AppUpdateProgress) => void) | undefined
  const onProgress = vi.fn((callback: (progress: AppUpdateProgress) => void) => {
    listener = callback
    return removeProgress
  })
  Object.defineProperty(window, 'velopackApi', {
    value: { downloadUpdates, applyUpdates, onProgress },
    configurable: true,
  })
  const wrapper = mount(AppUpdateModal, {
    props: { currentVersion: '1.0.0', targetVersion: '1.0.1' },
    global: { plugins: [i18n], stubs: { teleport: true, transition: false } },
  })
  const button = (label: string) => wrapper.findAll('button').find((item) => item.text() === label)!
  const emitProgress = (progress: AppUpdateProgress) => listener?.(progress)
  return {
    wrapper,
    downloadUpdates,
    applyUpdates,
    onProgress,
    removeProgress,
    emitProgress,
    button,
  }
}

describe('application update confirmation', () => {
  it('shows both versions and cancels without downloading', async () => {
    const { wrapper, button, downloadUpdates, applyUpdates, removeProgress } = setup()
    expect(wrapper.get('[role="dialog"]').text()).toContain('发现新版本')
    expect(wrapper.text()).toContain('1.0.0')
    expect(wrapper.text()).toContain('1.0.1')
    await button('取消').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
    expect(downloadUpdates).not.toHaveBeenCalled()
    expect(applyUpdates).not.toHaveBeenCalled()
    wrapper.unmount()
    expect(removeProgress).toHaveBeenCalledOnce()
  })

  it('prevents duplicate downloads and applies only after download completes', async () => {
    vi.useFakeTimers()
    const { wrapper, button, downloadUpdates, applyUpdates } = setup()
    let finishDownload!: () => void
    downloadUpdates.mockImplementation(
      () => new Promise<void>((resolve) => (finishDownload = resolve)),
    )
    try {
      await button('下载并安装').trigger('click')
      await button('下载并安装').trigger('click')
      expect(downloadUpdates).toHaveBeenCalledOnce()
      expect(applyUpdates).not.toHaveBeenCalled()
      expect(button('取消').attributes('disabled')).toBeDefined()
      expect(wrapper.get('[role="status"]').text()).toContain('正在保留当前版本')
      expect(wrapper.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('0')
      finishDownload()
      await vi.advanceTimersByTimeAsync(3_000)
      expect(applyUpdates).toHaveBeenCalledOnce()
      expect(button('取消').attributes('disabled')).toBeDefined()
    } finally {
      wrapper.unmount()
      vi.useRealTimers()
    }
  })

  it('shows a failed download in the dialog and supports retry', async () => {
    vi.useFakeTimers()
    const { wrapper, button, downloadUpdates, applyUpdates } = setup()
    try {
      downloadUpdates.mockRejectedValueOnce(new Error('network unavailable'))
      await button('下载并安装').trigger('click')
      await wrapper.vm.$nextTick()
      expect(wrapper.get('[role="alert"]').text()).toContain('更新失败')
      expect(button('取消').attributes('disabled')).toBeUndefined()
      expect(applyUpdates).not.toHaveBeenCalled()
      await button('重试更新').trigger('click')
      await vi.advanceTimersByTimeAsync(3_000)
      expect(downloadUpdates).toHaveBeenCalledTimes(2)
      expect(applyUpdates).toHaveBeenCalledOnce()
      expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    } finally {
      wrapper.unmount()
      vi.useRealTimers()
    }
  })

  it('retries apply without downloading or preserving the old package again', async () => {
    vi.useFakeTimers()
    const { wrapper, button, downloadUpdates, applyUpdates } = setup()
    try {
      applyUpdates.mockRejectedValueOnce(new Error('prepare failed'))
      await button('下载并安装').trigger('click')
      await vi.advanceTimersByTimeAsync(3_000)
      expect(wrapper.get('[role="alert"]').text()).toContain('更新失败')
      await button('重试更新').trigger('click')
      await vi.advanceTimersByTimeAsync(1_000)
      expect(downloadUpdates).toHaveBeenCalledOnce()
      expect(applyUpdates).toHaveBeenCalledTimes(2)
    } finally {
      wrapper.unmount()
      vi.useRealTimers()
    }
  })

  it('animates Delta fallback and bounds Full progress to downloaded bytes', async () => {
    vi.useFakeTimers()
    const { wrapper, button, downloadUpdates, emitProgress } = setup()
    let finishDownload!: () => void
    downloadUpdates.mockImplementation(
      () => new Promise<void>((resolve) => (finishDownload = resolve)),
    )
    try {
      await button('下载并安装').trigger('click')
      const attemptId = downloadUpdates.mock.calls[0][0] as number
      emitProgress({ attemptId, stage: 'transfer', mode: 'delta', percentage: 70 })
      expect(wrapper.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('0')
      await vi.advanceTimersByTimeAsync(500)
      expect(wrapper.get('[role="status"]').text()).toContain('增量更新')
      const beforeFallback = Number(wrapper.get('[role="progressbar"]').attributes('aria-valuenow'))
      expect(beforeFallback).toBeGreaterThanOrEqual(12)
      expect(beforeFallback).toBeLessThanOrEqual(48)

      emitProgress({ attemptId, stage: 'transfer', mode: 'full', percentage: 0 })
      await vi.advanceTimersByTimeAsync(1_000)
      expect(wrapper.get('[role="status"]').text()).toContain('完整更新包')
      expect(wrapper.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('50')
      emitProgress({ attemptId, stage: 'transfer', mode: 'full', percentage: 50 })
      await vi.advanceTimersByTimeAsync(500)
      expect(wrapper.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('64')
      emitProgress({ attemptId, stage: 'verify' })
      finishDownload()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(wrapper.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('100')
    } finally {
      wrapper.unmount()
      vi.useRealTimers()
    }
  })

  it('smoothly skips the Full range after a successful Delta', async () => {
    vi.useFakeTimers()
    const { wrapper, button, downloadUpdates, emitProgress } = setup()
    let finishDownload!: () => void
    downloadUpdates.mockImplementation(
      () => new Promise<void>((resolve) => (finishDownload = resolve)),
    )
    try {
      await button('下载并安装').trigger('click')
      const attemptId = downloadUpdates.mock.calls[0][0] as number
      emitProgress({ attemptId, stage: 'transfer', mode: 'delta', percentage: 0 })
      await vi.advanceTimersByTimeAsync(500)
      emitProgress({ attemptId, stage: 'verify' })
      finishDownload()
      let previous = Number(wrapper.get('[role="progressbar"]').attributes('aria-valuenow'))
      let sawSkippedFull = false
      for (let index = 0; index < 95; index++) {
        await vi.advanceTimersByTimeAsync(16)
        const current = Number(wrapper.get('[role="progressbar"]').attributes('aria-valuenow'))
        expect(current).toBeGreaterThanOrEqual(previous)
        expect(current - previous).toBeLessThanOrEqual(1)
        if (wrapper.get('[role="status"]').text().includes('跳过完整包')) sawSkippedFull = true
        previous = current
      }
      expect(sawSkippedFull).toBe(true)
      expect(previous).toBe(100)
    } finally {
      wrapper.unmount()
      vi.useRealTimers()
    }
  })

  it('ignores progress from a previous failed attempt when retrying', async () => {
    const { wrapper, button, downloadUpdates, emitProgress } = setup()
    downloadUpdates.mockRejectedValueOnce(new Error('network unavailable'))
    let finishRetry!: () => void
    downloadUpdates.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishRetry = resolve)),
    )
    await button('下载并安装').trigger('click')
    const previousAttempt = downloadUpdates.mock.calls[0][0] as number
    await flushPromises()
    await button('重试更新').trigger('click')
    emitProgress({ attemptId: previousAttempt, stage: 'transfer', mode: 'full', percentage: 90 })
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('0')
    finishRetry()
    await flushPromises()
    wrapper.unmount()
  })

  it('shows progress messages in English when English is selected', async () => {
    vi.useFakeTimers()
    const previousLocale = i18n.global.locale.value
    i18n.global.locale.value = 'en-US'
    try {
      const { wrapper, button, downloadUpdates, emitProgress } = setup()
      let finishDownload!: () => void
      downloadUpdates.mockImplementation(
        () => new Promise<void>((resolve) => (finishDownload = resolve)),
      )
      await button('Download and install').trigger('click')
      const attemptId = downloadUpdates.mock.calls[0][0] as number
      emitProgress({ attemptId, stage: 'transfer', mode: 'full', percentage: 30 })
      await vi.advanceTimersByTimeAsync(1_200)
      expect(wrapper.get('[role="status"]').text()).toContain('Downloading the full update package')
      expect(wrapper.get('[role="progressbar"]').attributes('aria-label')).toBe('Update progress')
      finishDownload()
      wrapper.unmount()
    } finally {
      i18n.global.locale.value = previousLocale
      vi.useRealTimers()
    }
  })

  it('simulates preparation, fills skipped ranges, and reaches 100 at handoff', async () => {
    vi.useFakeTimers()
    const { wrapper, button, downloadUpdates } = setup()
    let finishDownload!: () => void
    downloadUpdates.mockImplementation(
      () => new Promise<void>((resolve) => (finishDownload = resolve)),
    )
    try {
      await button('下载并安装').trigger('click')
      await vi.advanceTimersByTimeAsync(7_000)
      await wrapper.vm.$nextTick()
      expect(wrapper.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('11')
      finishDownload()
      await vi.advanceTimersByTimeAsync(3_000)
      await wrapper.vm.$nextTick()
      expect(wrapper.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('100')
    } finally {
      wrapper.unmount()
      vi.useRealTimers()
    }
  })
})
