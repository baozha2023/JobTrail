import { app, ipcMain } from 'electron'
import { UpdateManager } from 'velopack'
import type { ConfigService } from './config'

export function registerVelopackIpc(configService: ConfigService): void {
  ipcMain.handle('velopack:get-version', () => {
    try {
      const manager = createManager(configService)
      return manager ? manager.getCurrentVersion() : app.getVersion()
    } catch {
      return app.getVersion()
    }
  })

  ipcMain.handle('velopack:check-for-update', async () => {
    const manager = createManager(configService)
    if (!manager) return null
    return manager.checkForUpdatesAsync()
  })

  ipcMain.handle('velopack:download-update', async (_event, updateInfo) => {
    const manager = createManager(configService)
    if (!manager) return false
    await manager.downloadUpdateAsync(updateInfo)
    return true
  })

  ipcMain.handle('velopack:apply-update', async (_event, updateInfo) => {
    const manager = createManager(configService)
    if (!manager) return false
    await manager.waitExitThenApplyUpdate(updateInfo)
    app.quit()
    return true
  })
}

function createManager(configService: ConfigService): UpdateManager | null {
  const repository = configService.get().velopack.githubRepository.trim()
  if (!repository) return null
  // The JavaScript binding accepts Velopack's default URL source. GitHub
  // Release assets are exposed from the latest stable release download path,
  // so the feed and package assets share one URL base.
  const baseUrl = repository.replace(/\/$/, '').endsWith('/releases/latest/download')
    ? repository.replace(/\/$/, '')
    : `${repository.replace(/\/$/, '')}/releases/latest/download`
  return new UpdateManager(baseUrl)
}
