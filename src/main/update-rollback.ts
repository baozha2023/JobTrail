import crypto from 'crypto'
import { createReadStream } from 'fs'
import fs from 'fs/promises'
import path from 'path'
import semver from 'semver'

const ROLLBACK_FORMAT = 'jobtrail-rollback-state'
const ROLLBACK_PACKAGE_FORMAT = 'jobtrail-rollback-package'
const FULL_PACKAGE_SUFFIX = '-full.nupkg'

interface RollbackStateDocument {
  format: typeof ROLLBACK_FORMAT
  sourceVersion: string
  targetVersion: string
  packageFile: string
  packageSha256: string
  createdAt: string
}

interface RollbackPackageDocument {
  format: typeof ROLLBACK_PACKAGE_FORMAT
  sourceVersion: string
  targetVersion: string
  packageFile: string
  packageSha256: string
  createdAt: string
}

let rollbackMutation: Promise<unknown> | null = null

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isIsoDate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  )
}

function parseRollbackPackage(value: unknown): RollbackPackageDocument {
  if (!isPlainObject(value)) throw new Error('rollback_package_manifest_invalid')
  const keys = Object.keys(value).sort()
  const expectedKeys = [
    'createdAt',
    'format',
    'packageFile',
    'packageSha256',
    'sourceVersion',
    'targetVersion',
  ]
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index]) ||
    value.format !== ROLLBACK_PACKAGE_FORMAT ||
    typeof value.sourceVersion !== 'string' ||
    typeof value.targetVersion !== 'string' ||
    !semver.valid(value.sourceVersion) ||
    !semver.valid(value.targetVersion) ||
    !semver.lt(value.sourceVersion, value.targetVersion) ||
    typeof value.packageFile !== 'string' ||
    path.basename(value.packageFile) !== value.packageFile ||
    !value.packageFile.toLocaleLowerCase('en-US').endsWith(FULL_PACKAGE_SUFFIX) ||
    typeof value.packageSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.packageSha256) ||
    !isIsoDate(value.createdAt)
  ) {
    throw new Error('rollback_package_manifest_invalid')
  }
  return value as unknown as RollbackPackageDocument
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, 'utf8')
  await fs.rename(temporary, filePath)
}

async function copyDirectoryStrict(
  source: string,
  target: string,
  skipDatabase = false,
): Promise<void> {
  const sourceStat = await fs.lstat(source)
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error('rollback_snapshot_source_invalid')
  }
  await fs.mkdir(target, { recursive: true })
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const sourceEntry = path.join(source, entry.name)
    const targetEntry = path.join(target, entry.name)
    if (entry.isSymbolicLink()) throw new Error('rollback_snapshot_link_rejected')
    if (skipDatabase && ['zhiji.db', 'zhiji.db-wal', 'zhiji.db-shm'].includes(entry.name)) {
      if (!entry.isFile()) throw new Error('rollback_snapshot_database_invalid')
      continue
    }
    if (entry.isDirectory()) {
      await copyDirectoryStrict(sourceEntry, targetEntry)
    } else if (entry.isFile()) {
      await fs.copyFile(sourceEntry, targetEntry)
    } else {
      throw new Error('rollback_snapshot_special_file_rejected')
    }
  }
}

async function validateDirectoryStrict(source: string): Promise<void> {
  const sourceStat = await fs.lstat(source)
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error('rollback_snapshot_source_invalid')
  }
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('rollback_snapshot_link_rejected')
    const sourceEntry = path.join(source, entry.name)
    if (entry.isDirectory()) await validateDirectoryStrict(sourceEntry)
    else if (!entry.isFile()) throw new Error('rollback_snapshot_special_file_rejected')
  }
}

async function replaceDirectoryTransactional(
  temporaryRoot: string,
  finalRoot: string,
): Promise<void> {
  const previousRoot = `${finalRoot}.previous-${crypto.randomUUID()}`
  const hadPrevious = Boolean(await fs.lstat(finalRoot).catch(() => null))
  if (hadPrevious) await fs.rename(finalRoot, previousRoot)
  try {
    await fs.rename(temporaryRoot, finalRoot)
  } catch (error) {
    if (hadPrevious) await fs.rename(previousRoot, finalRoot).catch(() => undefined)
    throw error
  }
  if (hadPrevious) {
    await fs.rm(previousRoot, { recursive: true, force: true })
  }
}

export async function sha256File(filePath: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('error', reject)
    stream.once('end', () => resolve(hash.digest('hex')))
  })
}

