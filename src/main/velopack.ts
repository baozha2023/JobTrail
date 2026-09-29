import { app } from 'electron'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { UpdateManager } from 'velopack'
import { getStorageRoot } from './config'
import { ROOT_UNINSTALLER } from './installation-paths'
import { registerChannel, sendToTrustedWindow } from './ipc/register-channel'
import { AppServiceError } from './services/errors'
import { DesktopUpdateService, type UpdateProgressReporter } from './update-service'
import type { DatabaseManager } from './database'
import type { AgentCoordinator } from './agent/coordinator'
import { createRollbackPoint, preserveRollbackPackage } from './update-rollback'
import { waitForMcpSessions, updateFreezePath } from './update-freeze'
import { logFault, reportFault } from './diagnostics'

// Velopack detects GitHub sources and resolves release assets from the repository.
export const UPDATE_REPOSITORY_URL = 'https://github.com/baozha2023/JobTrail'

async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  const temporary = `${target}.tmp-${randomUUID()}`
  try {
    await fsp.writeFile(temporary, `${JSON.stringify(value)}\n`, 'utf8')
    await fsp.rename(temporary, target)
  } catch (error) {
    await fsp.rm(temporary, { force: true })
    throw error
  }
}

async function refreshRootUninstaller(root: string): Promise<void> {
  const source = path.join(process.resourcesPath, 'bootstrap', ROOT_UNINSTALLER)
  const target = path.join(root, ROOT_UNINSTALLER)
  const sourceStat = await fsp.lstat(source)
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error('更新包中的卸载程序无效')
  const targetStat = await fsp.lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (targetStat && (!targetStat.isFile() || targetStat.isSymbolicLink()))
    throw new Error('安装目录中的卸载程序无效')
  const sourceBytes = await fsp.readFile(source)
  const sourceHash = createHash('sha256').update(sourceBytes).digest('hex')
  const targetHash = targetStat
    ? createHash('sha256')
        .update(await fsp.readFile(target))
        .digest('hex')
    : ''
  if (sourceHash === targetHash) return
  const temporary = `${target}.tmp-${randomUUID()}`
  try {
    await fsp.writeFile(temporary, sourceBytes)
    if (
      createHash('sha256')
        .update(await fsp.readFile(temporary))
        .digest('hex') !== sourceHash
    )
      throw new Error('卸载程序更新校验失败')
    await fsp.rename(temporary, target)
  } catch (error) {
    await fsp.rm(temporary, { force: true })
    throw error
  }
}

