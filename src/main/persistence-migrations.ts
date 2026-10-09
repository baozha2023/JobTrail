import { runOperation } from './diagnostics'
import { ExamRepository } from './repositories/exam-repository'
import { DiscoveryRepository } from './discovery/repository'
import { CONFIG_V1_SCHEMA } from './persistence/config-v1'
import { validateDatabaseVersion } from './persistence/validation'
export { validateDatabaseVersion } from './persistence/validation'
import { recoverRestore, recoverBackupWork } from './backup-restore'
import { AppServiceError } from './services/errors'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { ConfigLoadError, ConfigService, validateConfig, type AppPaths } from './config'
import { decryptConfig, encryptConfig } from './config-crypto'
import { MIGRATE_V1_V2 } from './persistence/schema-v2'
import { MIGRATE_V3_V4 } from './persistence/schema-v4'
import { MIGRATE_V2_V3 } from './persistence/schema-v3'
import { TARGET_CONFIG_VERSION, TARGET_DATABASE_VERSION } from './persistence/versions'
import { updateFreezePath, waitForMcpSessions } from './update-freeze'
import { DatabaseManager, DatabaseVersionError } from './database'

export { TARGET_CONFIG_VERSION, TARGET_DATABASE_VERSION }
type Db = InstanceType<typeof Database>
export interface MigrationStep<T> {
  from: number
  to: number
  apply: (value: T) => T
}
export const DATABASE_MIGRATIONS: MigrationStep<Db>[] = [
  {
    from: 1,
    to: 2,
    apply: (db) => {
      validateDatabaseVersion(db, 1)
      db.exec(MIGRATE_V1_V2)
      return db
    },
  },
  {
    from: 2,
    to: 3,
    apply: (db) => {
      validateDatabaseVersion(db, 2)
      db.exec(MIGRATE_V2_V3)
      return db
    },
  },
  {
    from: 3,
    to: 4,
    apply: (db) => {
      validateDatabaseVersion(db, 3)
      db.exec(MIGRATE_V3_V4)
      return db
    },
  },
]
export const CONFIG_MIGRATIONS: MigrationStep<unknown>[] = []

export function migrationChain<T>(
  from: number,
  to: number,
  steps: MigrationStep<T>[],
): MigrationStep<T>[] {
  if (!Number.isInteger(from) || from < 1 || from > to)
    throw new AppServiceError('PERSISTENCE_UNSUPPORTED', 'Unsupported persistent version')
  const result: MigrationStep<T>[] = []
  while (from < to) {
    const candidates = steps.filter((step) => step.from === from)
    if (candidates.length !== 1 || candidates[0].to !== from + 1)
      throw new AppServiceError('PERSISTENCE_UNSUPPORTED', 'Missing or ambiguous migration step')
    result.push(candidates[0])
    from++
  }
  return result
}

export function planPersistenceUpgrade(
  databaseVersion: number,
  configVersion: number,
): { database: MigrationStep<Db>[]; config: MigrationStep<unknown>[] } {
  return {
    database: migrationChain(databaseVersion, TARGET_DATABASE_VERSION, DATABASE_MIGRATIONS),
    config: migrationChain(configVersion, TARGET_CONFIG_VERSION, CONFIG_MIGRATIONS),
  }
}

export function validateConfigVersion(value: unknown, version: number) {
  if (
    version !== 1 ||
    !value ||
    typeof value !== 'object' ||
    !('configVersion' in value) ||
    value.configVersion !== version
  )
    throw new AppServiceError('PERSISTENCE_UNSUPPORTED', 'Unsupported configuration version')
  const parsed = CONFIG_V1_SCHEMA.safeParse(value)
  if (!parsed.success)
    throw new AppServiceError('PERSISTENCE_INVALID', 'Invalid source configuration')
  return parsed.data
}