export function getRollbackRoot(dataRoot: string): string {
  return path.join(dataRoot, '.runtime', 'rollback')
}

function getRollbackPackageRoot(dataRoot: string): string {
  return path.join(dataRoot, '.runtime', 'rollback-package')
}

async function recoverDirectoryTransaction(dataRoot: string, directoryName: string): Promise<void> {
  const runtimeRoot = path.join(dataRoot, '.runtime')
  const finalRoot = path.join(runtimeRoot, directoryName)
  const entries = await fs.readdir(runtimeRoot, { withFileTypes: true })
  const previousRoots: string[] = []
  const temporaryRoots: string[] = []
  for (const entry of entries) {
    if (
      !entry.name.startsWith(`${directoryName}.previous-`) &&
      !entry.name.startsWith(`${directoryName}.tmp-`)
    ) {
      continue
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error('rollback_transaction_artifact_invalid')
    }
    const entryPath = path.join(runtimeRoot, entry.name)
    if (entry.name.startsWith(`${directoryName}.previous-`)) previousRoots.push(entryPath)
    else temporaryRoots.push(entryPath)
  }

  const finalExists = Boolean(await fs.lstat(finalRoot).catch(() => null))
  if (!finalExists && previousRoots.length === 1) {
    await fs.rename(previousRoots.pop()!, finalRoot)
  } else if (!finalExists && previousRoots.length > 1) {
    throw new Error('rollback_transaction_ambiguous')
  }
  for (const staleRoot of [...previousRoots, ...temporaryRoots]) {
    await fs.rm(staleRoot, { recursive: true, force: true })
  }
}

async function recoverRollbackTransaction(dataRoot: string): Promise<void> {
  await recoverDirectoryTransaction(dataRoot, 'rollback')
}

async function findInstalledFullPackage(dataRoot: string, sourceVersion: string): Promise<string> {
  const packagesRoot = path.join(dataRoot, '.runtime', 'packages')
  await validateDirectoryStrict(packagesRoot)
  const versionMarker = `-${sourceVersion.toLocaleLowerCase('en-US')}-`
  const candidates = (await fs.readdir(packagesRoot, { withFileTypes: true }))
    .filter(
      (entry) =>
        entry.isFile() &&
        !entry.isSymbolicLink() &&
        entry.name.toLocaleLowerCase('en-US').includes(versionMarker) &&
        entry.name.toLocaleLowerCase('en-US').endsWith(FULL_PACKAGE_SUFFIX),
    )
    .map((entry) => path.join(packagesRoot, entry.name))
  if (candidates.length !== 1) {
    throw new Error(`update_rollback_package_not_unique:${candidates.length}`)
  }
  return candidates[0]
}

async function loadPreservedRollbackPackage(options: {
  dataRoot: string
  sourceVersion: string
  targetVersion: string
}): Promise<{ path: string; state: RollbackPackageDocument }> {
  const { dataRoot, sourceVersion, targetVersion } = options
  await recoverDirectoryTransaction(dataRoot, 'rollback-package')
  const packageRoot = getRollbackPackageRoot(dataRoot)
  const manifestPath = path.join(packageRoot, 'package-state.json')
  const manifestStat = await fs.lstat(manifestPath)
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    throw new Error('rollback_package_manifest_invalid')
  }
  const state = parseRollbackPackage(JSON.parse(await fs.readFile(manifestPath, 'utf8')) as unknown)
  if (state.sourceVersion !== sourceVersion || state.targetVersion !== targetVersion) {
    throw new Error('rollback_package_version_mismatch')
  }
  const packagePath = path.join(packageRoot, state.packageFile)
  const packageStat = await fs.lstat(packagePath)
  if (
    !packageStat.isFile() ||
    packageStat.isSymbolicLink() ||
    (await sha256File(packagePath)) !== state.packageSha256
  ) {
    throw new Error('rollback_package_invalid')
  }
  return { path: packagePath, state }
}

