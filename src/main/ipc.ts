import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron'
import type { ConfigService } from './config'
import { AppServiceError } from './services'
import type { Services } from './services'

function register(channel: string, handler: (...args: any[]) => unknown): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return await handler(...args)
    } catch (error) {
      if (error instanceof AppServiceError) throw new Error(`${error.code}: ${error.message}`)
      throw error
    }
  })
}

export function registerIpc(services: Services, config: ConfigService): void {
  register('config:get', () => config.get())
  register('config:update', (input) => {
    const next = config.update(input)
    nativeTheme.themeSource = next.themeMode
    app.setLoginItemSettings({ openAtLogin: next.launchAtStartup })
    return next
  })

  register('statuses:list', () => services.statuses.list())
  register('statuses:create', (input) => services.statuses.create(input))
  register('statuses:update', (id, input) => services.statuses.update(Number(id), input))
  register('statuses:delete', (id) => services.statuses.delete(Number(id)))
  register('statuses:reorder', (order) => services.statuses.reorder(order))

  register('industries:list', () => services.industries.list())
  register('industries:create', (input) => services.industries.create(input))
  register('industries:update', (id, input) => services.industries.update(Number(id), input))
  register('industries:delete', (id) => services.industries.delete(Number(id)))
  register('industries:reorder', (order) => services.industries.reorder(order))

  register('companies:search', (keyword) => services.companies.search(String(keyword ?? '')))
  register('companies:recent', () => services.companies.recent())
  register('companies:create', (input) => services.companies.create(input))
  register('companies:update', (id, input) => services.companies.update(Number(id), input))
  register('companies:delete', (id) => services.companies.delete(Number(id)))
  register('companies:aliases:list', (companyId) => services.companyAliases.list(Number(companyId)))
  register('companies:aliases:create', (input) => services.companyAliases.create(input))
  register('companies:aliases:update', (id, input) => services.companyAliases.update(Number(id), input))
  register('companies:aliases:delete', (id) => services.companyAliases.delete(Number(id)))

  register('resumes:list', () => services.resumes.list())
  register('resumes:import', async () => {
    const selected = await dialog.showOpenDialog({
      title: '导入简历',
      properties: ['openFile'],
      filters: [{ name: '简历文件', extensions: ['pdf', 'doc', 'docx'] }],
    })
    if (selected.canceled || selected.filePaths.length === 0) return null
    return services.resumes.importFromPath(selected.filePaths[0])
  })
  register('resumes:open', async (id) => {
    const result = await shell.openPath(services.resumes.getPath(Number(id)))
    if (result) throw new Error(`FILE_OPEN_FAILED: ${result}`)
  })
  register('resumes:update', (id, input) => services.resumes.update(Number(id), input))
  register('resumes:delete', (id) => services.resumes.delete(Number(id)))

  register('opportunities:list', (query) => services.opportunities.list(query ?? {}))
  register('opportunities:create', (input) => services.opportunities.create(input))
  register('opportunities:update', (id, input) => services.opportunities.update(Number(id), input))
  register('opportunities:delete', (id) => services.opportunities.delete(Number(id)))
  register('opportunities:change-status', (id, statusId) => services.opportunities.changeStatus(Number(id), Number(statusId)))

  register('calendar:list', (range) => services.calendar.list(range))
  register('calendar:create', (input) => services.calendar.create(input))
  register('calendar:update', (id, input) => services.calendar.update(Number(id), input))
  register('calendar:delete', (id) => services.calendar.delete(Number(id)))
  register('calendar:complete', (id, completed) => services.calendar.complete(Number(id), Boolean(completed)))

  register('system:open-external', (url) => {
    const parsed = new URL(String(url))
    if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('VALIDATION_ERROR: 仅允许打开 HTTP(S) 链接')
    return shell.openExternal(parsed.toString())
  })
}

export function registerWindowIpc(window: BrowserWindow): void {
  register('window:minimize', () => window.minimize())
  register('window:toggle-maximize', () => {
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
    return window.isMaximized()
  })
  register('window:close', () => window.close())
}
