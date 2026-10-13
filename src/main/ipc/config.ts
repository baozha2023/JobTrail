import { app, nativeTheme } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { getStorageRoot } from '../config'
import { ROOT_LAUNCHER } from '../installation-paths'
import type { ConfigService } from '../config'
import { registerChannel } from './register-channel'
import { waitForStartupThaw } from '../update-freeze'

export function registerConfigIpc(config: ConfigService): void {
  // A supervised launch can render before its parent releases the health-check freeze.
  // Start this one-shot wait now; subsequent backup/update freezes must still reject writes.
  const startupReady = process.env.JOBTRAIL_LAUNCH_TOKEN
    ? waitForStartupThaw(getStorageRoot())
    : Promise.resolve()
  registerChannel('config:get', () => config.get())
  registerChannel('config:update', async (input) => {
    await startupReady
    const previous = config.get()
    const next = config.update(input)
    if (previous.themeMode !== next.themeMode) nativeTheme.themeSource = next.themeMode
    if (
      previous.launchAtStartup !== next.launchAtStartup &&
      app.isPackaged &&
      fs.existsSync(path.join(getStorageRoot(), '.jobtrail-root'))
    )
      app.setLoginItemSettings({
        name: 'JobTrail',
        openAtLogin: next.launchAtStartup,
        path: path.join(getStorageRoot(), ROOT_LAUNCHER),
      })
    return next
  })
}
