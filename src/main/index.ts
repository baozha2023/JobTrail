import { app, BrowserWindow, Menu, Tray, dialog, nativeTheme } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { VelopackApp } from 'velopack'
import { ConfigService, getAppPaths } from './config'
import { DatabaseManager } from './database'
import { FileStorageService } from './file-storage'
import { registerIpc, registerWindowIpc } from './ipc'
import { CalendarEventService, CompanyAliasService, CompanyService, IndustryService, OpportunityService, ResumeVersionService, StatusService } from './services'
import { registerVelopackIpc } from './velopack'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let database: DatabaseManager | undefined
let mainWindow: BrowserWindow | undefined
let tray: Tray | undefined
let isQuitting = false

// Velopack must run before Electron startup work.
VelopackApp.build().run()
app.setAppUserModelId('zhiji')

function ensureTray(window: BrowserWindow): void {
  if (tray) return
  tray = new Tray(path.join(__dirname, '../../build/icon.png'))
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
    icon: path.join(__dirname, '../../build/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  mainWindow = window

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
  database = new DatabaseManager(paths)
  const files = new FileStorageService(paths)
  registerIpc({
    statuses: new StatusService(database.db),
    industries: new IndustryService(database.db),
    companies: new CompanyService(database.db),
    companyAliases: new CompanyAliasService(database.db),
    resumes: new ResumeVersionService(database.db, files),
    opportunities: new OpportunityService(database.db),
    calendar: new CalendarEventService(database.db),
  }, config)
  registerVelopackIpc(config)
  app.setLoginItemSettings({ openAtLogin: config.get().launchAtStartup })
  nativeTheme.themeSource = config.get().themeMode
  createWindow(config)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(config)
    else mainWindow?.show()
  })
}

app.whenReady().then(() => {
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
  database?.close()
  tray?.destroy()
  tray = undefined
})
