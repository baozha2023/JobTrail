import { onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { BackupImportConfirmation } from '../../shared/types'
import { reportRendererFault } from '../diagnostics'

export function useBackupWorkspace(options: { showError: (error: unknown) => void }) {
  const { t } = useI18n()
  const backupBusy = ref(false)
  const backupStatus = ref('')
  const backupConfirmation = ref<BackupImportConfirmation | null>(null)
  const backupDeciding = ref(false)
  const backupRestoring = ref(false)
  let removeConfirmationListener: (() => void) | undefined

  async function backupAction(kind: 'export' | 'import'): Promise<void> {
    if (backupBusy.value) return
    backupBusy.value = true
    backupStatus.value = t('settings.backupWorking')
    let restarting = false
    try {
      if (kind === 'import')
        removeConfirmationListener = window.zhijiApi.backup.onImportConfirmation((confirmation) => {
          backupConfirmation.value = confirmation
          backupStatus.value = ''
        })
      const result = await window.zhijiApi.backup[kind]()
      restarting = result === 'restarting'
      backupStatus.value =
        result === 'cancelled'
          ? ''
          : t(result === 'exported' ? 'settings.backupExported' : 'settings.backupRestarting')
    } catch (error) {
      backupStatus.value = ''
      options.showError(error)
    } finally {
      removeConfirmationListener?.()
      removeConfirmationListener = undefined
      if (!restarting) {
        backupBusy.value = false
        backupConfirmation.value = null
        backupRestoring.value = false
      }
    }
  }

  async function decideBackupImport(confirmed: boolean): Promise<void> {
    const confirmation = backupConfirmation.value
    if (!confirmation || backupDeciding.value || backupRestoring.value) return
    backupDeciding.value = true
    backupRestoring.value = confirmed
    try {
      await window.zhijiApi.backup.confirmImport(confirmation.requestId, confirmed)
      if (!confirmed) backupConfirmation.value = null
    } catch (error) {
      backupRestoring.value = false
      options.showError(error)
    } finally {
      backupDeciding.value = false
    }
  }

  onBeforeUnmount(() => {
    removeConfirmationListener?.()
    if (backupConfirmation.value && !backupDeciding.value && !backupRestoring.value)
      void window.zhijiApi.backup
        .confirmImport(backupConfirmation.value.requestId, false)
        .catch((error) => reportRendererFault('backup.cancel-import', error))
  })

  return {
    backupBusy,
    backupStatus,
    backupConfirmation,
    backupDeciding,
    backupRestoring,
    backupAction,
    decideBackupImport,
  }
}
