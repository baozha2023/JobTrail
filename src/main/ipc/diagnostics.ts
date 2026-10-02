import { app, dialog, shell } from 'electron'
import { registerChannel } from './register-channel'
import { getStorageRoot } from '../config'
import { flushDiagnostics, getDiagnosticsHealth, maintenanceDiagnostics } from '../diagnostics'
import { ensureLogDirectory } from '../diagnostics/storage'
import { exportDiagnosticBundle } from '../diagnostics/export'
import { TARGET_DATABASE_VERSION, TARGET_CONFIG_VERSION } from '../persistence-migrations'
import { AppServiceError } from '../services/errors'

export function registerDiagnosticsIpc(): void {
  let exporting = false
  registerChannel('diagnostics:status', () => getDiagnosticsHealth())
  registerChannel('diagnostics:open-directory', async () => {
    const failure = await shell.openPath(ensureLogDirectory(getStorageRoot()))
    if (failure)
      throw new AppServiceError(
        'DIAGNOSTICS_FAILED',
        'Unable to open diagnostic directory',
        undefined,
        { cause: new Error(failure) },
      )
  })
  registerChannel('diagnostics:export', async () => {
    if (exporting)
      throw new AppServiceError('VALIDATION_ERROR', 'Diagnostic export is already running')
    exporting = true
    try {
      const picked = await dialog.showSaveDialog({
        defaultPath: `JobTrail-diagnostics-${new Date().toISOString().slice(0, 10)}.zip`,
        filters: [{ name: 'ZIP', extensions: ['zip'] }],
      })
      if (picked.canceled || !picked.filePath) return 'cancelled'
      flushDiagnostics()
      maintenanceDiagnostics()
      await exportDiagnosticBundle(
        getStorageRoot(),
        picked.filePath,
        {
          appVersion: app.getVersion(),
          electronVersion: process.versions.electron,
          nodeVersion: process.versions.node,
          databaseVersion: TARGET_DATABASE_VERSION,
          configVersion: TARGET_CONFIG_VERSION,
        },
        getDiagnosticsHealth(),
      )
      return 'exported'
    } catch (error) {
      if (error instanceof AppServiceError) throw error
      throw new AppServiceError(
        'DIAGNOSTICS_EXPORT_FAILED',
        'Diagnostic export failed',
        undefined,
        { cause: error },
      )
    } finally {
      exporting = false
    }
  })
}
