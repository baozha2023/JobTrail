import { app, BrowserWindow, Menu, Tray, dialog, nativeTheme } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { VelopackApp } from 'velopack'
import { ConfigService, getAppPaths } from './config'
import type { DatabaseManager } from './database'
import { registerIpc, registerWindowIpc } from './ipc'
import { createServiceContainer } from './service-container'
import { ReminderScheduler } from './reminder-scheduler'
import { registerVelopackIpc } from './velopack'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const APP_ID = 'zhiji'
const APP_ICON_PATH = app.isPackaged
  ? path.join(process.resourcesPath, 'icon.ico')
  : path.join(__dirname, '../../resource/icon.ico')

let database: DatabaseManager | undefined
let mainWindow: BrowserWindow | undefined
let tray: Tray | undefined
let isQuitting = false
let reminderScheduler: ReminderScheduler | undefined

// Velopack must run before Electron startup work.
VelopackApp.build().run()
const hasSingleInstanceLock = app.requestSingleInstanceLock()
app.setAppUserModelId(APP_ID)

if (!hasSingleInstanceLock) app.quit()

app.on('second-instance', () => {
  if (!hasSingleInstanceLock || !mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
})

function ensureTray(window: BrowserWindow): void {
  if (tray) return
  tray = new Tray(APP_ICON_PATH)
  tray.setToolTip('职迹')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示职迹', click: () => { window.show(); window.focus() } },
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; app.quit() } },
  ]))
  tray.on('click', () => { window.show(); window.focus() })
}

function createWindow(config: ConfigService): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 760,
    minHeight: 480,
    title: '职迹',
    frame: false,
    icon: APP_ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  mainWindow = window

  if (process.platform === 'win32') {
    window.setAppDetails({
      appId: APP_ID,
      appIconPath: APP_ICON_PATH,
      appIconIndex: 0,
      relaunchCommand: process.execPath,
      relaunchDisplayName: '职迹',
    })
  }

  window.on('close', (event) => {
    if (!isQuitting && config.get().closeBehavior === 'tray') {
      event.preventDefault()
      ensureTray(window)
      window.hide()
    }
  })
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = undefined
  })

  registerWindowIpc(window)

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

function initializeApplication(): void {
  Menu.setApplicationMenu(null)
  const paths = getAppPaths()
  const config = new ConfigService(paths)
  const container = createServiceContainer(paths, !app.isPackaged)
  database = container.database
  registerIpc(container.services, config)
  registerVelopackIpc()
  app.setLoginItemSettings({ openAtLogin: config.get().launchAtStartup })
  nativeTheme.themeSource = config.get().themeMode
  createWindow(config)
  reminderScheduler = new ReminderScheduler(container.services.reminders, () => mainWindow, () => config.get().locale)
  reminderScheduler.start()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(config)
    else mainWindow?.show()
  })
}

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) return
  try {
    initializeApplication()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    dialog.showErrorBox('职迹启动失败', message)
    app.quit()
  }
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  dialog.showErrorBox('职迹启动失败', message)
  app.quit()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  isQuitting = true
  reminderScheduler?.stop()
  database?.close()
  tray?.destroy()
  tray = undefined
})
