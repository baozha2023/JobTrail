import { featureErrors } from '../shared/feature-errors'
import { AppServiceError } from './services/errors'
import { ExamGrader } from './agent/exam-grader'
import { registerExamIpc } from './ipc/exams'
import { ensurePersistenceReady } from './persistence-migrations'
import { app, BrowserWindow, Menu, Tray, dialog, nativeImage, nativeTheme, shell } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { VelopackApp } from 'velopack'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { APP_ID, ROOT_LAUNCHER } from './installation-paths'
import { registerDiagnosticIpc, trustWindow } from './ipc/register-channel'
import { ConfigLoadError, ConfigService, getAppPaths, getStorageRoot } from './config'
import { DatabaseVersionError, INCOMPATIBLE_DATA_EXIT_CODE, type DatabaseManager } from './database'
import { registerIpc, registerWindowIpc } from './ipc'
import { createServiceContainer } from './service-container'
import { ReminderScheduler } from './reminder-scheduler'
import { registerVelopackIpc } from './velopack'
import { resolveDesktopAssets } from './runtime-assets'
import { ExternalDataMonitor } from './external-data-monitor'
import { AgentService } from './agent/service'
import { AgentCoordinator } from './agent/coordinator'
import { getMcpConnectionInfo } from './ipc/mcp'
import { registerBackupIpc } from './ipc/backup'
import { sendToTrustedWindow } from './ipc/register-channel'
import { initializeFaultLogger, logFault, reportFault } from './diagnostics'

// Velopack must run before Electron startup work.
try {
  VelopackApp.build().setAutoApplyOnStartup(false).run()
} catch (error) {
  initializeFaultLogger('main', app.getVersion(), app.isPackaged, getStorageRoot())
  logFault('startup.velopack', error)
  throw error
}

initializeFaultLogger('main', app.getVersion(), app.isPackaged, getStorageRoot())
registerDiagnosticIpc()
process.on('uncaughtExceptionMonitor', (error) => logFault('process.uncaught', error))
process.on('unhandledRejection', (error) => {
  logFault('process.unhandled-rejection', error)
  setImmediate(() => {
    throw error
  })
})
app.on('render-process-gone', (_event, _contents, details) => {
  if (details.reason !== 'clean-exit')
    reportFault({ source: 'main', operation: 'renderer.exit', code: 'PROCESS_EXITED' })
})
app.on('child-process-gone', (_event, details) => {
  if (details.reason !== 'clean-exit' && details.serviceName !== 'JobTrail Agent')
    reportFault({ source: 'main', operation: 'child.exit', code: 'PROCESS_EXITED' })
})

const APP_DISPLAY_NAME = '职迹'
const installedLauncher = path.join(getStorageRoot(), ROOT_LAUNCHER)
const installed = app.isPackaged && fs.existsSync(path.join(getStorageRoot(), '.jobtrail-root'))
const APP_USER_MODEL_ID = app.isPackaged ? APP_ID : `${APP_ID}.development`
const APP_ICON_PATH = app.isPackaged
  ? path.join(process.resourcesPath, 'icon.ico')
  : path.join(app.getAppPath(), 'resource', 'icon.ico')
const DEVELOPMENT_SHORTCUT_NAME = `${path.parse(process.execPath).name}.lnk`

let database: DatabaseManager | undefined
let agent: AgentCoordinator | undefined
let mainWindow: BrowserWindow | undefined
let tray: Tray | undefined
let isQuitting = false
let shutdownStarted = false
let shutdownComplete = false
let reminderScheduler: ReminderScheduler | undefined
let externalDataMonitor: ExternalDataMonitor | undefined
let cancelCompanyCatalogUpdate: (() => void) | undefined

