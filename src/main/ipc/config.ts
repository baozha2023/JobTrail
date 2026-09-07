import { app, nativeTheme } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { getStorageRoot } from '../config'
import { ROOT_LAUNCHER } from '../installation-paths'
import type { ConfigService } from '../config'
import { registerChannel } from './register-channel'
import { record, type ConfigUpdate } from './validators'

export function registerConfigIpc(config: ConfigService): void {
  registerChannel('config:get', () => config.get())
  registerChannel('config:update', (input) => {
    const next = config.update(record(input, '配置') as ConfigUpdate)
    nativeTheme.themeSource = next.themeMode
    if (app.isPackaged && fs.existsSync(path.join(getStorageRoot(), '.jobtrail-root')))
      app.setLoginItemSettings({
        name: 'JobTrail',
        openAtLogin: next.launchAtStartup,
        path: path.join(getStorageRoot(), ROOT_LAUNCHER),
      })
    return next
  })
}
