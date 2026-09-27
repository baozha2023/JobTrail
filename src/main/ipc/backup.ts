import { app, dialog } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AppPaths, ConfigService } from '../config'
import type { DatabaseManager } from '../database'
import type { AgentService } from '../agent/service'
import { exportBackup, importBackup } from '../backup-archive'
import { stageRestore, restoreDirectory, backupSessionPath } from '../backup-restore'
import { waitForMcpSessions, updateFreezePath } from '../update-freeze'
import { AppServiceError } from '../services/errors'
import { registerChannel } from './register-channel'

export function registerBackupIpc(
  paths: AppPaths,
  database: DatabaseManager,
  config: ConfigService,
  agent: AgentService,
  restart: () => void,
): void {
  let busy = false
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
    const freeze = updateFreezePath(paths.root)
    const pause = async () => {
      await fs.writeFile(backupSessionPath(paths.root), JSON.stringify({ pid: process.pid }), {
        flag: 'wx',
      })
      try {
        await fs.writeFile(freeze, '', { flag: 'wx' })
        frozen = true
      } catch (error) {
        await fs.rm(backupSessionPath(paths.root), { force: true })
        throw error
      }
      await agent.suspendForUpdate()
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
      const confirmation = await dialog.showMessageBox({
        type: 'warning',
        title: english() ? 'Replace all personal data?' : '确认替换全部个人数据？',
        message: english()
          ? 'Import will replace all current records, configuration, resumes and chat attachments, then restart the application.'
          : '导入将替换当前全部记录、配置、简历和对话附件，并重新启动应用。',
        detail: `${english() ? 'Backup' : '备份'}: ${prepared.manifest.appVersion} · ${prepared.manifest.createdAt}\n${english() ? 'Export your current data first if you want to keep it.' : '如需保留当前数据，请先取消并导出备份。'}`,
        buttons: english() ? ['Cancel', 'Replace and restart'] : ['取消', '替换并重启'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      })
      if (confirmation.response !== 1) return 'cancelled'
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
      )
    } finally {
      try {
        if (work)
          await fs
            .rm(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
            .catch(() => {
              // Startup retries cleanup; do not report a committed export/import as failed.
              console.error('Backup temporary cleanup deferred until next startup')
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
