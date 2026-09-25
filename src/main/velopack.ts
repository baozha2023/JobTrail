import { app } from 'electron'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { UpdateManager } from 'velopack'
import { getStorageRoot } from './config'
import { ROOT_UNINSTALLER } from './installation-paths'
import { registerChannel } from './ipc/register-channel'
import { AppServiceError } from './services/errors'
import { DesktopUpdateService } from './update-service'
import type { DatabaseManager } from './database'
import { createRollbackPoint, preserveRollbackPackage } from './update-rollback'
import { mcpSessionDirectory, updateFreezePath } from './update-freeze'

export const UPDATE_FEED_URL = 'https://github.com/baozha2023/JobTrail/releases/latest/download'

async function waitForMcpSessions(root: string): Promise<void> {
  const directory = mcpSessionDirectory(root)
  const deadline = Date.now() + 15_000
  for (;;) {
    const entries = await fsp.readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    let active = false
    for (const entry of entries) {
      const match = /^(\d+)-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.exec(entry)
      if (!match) throw new Error('mcp_session_lease_invalid')
      const pid = Number(match[1])
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('mcp_session_lease_invalid')
      const file = path.join(directory, entry)
      const stat = await fsp.lstat(file).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (!stat) continue
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('mcp_session_lease_invalid')
      try {
        process.kill(pid, 0)
        active = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') await fsp.rm(file, { force: true })
        else active = true
      }
    }
    if (!active) return
    if (Date.now() >= deadline) throw new Error('mcp_sessions_did_not_close')
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

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
}

export function registerVelopackIpc(database: DatabaseManager): void {
  let service: DesktopUpdateService | undefined
  let closing = false
  let healthCommit: Promise<void> | undefined
  const getService = () => {
    if (closing) throw new AppServiceError('VALIDATION_ERROR', '应用正在退出')
    if (
      !app.isPackaged ||
      process.platform !== 'win32' ||
      !fs.existsSync(path.join(getStorageRoot(), '.jobtrail-root'))
    ) {
      throw new AppServiceError('VALIDATION_ERROR', '请使用已安装的 Windows 版本检查更新')
    }
    return (service ??= new DesktopUpdateService(new UpdateManager(UPDATE_FEED_URL), {
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
          await waitForMcpSessions(dataRoot)
          // Wait for writes that began before the freeze. New UnitOfWork writes
          // check the marker inside their IMMEDIATE transaction.
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
          await fsp.rm(pendingPath, { force: true })
          await fsp.rm(freezePath, { force: true })
          throw error
        }
      },
      cancelPrepare: async () => {
        const dataRoot = getStorageRoot()
        await fsp.rm(path.join(dataRoot, '.runtime', 'state', 'pending-update.json'), {
          force: true,
        })
        await fsp.rm(updateFreezePath(dataRoot), { force: true })
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
  registerChannel('velopack:download-update', () => getService().download())
  registerChannel('velopack:apply-update', async () => {
    await getService().apply()
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
