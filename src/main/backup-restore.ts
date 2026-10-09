import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import type { AppPaths } from './config'
import { updateFreezePath } from './update-freeze'
import { validateDatabaseVersion } from './persistence/validation'

const NAMES = ['config.json', 'data', 'resumes', 'chat-uploads'] as const
type RestoreJournal = { phase: 'prepared' | 'applying' | 'committed'; existed: string[] }

export function restoreDirectory(root: string): string {
  return path.join(root, '.runtime', 'data-restore')
}

export function backupSessionPath(root: string): string {
  return path.join(root, '.runtime', 'state', 'backup-session.json')
}

export function recoverBackupWork(paths: AppPaths): void {
  assertRestoreParents(paths.root)
  const runtime = path.join(paths.root, '.runtime')
  if (!fs.existsSync(runtime)) return
  const session = backupSessionPath(paths.root)
  if (fs.existsSync(session)) {
    assertTree(session)
    const value = JSON.parse(fs.readFileSync(session, 'utf8')) as { pid: number }
    if (!Number.isSafeInteger(value.pid) || value.pid <= 0)
      throw new Error('Invalid backup session')
    let alive = true
    try {
      process.kill(value.pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false
      else throw error
    }
    if (alive) throw new Error('Backup process is still running')
    if (fs.existsSync(path.join(runtime, 'state', 'pending-update.json')))
      throw new Error('Update and backup state conflict')
    fs.rmSync(updateFreezePath(paths.root), { force: true })
    fs.rmSync(session)
  }
  for (const entry of fs.readdirSync(runtime)) {
    if (!/^backup-work-[a-zA-Z0-9]+$/.test(entry)) continue
    const target = path.join(runtime, entry)
    assertTree(target)
    fs.rmSync(target, { recursive: true, force: true })
  }
}

function assertTree(target: string): void {
  const stat = fs.lstatSync(target)
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
    throw new Error('Unsafe restore path')
  if (stat.isDirectory())
    for (const entry of fs.readdirSync(target)) assertTree(path.join(target, entry))
}

function writeJournal(root: string, value: RestoreJournal): void {
  const file = path.join(root, 'journal.json')
  const temporary = file + '.' + randomUUID()
  fs.writeFileSync(temporary, JSON.stringify(value), { flag: 'wx' })
  fs.renameSync(temporary, file)
}

function assertRestoreParents(root: string): void {
  for (const directory of [
    root,
    path.join(root, '.runtime'),
    path.join(root, '.runtime', 'state'),
  ]) {
    if (!fs.existsSync(directory)) continue
    const stat = fs.lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe restore parent')
  }
}

export function stageRestore(paths: AppPaths, incoming: string): void {
  assertRestoreParents(paths.root)
  const restore = restoreDirectory(paths.root)
  if (fs.existsSync(restore)) throw new Error('Another restore is pending')
  assertTree(incoming)
  for (const name of NAMES) {
    assertTree(path.join(incoming, name))
    if (fs.existsSync(path.join(paths.root, name))) assertTree(path.join(paths.root, name))
  }
  fs.mkdirSync(restore)
  try {
    fs.mkdirSync(path.join(restore, 'previous'))
    fs.renameSync(incoming, path.join(restore, 'incoming'))
    writeJournal(restore, {
      phase: 'prepared',
      existed: NAMES.filter((name) => fs.existsSync(path.join(paths.root, name))),
    })
  } catch (error) {
    fs.rmSync(restore, { recursive: true, force: true })
    throw error
  }
}

// Runs before ConfigService/SQLite are opened. Interrupted replacement rolls back as a set.
export function recoverRestore(paths: AppPaths): void {
  assertRestoreParents(paths.root)
  const restore = restoreDirectory(paths.root)
  if (!fs.existsSync(restore)) return
  assertTree(restore)
  const journalPath = path.join(restore, 'journal.json')
  if (!fs.existsSync(journalPath)) {
    // A crash while staging cannot have replaced live data yet.
    fs.rmSync(restore, { recursive: true, force: true })
    fs.rmSync(updateFreezePath(paths.root), { force: true })
    return
  }
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as RestoreJournal
  if (
    !['prepared', 'applying', 'committed'].includes(journal.phase) ||
    !Array.isArray(journal.existed) ||
    journal.existed.some((name) => !NAMES.includes(name as (typeof NAMES)[number]))
  )
    throw new Error('Invalid restore journal')
  const rollback = () => {
    for (const name of NAMES) {
      const current = path.join(paths.root, name)
      const previous = path.join(restore, 'previous', name)
      const incoming = path.join(restore, 'incoming', name)
      if (fs.existsSync(previous)) {
        if (fs.existsSync(current)) {
          assertTree(current)
          fs.rmSync(current, { recursive: true, force: true })
        }
        fs.renameSync(previous, current)
      } else if (!journal.existed.includes(name) && !fs.existsSync(incoming)) {
        if (fs.existsSync(current)) {
          assertTree(current)
          fs.rmSync(current, { recursive: true, force: true })
        }
      }
    }
  }
  if (journal.phase === 'applying') rollback()
  else if (journal.phase === 'prepared') {
    writeJournal(restore, { ...journal, phase: 'applying' })
    try {
      for (const name of NAMES) {
        const current = path.join(paths.root, name)
        if (fs.existsSync(current)) {
          assertTree(current)
          fs.renameSync(current, path.join(restore, 'previous', name))
        }
        fs.renameSync(path.join(restore, 'incoming', name), current)
      }
      writeJournal(restore, { ...journal, phase: 'committed' })
    } catch (error) {
      rollback()
      throw error
    }
  }
  // Imported account metadata is not evidence about this installation's Chromium
  // sessions. Do this before removing the committed journal so crash recovery
  // repeats the invalidation. A rolled-back restore preserves local evidence.
  if (journal.phase !== 'applying') {
    const db = new Database(paths.database, { fileMustExist: true })
    try {
      const version = db.pragma('user_version', { simple: true }) as number
      validateDatabaseVersion(db, version)
      // A pending restore from a released v1/v2/v3 client is validated in its
      // source version, then upgraded by ensurePersistenceReady. V4 is exact.
      if (version === 4) db.exec('DELETE FROM discovery_platforms')
    } finally {
      db.close()
    }
  }
  fs.rmSync(restore, { recursive: true, force: true })
  fs.rmSync(updateFreezePath(paths.root), { force: true })
}
