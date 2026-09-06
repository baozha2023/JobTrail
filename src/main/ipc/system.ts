import { app, BrowserWindow, shell } from 'electron'
import { registerChannel } from './register-channel'
import { parseUrl } from './validators'

export function registerSystemIpc(): void {
  registerChannel('system:open-external', (url) => shell.openExternal(parseUrl(url)))
  registerChannel('system:is-development', () => !app.isPackaged)
}

export function registerWindowIpc(window: BrowserWindow): void {
  registerChannel('window:minimize', () => window.minimize())
  registerChannel('window:toggle-maximize', () => {
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
    return window.isMaximized()
  })
  registerChannel('window:close', () => window.close())
}
