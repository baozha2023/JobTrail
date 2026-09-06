import { app, nativeTheme } from 'electron'
import type { ConfigService } from '../config'
import { registerChannel } from './register-channel'
import { record, type ConfigUpdate } from './validators'

export function registerConfigIpc(config: ConfigService): void {
  registerChannel('config:get', () => config.get())
  registerChannel('config:update', (input) => {
    const next = config.update(record(input, '配置') as ConfigUpdate)
    nativeTheme.themeSource = next.themeMode
    app.setLoginItemSettings({ openAtLogin: next.launchAtStartup })
    return next
  })
}