// The caller supplies an isolated database; never mutate an imported archive or live database.
export function preparePersistenceUpgrade(databaseFile: string, configuration: unknown) {
  const configVersion = (configuration as { configVersion?: number })?.configVersion
  if (typeof configVersion !== 'number') throw new Error('Invalid configuration version')
  let config: unknown = validateConfigVersion(configuration, configVersion)
  const db = new Database(databaseFile, { fileMustExist: true })
  try {
    const version = db.pragma('user_version', { simple: true }) as number
    const plan = planPersistenceUpgrade(version, configVersion)
    validateDatabaseVersion(db, version)
    db.transaction(() => {
      for (const step of plan.database) {
        step.apply(db)
        db.pragma(`user_version = ${step.to}`)
        validateDatabaseVersion(db, step.to)
      }
      for (const step of plan.config) config = validateConfigVersion(step.apply(config), step.to)
      validateConfig(config)
    }).immediate()
    db.pragma('wal_checkpoint(TRUNCATE)')
    return { databaseFile, config: validateConfig(config) }
  } finally {
    db.close()
  }
}

function readConfiguration(file: string): unknown {
  try {
    return decryptConfig(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    throw new ConfigLoadError('CONFIG_INVALID', { cause: error })
  }
}
function recoverRuntime(paths: AppPaths): void {
  const db = new Database(paths.database, { fileMustExist: true })
  try {
    db.transaction(() => {
      new ExamRepository(db).interrupt()
      new DiscoveryRepository(db).resetRuntime()
    }).immediate()
  } finally {
    db.close()
  }
}
function safeDirectory(directory: string): void {
  if (
    fs.existsSync(directory) &&
    (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink())
  )
    throw new Error('Unsafe migration directory')
  fs.mkdirSync(directory, { recursive: true })
}

// Fixed names only: journal contents never become filesystem paths.
function recoverMigration(paths: AppPaths, work: string): void {
  const journal = path.join(work, 'journal.json')
  if (!fs.existsSync(journal)) return
  const { phase } = JSON.parse(fs.readFileSync(journal, 'utf8')) as { phase: string }
  if (!['prepared', 'applying', 'committed'].includes(phase))
    throw new Error('Invalid migration journal')
  if (phase === 'applying') {
    fs.copyFileSync(path.join(work, 'previous.db'), paths.database)
    fs.copyFileSync(path.join(work, 'previous.config'), paths.config)
    for (const suffix of ['-wal', '-shm']) fs.rmSync(paths.database + suffix, { force: true })
  }
  if (phase === 'committed') {
    const db = new Database(paths.database, { readonly: true, fileMustExist: true })
    try {
      validateDatabaseVersion(db, TARGET_DATABASE_VERSION)
    } finally {
      db.close()
    }
    validateConfig(readConfiguration(paths.config))
  }
  fs.rmSync(journal)
}

export async function ensurePersistenceReady(paths: AppPaths, supervised = false): Promise<void> {
  try {
    await runOperation({ operation: 'persistence.initialize' }, () =>
      ensureReady(paths, supervised),
    )
  } catch (error) {
    if (
      error instanceof AppServiceError ||
      error instanceof DatabaseVersionError ||
      error instanceof ConfigLoadError
    )
      throw error
    throw new AppServiceError('PERSISTENCE_FAILED', 'Persistence upgrade failed', undefined, {
      cause: error,
    })
  }
}
async function ensureReady(paths: AppPaths, supervised: boolean): Promise<void> {
  safeDirectory(paths.root)
  const runtime = path.join(paths.root, '.runtime')
  safeDirectory(runtime)
  const work = path.join(runtime, 'persistence-upgrade')
  safeDirectory(work)
  safeDirectory(paths.data)
  for (const file of [
    paths.config,
    paths.database,
    ...[
      'owner.json',
      'journal.json',
      'journal.json.tmp',
      'previous.db',
      'previous.db-wal',
      'previous.db-shm',
      'previous.config',
      'next.db',
      'next.db-wal',
      'next.db-shm',
      'next.config',
    ].map((name) => path.join(work, name)),
  ]) {
    if (
      fs.existsSync(file) &&
      (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())
    )
      throw new AppServiceError('PERSISTENCE_INVALID', 'Unsafe persistent file')
  }
  const lock = path.join(work, 'owner.json')
  const freeze = updateFreezePath(paths.root)
  const borrowedFreeze = supervised && fs.existsSync(freeze)
  let recoveredOwner = false
  if (fs.existsSync(lock)) {
    const { pid } = JSON.parse(fs.readFileSync(lock, 'utf8')) as { pid: number }
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid migration owner')
    try {
      process.kill(pid, 0)
      throw new AppServiceError('PERSISTENCE_BUSY', 'Persistence upgrade is already running')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
    recoveredOwner = true
    fs.rmSync(lock)
  }
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }), { flag: 'wx' })
  let frozen = (recoveredOwner || borrowedFreeze) && fs.existsSync(freeze)
  try {
    if (frozen) await waitForMcpSessions(paths.root)
    recoverRestore(paths)
    recoverBackupWork(paths)
    frozen = frozen && fs.existsSync(freeze)
    if (fs.existsSync(freeze) && !frozen)
      throw new AppServiceError('PERSISTENCE_BUSY', 'Maintenance is active')
    recoverMigration(paths, work)
    if (!fs.existsSync(paths.database)) {
      if (!fs.existsSync(paths.config)) new ConfigService(paths)
      else validateConfig(readConfiguration(paths.config))
      new DatabaseManager(paths).close()
      return
    }
    if (!fs.existsSync(paths.config))
      throw new Error('Existing database is missing its configuration')
    const sourceConfig = readConfiguration(paths.config)
    const configuration = validateConfigVersion(
      sourceConfig,
      (sourceConfig as { configVersion: number }).configVersion,
    )
    let db = new Database(paths.database, { readonly: true, fileMustExist: true })
    let version: number
    try {
      version = db.pragma('user_version', { simple: true }) as number
      validateDatabaseVersion(db, version)
    } finally {
      db.close()
    }
    const plan = planPersistenceUpgrade(version, configuration.configVersion)
    if (!plan.database.length && !plan.config.length) {
      // No files or schema are replaced. Runtime recovery is one IMMEDIATE
      // transaction, so live MCP clients can remain connected when they start
      // the desktop for discovery. Actual migrations/restores still drain them.
      recoverRuntime(paths)
      return
    }
    safeDirectory(path.dirname(freeze))
    if (!frozen) {
      fs.writeFileSync(freeze, '', { flag: 'wx' })
      frozen = true
    }
    await waitForMcpSessions(paths.root)
    db = new Database(paths.database, { readonly: true, fileMustExist: true })
    try {
      await db.backup(path.join(work, 'previous.db'))
    } finally {
      db.close()
    }
    fs.copyFileSync(paths.config, path.join(work, 'previous.config'))
    const target = path.join(work, 'next.db')
    for (const suffix of ['-wal', '-shm']) fs.rmSync(target + suffix, { force: true })
    fs.copyFileSync(path.join(work, 'previous.db'), target)
    const prepared = preparePersistenceUpgrade(target, configuration)
    fs.writeFileSync(path.join(work, 'next.config'), encryptConfig(prepared.config))
    const journal = path.join(work, 'journal.json')
    const setPhase = (phase: string) => {
      fs.writeFileSync(journal + '.tmp', JSON.stringify({ phase }))
      fs.renameSync(journal + '.tmp', journal)
    }
    setPhase('prepared')
    setPhase('applying')
    try {
      for (const suffix of ['-wal', '-shm']) fs.rmSync(paths.database + suffix, { force: true })
      fs.copyFileSync(target, paths.database)
      fs.copyFileSync(path.join(work, 'next.config'), paths.config)
      setPhase('committed')
      recoverMigration(paths, work)
      recoverRuntime(paths)
    } catch (error) {
      recoverMigration(paths, work)
      throw error
    }
  } finally {
    // Keep the lease and freeze if recovery still needs to finish on the next launch.
    if (!fs.existsSync(path.join(work, 'journal.json'))) {
      if (frozen && !borrowedFreeze) fs.rmSync(freeze, { force: true })
      fs.rmSync(lock, { force: true })
    }
  }
}
