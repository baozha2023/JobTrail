import { app, dialog, type BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { captureError } from '../diagnostics'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AppPaths, ConfigService } from '../config'
import type { DatabaseManager } from '../database'
import type { AgentCoordinator } from '../agent/coordinator'
import { exportBackup, importBackup } from '../backup-archive'
import { stageRestore, restoreDirectory, backupSessionPath } from '../backup-restore'
import { waitForMcpSessions, updateFreezePath } from '../update-freeze'
import { AppServiceError } from '../services/errors'
import { registerChannel } from './register-channel'

export function registerBackupIpc(
  paths: AppPaths,
  database: DatabaseManager,
  config: ConfigService,
  agent: Pick<AgentCoordinator, 'suspendForUpdate' | 'resumeAfterUpdate'>,
  restart: () => void,
  getWindow: () => BrowserWindow | undefined,
): void {
  let busy = false
  let pendingConfirmation: { requestId: string; resolve: (confirmed: boolean) => void } | undefined
  registerChannel('backup:confirm-import', (requestId, confirmed) => {
    if (
      typeof requestId !== 'string' ||
      typeof confirmed !== 'boolean' ||
      !pendingConfirmation ||
      pendingConfirmation.requestId !== requestId
    )
      throw new AppServiceError('VALIDATION_ERROR', '备份导入确认已失效')
    const pending = pendingConfirmation
    pendingConfirmation = undefined
    pending.resolve(confirmed)
  })
  const english = () => config.get().locale === 'en-US'
  const run = async (
    kind: 'export' | 'import',
  ): Promise<'cancelled' | 'exported' | 'restarting'> => {
    if (busy)
      throw new AppServiceError(
        'VALIDATION_ERROR',
        english() ? 'A backup operation is already running' : '备份操作正在进行',
      )
    busy = true
    let work: string | undefined
    let frozen = false
    let restarting = false
    const contents = kind === 'import' ? getWindow()?.webContents : undefined
    let cancelled = false
    const cancelConfirmation = () => {
      cancelled = true
      pendingConfirmation?.resolve(false)
      pendingConfirmation = undefined
    }
    contents?.once('destroyed', cancelConfirmation)
    contents?.once('render-process-gone', cancelConfirmation)
    contents?.once('did-start-navigation', cancelConfirmation)
    const freeze = updateFreezePath(paths.root)
    const pause = async () => {
      await fs.writeFile(backupSessionPath(paths.root), JSON.stringify({ pid: process.pid }), {
        flag: 'wx',
      })
      try {
        await agent.suspendForUpdate()
        await fs.writeFile(freeze, '', { flag: 'wx' })
        frozen = true
      } catch (error) {
        await fs.rm(backupSessionPath(paths.root), { force: true })
        agent.resumeAfterUpdate()
        throw error
      }
      await waitForMcpSessions(paths.root)
      database.db.transaction(() => undefined).immediate()
    }
    try {
      const picked =
        kind === 'export'
          ? await dialog
              .showSaveDialog({
                title: english() ? 'Export all personal data' : '导出全部个人数据',
                defaultPath: `JobTrail-${new Date().toISOString().slice(0, 10)}.jobtrail-backup`,
                filters: [{ name: 'JobTrail backup', extensions: ['jobtrail-backup'] }],
              })
              .then((r) => (r.canceled ? undefined : r.filePath))
          : await dialog
              .showOpenDialog({
                title: english() ? 'Import a backup' : '导入备份',
                properties: ['openFile'],
                filters: [{ name: 'JobTrail backup', extensions: ['jobtrail-backup'] }],
              })
              .then((r) => (r.canceled ? undefined : r.filePaths[0]))
      if (!picked) return 'cancelled'
      if (kind === 'export') {
        const relative = path.relative(
          await fs.realpath(paths.root),
          path.join(await fs.realpath(path.dirname(picked)), path.basename(picked)),
        )
        if (
          !relative.startsWith('..' + path.sep) &&
          relative !== '..' &&
          !path.isAbsolute(relative)
        )
          throw new AppServiceError(
            'VALIDATION_ERROR',
            english()
              ? 'Save the backup outside the application data folder'
              : '请将备份保存到应用数据目录之外',
          )
      }
      const runtime = path.join(paths.root, '.runtime')
      await fs.mkdir(runtime, { recursive: true })
      if ((await fs.lstat(runtime)).isSymbolicLink()) throw new Error('Unsafe runtime directory')
      await fs.mkdir(path.dirname(freeze), { recursive: true })
      if ((await fs.lstat(path.dirname(freeze))).isSymbolicLink())
        throw new Error('Unsafe state directory')
      work = await fs.mkdtemp(path.join(runtime, 'backup-work-'))
      if (kind === 'export') {
        await pause()
        await exportBackup(paths, database, config, app.getVersion(), picked, work)
        return 'exported'
      }
      const prepared = await importBackup(picked, work)
      if (cancelled || !contents || contents.isDestroyed()) return 'cancelled'
      const confirmed = await new Promise<boolean>((resolve, reject) => {
        const requestId = randomUUID()
        pendingConfirmation = { requestId, resolve }
        try {
          contents.send('backup:import-confirmation', {
            requestId,
            appVersion: prepared.manifest.appVersion,
            createdAt: prepared.manifest.createdAt,
          })
        } catch (error) {
          pendingConfirmation = undefined
          reject(error)
        }
      })
      if (!confirmed) return 'cancelled'
      await pause()
      stageRestore(paths, prepared.directory)
      restarting = true
      return 'restarting'
    } catch (error) {
      if (error instanceof AppServiceError) throw error
      throw new AppServiceError(
        'BACKUP_FAILED',
        english()
          ? 'Backup operation failed. Current data has been preserved; check free disk space and file access.'
          : '备份操作失败，当前数据已保留；请检查磁盘空间、文件权限或是否正在更新',
        undefined,
        { cause: error },
      )
    } finally {
      contents?.removeListener('destroyed', cancelConfirmation)
      contents?.removeListener('render-process-gone', cancelConfirmation)
      contents?.removeListener('did-start-navigation', cancelConfirmation)
      pendingConfirmation = undefined
      try {
        if (work)
          await fs
            .rm(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
            .catch((error) => {
              // Startup retries cleanup; do not report a committed export/import as failed.
              captureError(error, { operation: 'backup.temp-cleanup' })
            })
      } finally {
        if (frozen && !restarting) {
          // A committed staging journal must remain frozen until startup handles it.
          const pendingRestore = await fs
            .stat(restoreDirectory(paths.root))
            .catch((error: NodeJS.ErrnoException) => {
              if (error.code === 'ENOENT') return null
              throw error
            })
          if (!pendingRestore) {
            await fs.rm(freeze, { force: true })
            await fs.rm(backupSessionPath(paths.root), { force: true })
            agent.resumeAfterUpdate()
          }
        }
        busy = false
        if (restarting) setTimeout(restart, 150)
      }
    }
  }
  registerChannel('backup:export', () => run('export') as Promise<'cancelled' | 'exported'>)
  registerChannel('backup:import', () => run('import') as Promise<'cancelled' | 'restarting'>)
}