async function buildPreservedRollbackPackage(options: {
  dataRoot: string
  sourceVersion: string
  targetVersion: string
}): Promise<RollbackPackageDocument> {
  const { dataRoot, sourceVersion, targetVersion } = options
  if (
    !semver.valid(sourceVersion) ||
    !semver.valid(targetVersion) ||
    !semver.lt(sourceVersion, targetVersion)
  ) {
    throw new Error('rollback_version_invalid')
  }
  await recoverDirectoryTransaction(dataRoot, 'rollback-package')
  const sourcePackage = await findInstalledFullPackage(dataRoot, sourceVersion)
  const finalRoot = getRollbackPackageRoot(dataRoot)
  const temporaryRoot = `${finalRoot}.tmp-${crypto.randomUUID()}`
  await fs.mkdir(temporaryRoot, { recursive: true })
  try {
    const packageFile = path.basename(sourcePackage)
    const packageTarget = path.join(temporaryRoot, packageFile)
    await fs.copyFile(sourcePackage, packageTarget)
    const state: RollbackPackageDocument = {
      format: ROLLBACK_PACKAGE_FORMAT,
      sourceVersion,
      targetVersion,
      packageFile,
      packageSha256: await sha256File(packageTarget),
      createdAt: new Date().toISOString(),
    }
    await writeJsonAtomic(path.join(temporaryRoot, 'package-state.json'), state)
    await replaceDirectoryTransactional(temporaryRoot, finalRoot)
    return state
  } catch (error) {
    await fs.rm(temporaryRoot, { recursive: true, force: true })
    throw error
  }
}

export async function preserveRollbackPackage(options: {
  dataRoot: string
  sourceVersion: string
  targetVersion: string
}): Promise<void> {
  if (rollbackMutation) throw new Error('rollback_mutation_active')
  const active = buildPreservedRollbackPackage(options)
  rollbackMutation = active
  try {
    await active
  } finally {
    if (rollbackMutation === active) rollbackMutation = null
  }
}

async function buildRollbackPoint(options: {
  dataRoot: string
  sourceVersion: string
  targetVersion: string
  snapshotDatabase: (destination: string) => Promise<void>
}): Promise<RollbackStateDocument> {
  const { dataRoot, sourceVersion, targetVersion, snapshotDatabase } = options
  if (
    !semver.valid(sourceVersion) ||
    !semver.valid(targetVersion) ||
    !semver.lt(sourceVersion, targetVersion)
  ) {
    throw new Error('rollback_version_invalid')
  }
  await recoverRollbackTransaction(dataRoot)
  const packageSource = (await loadPreservedRollbackPackage(options)).path

  const configPath = path.join(dataRoot, 'config.json')
  const configStat = await fs.lstat(configPath)
  if (!configStat.isFile() || configStat.isSymbolicLink()) {
    throw new Error('rollback_config_invalid')
  }

  const finalRoot = getRollbackRoot(dataRoot)
  const temporaryRoot = `${finalRoot}.tmp-${crypto.randomUUID()}`
  await fs.mkdir(temporaryRoot, { recursive: true })
  try {
    const packageFile = path.basename(packageSource)
    const packageTarget = path.join(temporaryRoot, packageFile)
    await fs.copyFile(packageSource, packageTarget)
    await fs.copyFile(configPath, path.join(temporaryRoot, 'config.json'))
    const snapshotData = path.join(temporaryRoot, 'data')
    await copyDirectoryStrict(path.join(dataRoot, 'data'), snapshotData, true)
    await snapshotDatabase(path.join(snapshotData, 'zhiji.db'))
    const snapshotStat = await fs.lstat(path.join(snapshotData, 'zhiji.db'))
    if (!snapshotStat.isFile() || snapshotStat.isSymbolicLink())
      throw new Error('rollback_snapshot_database_invalid')
    const state: RollbackStateDocument = {
      format: ROLLBACK_FORMAT,
      sourceVersion,
      targetVersion,
      packageFile,
      packageSha256: await sha256File(packageTarget),
      createdAt: new Date().toISOString(),
    }
    await writeJsonAtomic(path.join(temporaryRoot, 'rollback-state.json'), state)
    await replaceDirectoryTransactional(temporaryRoot, finalRoot)
    await fs.rm(getRollbackPackageRoot(dataRoot), {
      recursive: true,
      force: true,
    })
    return state
  } catch (error) {
    await fs.rm(temporaryRoot, { recursive: true, force: true })
    throw error
  }
}

export async function createRollbackPoint(options: {
  dataRoot: string
  sourceVersion: string
  targetVersion: string
  snapshotDatabase: (destination: string) => Promise<void>
}): Promise<RollbackStateDocument> {
  if (rollbackMutation) throw new Error('rollback_mutation_active')
  const active = buildRollbackPoint(options)
  rollbackMutation = active
  try {
    return await active
  } finally {
    if (rollbackMutation === active) rollbackMutation = null
  }
}