export async function markApplicationHealthy(): Promise<void> {
  if (!app.isPackaged || process.platform !== 'win32') return
  const root = getStorageRoot()
  if (!fs.existsSync(path.join(root, '.jobtrail-root'))) return
  const stateRoot = path.join(root, '.runtime', 'state')
  await fsp.mkdir(stateRoot, { recursive: true })
  const health = {
    format: 'jobtrail-health',
    version: app.getVersion(),
    processId: process.pid,
    healthyAt: new Date().toISOString(),
  }
  await refreshRootUninstaller(root)
  await writeJsonAtomic(path.join(stateRoot, 'last-good.json'), health)
  const token = process.env.JOBTRAIL_LAUNCH_TOKEN
  if (token && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(token))
    await writeJsonAtomic(path.join(stateRoot, `healthy-${token}.json`), health)
  // The payload launcher is also the replacement worker. It only accepts its
  // fixed installed location, waits for the root executable to unlock, and
  // independently validates health/version/hash before touching the root file.
  const worker = path.join(process.resourcesPath, 'bootstrap', 'JobTrail.exe')
  const child = spawn(worker, ['--refresh-root'], {
    cwd: root,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.once('error', (error) => logFault('update.refresh-launcher', error))
  child.once('exit', (code) => {
    if (code !== 0)
      reportFault({ source: 'main', operation: 'update.refresh-launcher', code: 'PROCESS_EXITED' })
  })
  child.unref()
}

export function registerVelopackIpc(
  database: DatabaseManager,
  agent: Pick<AgentCoordinator, 'suspendForUpdate' | 'resumeAfterUpdate'>,
): void {
  let service: DesktopUpdateService | undefined
  let closing = false
  let healthCommit: Promise<void> | undefined
  const reportProgress =
    (attemptId: number): UpdateProgressReporter =>
    (progress) =>
      sendToTrustedWindow('velopack:progress', { attemptId, ...progress })
  const getService = () => {
    if (closing) throw new AppServiceError('VALIDATION_ERROR', '应用正在退出')
    if (
      !app.isPackaged ||
      process.platform !== 'win32' ||
      !fs.existsSync(path.join(getStorageRoot(), '.jobtrail-root'))
    ) {
      throw new AppServiceError('VALIDATION_ERROR', '请使用已安装的 Windows 版本检查更新')
    }
    return (service ??= new DesktopUpdateService(new UpdateManager(UPDATE_REPOSITORY_URL), {
      preserve: (targetVersion) =>
        preserveRollbackPackage({
          dataRoot: getStorageRoot(),
          sourceVersion: app.getVersion(),
          targetVersion,
        }),
      prepare: async (targetVersion) => {
        const dataRoot = getStorageRoot()
        const stateRoot = path.join(dataRoot, '.runtime', 'state')
        await fsp.mkdir(stateRoot, { recursive: true })
        const pendingPath = path.join(stateRoot, 'pending-update.json')
        if (fs.existsSync(pendingPath)) throw new Error('pending_update_already_exists')
        const freezePath = updateFreezePath(dataRoot)
        await fsp.writeFile(freezePath, '', { flag: 'wx' })
        try {
          await agent.suspendForUpdate()
          await waitForMcpSessions(dataRoot)
          // All built-in agent operations have drained; this waits for any
          // remaining business transaction that began before the freeze.
          database.db.transaction(() => undefined).immediate()
          await createRollbackPoint({
            dataRoot,
            sourceVersion: app.getVersion(),
            targetVersion,
            snapshotDatabase: (destination) => database.snapshotForUpdate(destination),
          })
          await writeJsonAtomic(pendingPath, {
            format: 'jobtrail-pending-update',
            sourceVersion: app.getVersion(),
            targetVersion,
            failureCount: 0,
            createdAt: new Date().toISOString(),
          })
        } catch (error) {
          logFault('update.prepare', error)
          try {
            await Promise.all([
              fsp.rm(pendingPath, { force: true }),
              fsp.rm(freezePath, { force: true }),
            ])
          } catch (cleanupError) {
            logFault('update.rollback', cleanupError)
            throw cleanupError
          } finally {
            agent.resumeAfterUpdate()
          }
          throw error
        }
      },
      cancelPrepare: async () => {
        const dataRoot = getStorageRoot()
        try {
          await Promise.all([
            fsp.rm(path.join(dataRoot, '.runtime', 'state', 'pending-update.json'), {
              force: true,
            }),
            fsp.rm(updateFreezePath(dataRoot), { force: true }),
          ])
        } finally {
          agent.resumeAfterUpdate()
        }
      },
    }))
  }
  registerChannel('velopack:get-version', () => app.getVersion())
  registerChannel('velopack:renderer-healthy', async () => {
    healthCommit ??= markApplicationHealthy().catch((error) => {
      healthCommit = undefined
      throw error
    })
    await healthCommit
    return true
  })
  registerChannel('velopack:check-for-update', () => getService().check())
  registerChannel('velopack:download-update', (attemptId) =>
    getService().download(reportProgress(attemptId)),
  )
  registerChannel('velopack:apply-update', async (attemptId) => {
    await getService().apply(reportProgress(attemptId))
    closing = true
    setImmediate(() => app.quit())
    return true
  })
  registerChannel('velopack:uninstall', async () => {
    if (!app.isPackaged) return 'development'
    if (process.platform !== 'win32') return 'unavailable'
    if (closing || service?.isBusy())
      throw new AppServiceError('VALIDATION_ERROR', '请等待更新操作完成后卸载')
    const uninstaller = path.join(getStorageRoot(), ROOT_UNINSTALLER)
    if (!fs.existsSync(uninstaller)) return 'unavailable'
    closing = true
    await new Promise<void>((resolve, reject) => {
      const child = spawn(uninstaller, ['--confirmed', '--wait-pid', String(process.pid)], {
        cwd: getStorageRoot(),
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      child.once('error', (error) => {
        closing = false
        reject(error)
      })
      child.once('spawn', () => {
        child.unref()
        resolve()
      })
    })
    setImmediate(() => app.quit())
    return 'started'
  })
}