const handoff = app.isPackaged && process.argv.includes('--handoff-root')
if (handoff) {
  const child = spawn(path.join(getStorageRoot(), ROOT_LAUNCHER), [], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.once('error', (error) => {
    logFault('update.handoff', error)
    dialog.showErrorBox('职迹启动失败', error.message)
    app.exit(1)
  })
  child.once('spawn', () => {
    child.unref()
    app.exit(0)
  })
}
const hasSingleInstanceLock = !handoff && app.requestSingleInstanceLock()
app.setAppUserModelId(APP_USER_MODEL_ID)

if (!hasSingleInstanceLock && !handoff) app.quit()

function ensureDevelopmentTaskbarIdentity(): void {
  if (process.platform !== 'win32' || app.isPackaged) return

  const programs = path.join(
    app.getPath('appData'),
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
  )
  const details: Electron.ShortcutDetails = {
    target: process.execPath,
    cwd: app.getAppPath(),
    args: `"${app.getAppPath()}"`,
    description: `${APP_DISPLAY_NAME}开发环境`,
    icon: APP_ICON_PATH,
    iconIndex: 0,
    appUserModelId: APP_USER_MODEL_ID,
  }
  const shortcutPath = path.join(programs, DEVELOPMENT_SHORTCUT_NAME)
  const shortcutOperation = fs.existsSync(shortcutPath) ? 'update' : 'create'
  shell.writeShortcutLink(shortcutPath, shortcutOperation, details)
}

app.on('second-instance', () => {
  if (!hasSingleInstanceLock || !mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
})

function ensureTray(window: BrowserWindow): void {
  if (tray) return
  tray = new Tray(APP_ICON_PATH)
  tray.setToolTip(APP_DISPLAY_NAME)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '显示职迹',
        click: () => {
          window.show()
          window.focus()
        },
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          isQuitting = true
          app.quit()
        },
      },
    ]),
  )
  tray.on('click', () => {
    window.show()
    window.focus()
  })
}

function isTrustedRendererNavigation(target: string, rendererUrl: string): boolean {
  try {
    const candidate = new URL(target)
    const trusted = new URL(rendererUrl)
    if (trusted.protocol === 'file:')
      return (
        candidate.protocol === 'file:' &&
        candidate.host === trusted.host &&
        candidate.pathname === trusted.pathname
      )
    return candidate.origin === trusted.origin
  } catch {
    return false
  }
}

function createWindow(config: ConfigService): void {
  const assets = resolveDesktopAssets(app.getAppPath())
  const appIcon = nativeImage.createFromPath(APP_ICON_PATH)
  if (appIcon.isEmpty()) throw new Error(`无法加载应用图标：${APP_ICON_PATH}`)

  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 720,
    minWidth: 760,
    minHeight: 480,
    title: APP_DISPLAY_NAME,
    frame: false,
    icon: appIcon,
    webPreferences: {
      preload: assets.preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  mainWindow = window
  trustWindow(window)
  window.once('ready-to-show', () => {
    ensureDevelopmentTaskbarIdentity()
    window.show()
  })

  const rendererFile = assets.renderer
  const rendererUrl =
    (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) || pathToFileURL(rendererFile).toString()
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, target) => {
    if (!isTrustedRendererNavigation(target, rendererUrl)) event.preventDefault()
  })
  window.webContents.on('preload-error', (_event, _path, error) => logFault('preload.load', error))

  if (process.platform === 'win32') {
    window.setAppDetails({
      appId: APP_USER_MODEL_ID,
      appIconPath: APP_ICON_PATH,
      appIconIndex: 0,
      relaunchCommand: app.isPackaged
        ? `"${installed ? installedLauncher : process.execPath}"`
        : `"${process.execPath}" "${app.getAppPath()}"`,
      relaunchDisplayName: APP_DISPLAY_NAME,
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

  const loadRenderer =
    !app.isPackaged && process.env.ELECTRON_RENDERER_URL
      ? window.loadURL(rendererUrl)
      : window.loadFile(rendererFile)
  void loadRenderer.catch((error: unknown) => {
    logFault('renderer.load', error)
    const message = error instanceof Error ? error.message : String(error)
    dialog.showErrorBox('职迹界面加载失败', message)
    app.quit()
  })
}

async function initializeApplication(): Promise<void> {
  Menu.setApplicationMenu(null)
  const paths = getAppPaths()
  await ensurePersistenceReady(paths, Boolean(process.env.JOBTRAIL_LAUNCH_TOKEN))
  const config = new ConfigService(paths)
  const container = createServiceContainer(paths, !app.isPackaged)
  database = container.database
  const agentCore = new AgentService(
    paths,
    container.database.db,
    config,
    container.services,
    getMcpConnectionInfo,
    () => undefined,
  )
  await agentCore.recoverPendingDeletions()
  const grader = new ExamGrader(
    container.services.exams,
    config,
    (identity) => sendToTrustedWindow('exams:changed', identity),
    paths.root,
  )
  agent = new AgentCoordinator(
    agentCore,
    paths,
    getMcpConnectionInfo,
    (event) => sendToTrustedWindow('agent:event', event),
    grader,
  )
  registerExamIpc(container.services.exams, grader)
  cancelCompanyCatalogUpdate = registerIpc(container.services, config, agent)
  registerVelopackIpc(container.database, agent)
  registerBackupIpc(paths, container.database, config, agent, () => {
    app.relaunch()
    app.quit()
  })
  if (installed)
    app.setLoginItemSettings({
      name: 'JobTrail',
      openAtLogin: config.get().launchAtStartup,
      path: path.join(paths.root, ROOT_LAUNCHER),
    })
  nativeTheme.themeSource = config.get().themeMode
  createWindow(config)
  reminderScheduler = new ReminderScheduler(
    container.services.reminders,
    () => mainWindow,
    () => config.get().locale,
  )
  reminderScheduler.start()
  externalDataMonitor = new ExternalDataMonitor(container.database, () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('data:external-change')
  })
  externalDataMonitor.start()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(config)
    else mainWindow?.show()
  })
}

