// @vitest-environment jsdom

import { defineComponent, h } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { i18n } from '../src/renderer/i18n'
import { useBackupWorkspace } from '../src/renderer/composables/useBackupWorkspace'
import type { BackupImportConfirmation } from '../src/shared/types'

function setup() {
  const confirmation: BackupImportConfirmation = {
    requestId: 'test-request',
    appVersion: '1.2.0',
    createdAt: '2026-09-30T16:28:15.062Z',
  }
  let listener: ((confirmation: BackupImportConfirmation) => void) | undefined
  let finish!: (result: 'cancelled' | 'restarting') => void
  let fail!: (error: unknown) => void
  const removeListener = vi.fn()
  const importBackup = vi.fn(
    () =>
      new Promise<'cancelled' | 'restarting'>((resolve, reject) => {
        finish = resolve
        fail = reject
      }),
  )
  const confirmImport = vi.fn(async () => undefined)
  Object.defineProperty(window, 'zhijiApi', {
    configurable: true,
    value: {
      backup: {
        import: importBackup,
        confirmImport,
        onImportConfirmation: (next: typeof listener) => {
          listener = next
          return removeListener
        },
      },
    },
  })
  let workspace!: ReturnType<typeof useBackupWorkspace>
  const showError = vi.fn()
  const wrapper = mount(
    defineComponent({
      setup() {
        workspace = useBackupWorkspace({ showError })
        return () => h('div')
      },
    }),
    { global: { plugins: [i18n] } },
  )
  return {
    workspace,
    wrapper,
    showError,
    confirmation,
    importBackup,
    confirmImport,
    removeListener,
    finish: (result: 'cancelled' | 'restarting') => finish(result),
    fail: (error: unknown) => fail(error),
    request: () => listener?.(confirmation),
  }
}

describe('backup workspace', () => {
  it('waits for confirmation, blocks duplicate imports and cancels without restarting', async () => {
    const f = setup()
    try {
      const running = f.workspace.backupAction('import')
      f.request()
      expect(f.workspace.backupConfirmation.value).toEqual(f.confirmation)
      expect(f.workspace.backupStatus.value).toBe('')
      expect(f.confirmImport).not.toHaveBeenCalled()
      await f.workspace.backupAction('import')
      expect(f.importBackup).toHaveBeenCalledOnce()
      await f.workspace.decideBackupImport(false)
      expect(f.confirmImport).toHaveBeenCalledWith('test-request', false)
      f.finish('cancelled')
      await running
      expect(f.workspace.backupBusy.value).toBe(false)
      expect(f.workspace.backupConfirmation.value).toBeNull()
      expect(f.removeListener).toHaveBeenCalledOnce()
    } finally {
      f.wrapper.unmount()
    }
  })

  it('locks confirmation after acceptance and remains busy until the application restarts', async () => {
    const f = setup()
    try {
      const running = f.workspace.backupAction('import')
      f.request()
      await f.workspace.decideBackupImport(true)
      await f.workspace.decideBackupImport(true)
      await f.workspace.decideBackupImport(false)
      expect(f.confirmImport).toHaveBeenCalledExactlyOnceWith('test-request', true)
      expect(f.workspace.backupRestoring.value).toBe(true)
      f.finish('restarting')
      await running
      expect(f.workspace.backupBusy.value).toBe(true)
      expect(f.workspace.backupConfirmation.value).toEqual(f.confirmation)
      expect(f.workspace.backupStatus.value).toContain('正在重启')
    } finally {
      f.wrapper.unmount()
    }
  })

  it('reports restoration failure through message feedback and enables another import', async () => {
    const f = setup()
    try {
      const running = f.workspace.backupAction('import')
      f.request()
      await f.workspace.decideBackupImport(true)
      const error = { code: 'BACKUP_FAILED' }
      f.fail(error)
      await running
      expect(f.showError).toHaveBeenCalledWith(error)
      expect(f.workspace.backupBusy.value).toBe(false)
      expect(f.workspace.backupRestoring.value).toBe(false)
      expect(f.workspace.backupConfirmation.value).toBeNull()
      expect(f.workspace.backupStatus.value).toBe('')
    } finally {
      f.wrapper.unmount()
    }
  })

  it('cancels a pending confirmation when the workspace unmounts', async () => {
    const f = setup()
    const running = f.workspace.backupAction('import')
    f.request()
    f.wrapper.unmount()
    await flushPromises()
    expect(f.confirmImport).toHaveBeenCalledWith('test-request', false)
    f.finish('cancelled')
    await running
  })
})
