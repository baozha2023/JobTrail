import { app } from 'electron'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { UpdateManager } from 'velopack'
import { getStorageRoot } from './config'
import { ROOT_UNINSTALLER } from './installation-paths'
import { registerChannel } from './ipc/register-channel'
import { AppServiceError } from './services/errors'
import { DesktopUpdateService } from './update-service'

export const UPDATE_FEED_URL = 'https://github.com/baozha2023/JobTrail/releases/latest/download'

export function registerVelopackIpc(): void {
  let service: DesktopUpdateService | undefined
  let closing = false
  const getService = () => {
    if (closing) throw new AppServiceError('VALIDATION_ERROR', '应用正在退出')
    if (
      !app.isPackaged ||
      process.platform !== 'win32' ||
      !fs.existsSync(path.join(getStorageRoot(), '.jobtrail-root'))
    ) {
      throw new AppServiceError('VALIDATION_ERROR', '请使用已安装的 Windows 版本检查更新')
    }
    return (service ??= new DesktopUpdateService(new UpdateManager(UPDATE_FEED_URL)))
  }
  registerChannel('velopack:get-version', () => app.getVersion())
  registerChannel('velopack:check-for-update', () => getService().check())
  registerChannel('velopack:download-update', () => getService().download())
  registerChannel('velopack:apply-update', async () => {
    await getService().apply()
    closing = true
    setImmediate(() => app.quit())
    return true
  })
  registerChannel('velopack:uninstall', async () => {
    if (!app.isPackaged) return 'development'
    if (process.platform !== 'win32') return 'unavailable'
    if (closing || service?.isBusy())
      throw new AppServiceError('VALIDATION_ERROR', '请等待更新操作完成后卸载')
    const uninstaller = path.join(getStorageRoot(), ROOT_UNINSTALLER)
    if (!fs.existsSync(uninstaller)) return 'unavailable'
    closing = true
    await new Promise<void>((resolve, reject) => {
      const child = spawn(uninstaller, ['--confirmed', '--wait-pid', String(process.pid)], {
        cwd: getStorageRoot(),
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      child.once('error', (error) => {
        closing = false
        reject(error)
      })
      child.once('spawn', () => {
        child.unref()
        resolve()
      })
    })
    setImmediate(() => app.quit())
    return 'started'
  })
}