app
  .whenReady()
  .then(async () => {
    if (!hasSingleInstanceLock || process.argv.includes('--handoff-root')) return
    try {
      await initializeApplication()
    } catch (error) {
      logFault('startup.initialize', error)
      if (error instanceof ConfigLoadError || error instanceof DatabaseVersionError) {
        // A root launch owns the final error message after any update rollback.
        // Direct development/runtime launches have no parent to report the failure.
        if (!process.env.JOBTRAIL_LAUNCH_TOKEN)
          dialog.showErrorBox(
            '职迹无法读取本地数据 / Unable to read local data',
            error instanceof ConfigLoadError && error.code === 'CONFIG_INVALID'
              ? '配置文件损坏、内容无效或加密密钥不匹配。原配置和数据库已保留，未重置。请保留数据目录，使用相同构建密钥的客户端，或联系维护者协助恢复备份。\nConfiguration is invalid or cannot be decrypted. Your data has been preserved.'
              : '配置或数据库版本不受当前客户端支持。原数据已保留，请使用支持该数据版本的客户端。\nThis data version is unsupported. Your data has been preserved; use a compatible client.',
          )
        setImmediate(() => app.exit(INCOMPATIBLE_DATA_EXIT_CODE))
        return
      }
      const message =
        error instanceof AppServiceError && error.code in featureErrors['zh-CN']
          ? featureErrors['zh-CN'][error.code as keyof (typeof featureErrors)['zh-CN']] +
            '\n' +
            featureErrors['en-US'][error.code as keyof (typeof featureErrors)['en-US']]
          : '职迹启动失败，请查看日志。 / Startup failed. Please check the logs.'
      if (!process.env.JOBTRAIL_LAUNCH_TOKEN)
        dialog.showErrorBox('职迹启动失败 / Startup failed', message)
      setImmediate(() =>
        app.exit(
          error instanceof AppServiceError &&
            ['PERSISTENCE_INVALID', 'PERSISTENCE_UNSUPPORTED'].includes(error.code)
            ? INCOMPATIBLE_DATA_EXIT_CODE
            : 1,
        ),
      )
    }
  })
  .catch((error: unknown) => {
    logFault('startup.ready', error)
    const message = error instanceof Error ? error.message : String(error)
    dialog.showErrorBox('职迹启动失败', message)
    app.quit()
  })

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (shutdownComplete) return
  event.preventDefault()
  if (shutdownStarted) return
  shutdownStarted = true
  isQuitting = true
  cancelCompanyCatalogUpdate?.()
  externalDataMonitor?.stop()
  reminderScheduler?.stop()
  void (async () => {
    try {
      await agent?.close()
    } catch (error) {
      logFault('agent.close', error)
    } finally {
      try {
        database?.close()
        tray?.destroy()
        tray = undefined
      } finally {
        shutdownComplete = true
        app.quit()
      }
    }
  })()
})
