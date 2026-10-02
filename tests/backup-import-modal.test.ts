// @vitest-environment jsdom

import { mount } from '@vue/test-utils'
import { NModal } from 'naive-ui'
import { describe, expect, it } from 'vitest'
import { i18n } from '../src/renderer/i18n'
import BackupImportModal from '../src/renderer/components/BackupImportModal.vue'

const confirmation = {
  requestId: 'import-request',
  appVersion: '1.2.0',
  createdAt: '2026-09-30T16:28:15.062Z',
}
function setup() {
  return mount(BackupImportModal, {
    props: { confirmation, currentVersion: '1.3.0', deciding: false, restoring: false },
    global: { plugins: [i18n], stubs: { teleport: true, transition: false } },
  })
}

describe('backup import confirmation', () => {
  it('shows verified backup details and requires an explicit choice', async () => {
    const wrapper = setup()
    try {
      const dialog = wrapper.get('[role="dialog"]')
      expect(dialog.text()).toContain('确认导入备份')
      expect(dialog.text()).toContain('1.3.0')
      expect(dialog.text()).toContain('1.2.0')
      expect(dialog.text()).toContain('全部当前数据')
      expect(dialog.text()).toContain('聊天历史及附件')
      expect(dialog.text()).toContain('先取消并导出备份')
      expect(wrapper.get('time').attributes('datetime')).toBe(confirmation.createdAt)
      expect(wrapper.get('time').text()).not.toContain('T16:28')
      expect(wrapper.findComponent(NModal).props('maskClosable')).toBe(false)
      expect(wrapper.findComponent(NModal).props('closeOnEsc')).toBe(false)
      expect(wrapper.emitted('confirm')).toBeUndefined()
      const buttons = wrapper.findAll('button')
      await buttons[0].trigger('click')
      expect(wrapper.emitted('cancel')).toHaveLength(1)
      expect(wrapper.emitted('confirm')).toBeUndefined()
      await buttons[1].trigger('click')
      expect(wrapper.emitted('confirm')).toHaveLength(1)
    } finally {
      wrapper.unmount()
    }
  })

  it('disables both decisions during restoration and displays the pending restart', async () => {
    const wrapper = setup()
    try {
      await wrapper.setProps({ restoring: true })
      for (const button of wrapper.findAll('button')) {
        expect(button.attributes('disabled')).toBeDefined()
        await button.trigger('click')
      }
      expect(wrapper.get('[role="status"]').text()).toContain('请勿关闭应用')
      expect(wrapper.emitted('confirm')).toBeUndefined()
      expect(wrapper.emitted('cancel')).toBeUndefined()
    } finally {
      wrapper.unmount()
    }
  })

  it('translates the warning, actions and backup date into English', () => {
    const originalLocale = i18n.global.locale.value
    i18n.global.locale.value = 'en-US'
    const wrapper = setup()
    try {
      expect(wrapper.get('[role="dialog"]').text()).toContain('Confirm backup import')
      expect(wrapper.text()).toContain('All current data will be replaced')
      expect(wrapper.text()).toContain('Replace and restart')
      expect(wrapper.get('time').text()).toBe(
        new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(
          new Date(confirmation.createdAt),
        ),
      )
    } finally {
      wrapper.unmount()
      i18n.global.locale.value = originalLocale
    }
  })
})
