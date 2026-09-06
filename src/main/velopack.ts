import { app } from 'electron'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { UpdateManager, type UpdateInfo } from 'velopack'
import { getStorageRoot } from './config'
import { registerChannel } from './ipc/register-channel'
import { AppServiceError } from './services/errors'

export const GITHUB_UPDATE_SOURCE = 'https://github.com/baozha2023/JobTrail'

let pendingUpdateInfo: UpdateInfo | null = null

export function registerVelopackIpc(): void {
  registerChannel('velopack:get-version', () => {
    try {
      return createManager().getCurrentVersion()
    } catch {
      return app.getVersion()
    }
  })

  registerChannel('velopack:check-for-update', async () => {
    pendingUpdateInfo = null
    pendingUpdateInfo = await createManager().checkForUpdatesAsync()
    return pendingUpdateInfo
  })

  registerChannel('velopack:download-update', async () => {
    const manager = createManager()
    await manager.downloadUpdateAsync(requirePendingUpdate())
    return true
  })

  registerChannel('velopack:apply-update', async () => {
    const manager = createManager()
    await manager.waitExitThenApplyUpdate(requirePendingUpdate())
    app.quit()
    return true
  })

  registerChannel('velopack:uninstall', async () => {
    if (!app.isPackaged) return 'development'
    if (process.platform !== 'win32') return 'unavailable'

    const updateExePath = path.join(getStorageRoot(), 'Update.exe')
    if (!fs.existsSync(updateExePath)) return 'unavailable'

    try {
      await launchUninstaller(updateExePath)
    } catch (error) {
      console.error('Failed to launch Velopack uninstaller', error)
      return 'unavailable'
    }

    setImmediate(() => app.quit())
    return 'started'
  })
}

function requirePendingUpdate(): UpdateInfo {
  if (!pendingUpdateInfo) throw new AppServiceError('VALIDATION_ERROR', '请先检查更新')
  return pendingUpdateInfo
}

function launchUninstaller(updateExePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(updateExePath, ['--uninstall', '--silent'], {
      cwd: path.dirname(updateExePath),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    const handleError = (error: Error) => reject(error)
    child.once('error', handleError)
    child.once('spawn', () => {
      child.removeListener('error', handleError)
      child.unref()
      resolve()
    })
  })
}

function createManager(): UpdateManager {
  // Pass the repository root so Velopack can use its GitHub release source.
  // Do not pass /releases/latest/download: that path is for downloading one
  // named GitHub asset and is not a repository URL.
  return new UpdateManager(GITHUB_UPDATE_SOURCE)
}
