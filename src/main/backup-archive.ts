import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { Transform, type Readable } from 'node:stream'
import { ZipFile } from 'yazl'
import * as yauzl from 'yauzl'
import Database from 'better-sqlite3'
import { z } from 'zod'
import { configEncryptionKey, encryptConfig } from './config-crypto'
import { validateConfig, DEFAULT_CONFIG, type AppPaths, type ConfigService } from './config'
import { DB_SCHEMA_VERSION, DatabaseManager } from './database'
import { AppServiceError } from './services/errors'

const MAGIC = Buffer.from('JOBTRAIL-BACKUP-1\n')
const MAX_BYTES = 8 * 1024 ** 3
const MAX_FILES = 100_000
const MAX_METADATA_BYTES = 16 * 1024 ** 2
const manifestSchema = z
  .object({
    format: z.literal('jobtrail-backup'),
    backupVersion: z.literal(1),
    appVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    createdAt: z.string().datetime(),
    databaseVersion: z.number().int().positive(),
    configVersion: z.number().int().positive(),
    files: z
      .array(
        z
          .object({
            path: z.string(),
            size: z.number().int().nonnegative(),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .max(MAX_FILES),
  })
  .strict()
export type BackupManifest = z.infer<typeof manifestSchema>

function invalid(): AppServiceError {
  return new AppServiceError('BACKUP_INVALID', '备份损坏、密钥不匹配或包含不安全的文件')
}

export function allowedBackupPath(name: string): boolean {
  if (name === 'data/zhiji.db' || name === 'config.json') return true
  return /^(resumes|chat-uploads)\/(?:\.trash\/)?[a-f0-9-]{36,73}\.(pdf|doc|docx|txt|md|png|jpg|jpeg|webp)$/i.test(
    name,
  )
}

async function digest(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function collect(
  directory: string,
  prefix: string,
): Promise<Array<{ file: string; name: string }>> {
  const stat = await fsp.lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid()
  const files: Array<{ file: string; name: string }> = []
  for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw invalid()
    const file = path.join(directory, entry.name)
    const name = `${prefix}/${entry.name}`
    if (entry.isDirectory() && entry.name === '.trash') files.push(...(await collect(file, name)))
    else if (entry.isFile() && allowedBackupPath(name)) files.push({ file, name })
    else throw invalid()
  }
  return files
}

// Caller holds the maintenance freeze while the online snapshot and files are read.
export async function exportBackup(
  paths: AppPaths,
  database: DatabaseManager,
  config: ConfigService,
  appVersion: string,
  destination: string,
  work: string,
): Promise<BackupManifest> {
  const snapshot = path.join(work, 'snapshot.db')
  await database.snapshotForUpdate(snapshot)
  const configuration = config.reload()
  const configBytes = Buffer.from(JSON.stringify(configuration))
  const files = [
    { file: snapshot, name: 'data/zhiji.db' },
    ...(await collect(paths.resumes, 'resumes')),
    ...(await collect(paths.chatUploads, 'chat-uploads')),
  ]
  const manifest: BackupManifest = {
    format: 'jobtrail-backup',
    backupVersion: 1,
    appVersion,
    createdAt: new Date().toISOString(),
    databaseVersion: DB_SCHEMA_VERSION,
    configVersion: configuration.configVersion,
    files: [],
  }
  let total = configBytes.length
  for (const { file, name } of files) {
    const stat = await fsp.lstat(file)
    total += stat.size
    if (stat.isSymbolicLink() || !stat.isFile() || total > MAX_BYTES || files.length >= MAX_FILES)
      throw invalid()
    manifest.files.push({ path: name, size: stat.size, sha256: await digest(file) })
  }
  manifest.files.push({
    path: 'config.json',
    size: configBytes.length,
    sha256: createHash('sha256').update(configBytes).digest('hex'),
  })
  const manifestBytes = Buffer.from(JSON.stringify(manifest))
  try {
    // The manifest is also a ZIP entry and contributes to import limits.
    if (
      configBytes.length > MAX_METADATA_BYTES ||
      manifestBytes.length > MAX_METADATA_BYTES ||
      manifest.files.length + 1 > MAX_FILES ||
      total + manifestBytes.length > MAX_BYTES
    )
      throw invalid()
    manifestSchema.parse(manifest)
    validateSnapshot(
      snapshot,
      manifest.databaseVersion,
      new Set(manifest.files.map((item) => item.path.toLowerCase())),
      work,
    )
  } catch {
    throw new AppServiceError(
      'BACKUP_SOURCE_INVALID',
      '当前数据结构不受支持、文件缺失或超出备份限制，未生成备份',
    )
  }
  const zip = new ZipFile()
  zip.on('error', (error) => (zip.outputStream as Readable).destroy(error))
  const iv = randomBytes(12)
  const header = Buffer.concat([MAGIC, iv])
  const cipher = createCipheriv('aes-256-gcm', configEncryptionKey(), iv)
  cipher.setAAD(header)
  const temporary = destination + `.tmp-${randomBytes(8).toString('hex')}`
  try {
    await fsp.writeFile(temporary, header, { flag: 'wx', mode: 0o600 })
    const writing = pipeline(
      zip.outputStream,
      cipher,
      fs.createWriteStream(temporary, { flags: 'a' }),
    )
    for (const { file, name } of files) zip.addFile(file, name)
    zip.addBuffer(configBytes, 'config.json')
    zip.addBuffer(manifestBytes, 'manifest.json')
    zip.end()
    await writing
    await fsp.appendFile(temporary, cipher.getAuthTag())
    if ((await fsp.stat(temporary)).size > MAX_BYTES)
      throw new AppServiceError('BACKUP_SOURCE_INVALID', '备份超过文件大小限制，未生成备份')
    await fsp.rename(temporary, destination)
    return manifest
  } finally {
    await fsp.rm(temporary, { force: true })
  }
}

async function decryptBackup(source: string, target: string): Promise<void> {
  const stat = await fsp.lstat(source)
  const headerSize = MAGIC.length + 12
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < headerSize + 16 ||
    stat.size > MAX_BYTES
  )
    throw invalid()
  const handle = await fsp.open(source, 'r')
  const header = Buffer.alloc(headerSize)
  const tag = Buffer.alloc(16)
  try {
    await handle.read(header, 0, header.length, 0)
    await handle.read(tag, 0, 16, stat.size - 16)
  } finally {
    await handle.close()
  }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw invalid()
  const decipher = createDecipheriv(
    'aes-256-gcm',
    configEncryptionKey(),
    header.subarray(MAGIC.length),
  )
  decipher.setAAD(header)
  decipher.setAuthTag(tag)
  await pipeline(
    fs.createReadStream(source, { start: headerSize, end: stat.size - 17 }),
    decipher,
    fs.createWriteStream(target, { flags: 'wx', mode: 0o600 }),
  )
}

async function extract(zipPath: string, target: string): Promise<void> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.open(zipPath, { lazyEntries: true, strictFileNames: true }, (error, value) =>
      error ? reject(error) : resolve(value!),
    ),
  )
  const seen = new Set<string>()
  let total = 0
  await new Promise<void>((resolve, reject) => {
    const fail = (error: unknown) => {
      zip.close()
      reject(error)
    }
    zip.on('error', fail)
    zip.on('end', resolve)
    zip.on('entry', (entry: yauzl.Entry) => {
      void (async () => {
        const name = entry.fileName
        const mode = (entry.externalFileAttributes >>> 16) & 0xf000
        total += entry.uncompressedSize
        if (
          (name !== 'manifest.json' && !allowedBackupPath(name)) ||
          seen.has(name.toLowerCase()) ||
          seen.size >= MAX_FILES ||
          total > MAX_BYTES ||
          (mode !== 0 && mode !== 0x8000) ||
          entry.generalPurposeBitFlag & 1
        )
          throw invalid()
        if (
          (name === 'manifest.json' || name === 'config.json') &&
          entry.uncompressedSize > MAX_METADATA_BYTES
        )
          throw invalid()
        seen.add(name.toLowerCase())
        const file = path.join(target, ...name.split('/'))
        await fsp.mkdir(path.dirname(file), { recursive: true })
        const stream = await new Promise<NodeJS.ReadableStream>((yes, no) =>
          zip.openReadStream(entry, (error, input) => (error ? no(error) : yes(input!))),
        )
        let size = 0
        const bounded = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            size += chunk.length
            callback(size > entry.uncompressedSize ? invalid() : null, chunk)
          },
        })
        await pipeline(stream, bounded, fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }))
        if (size !== entry.uncompressedSize) throw invalid()
        zip.readEntry()
      })().catch(fail)
    })
    zip.readEntry()
  })
}

function validateSnapshot(
  databaseFile: string,
  databaseVersion: number,
  declared: Set<string>,
  work: string,
): void {
  const db = new Database(databaseFile, {
    readonly: true,
    fileMustExist: true,
  })
  try {
    if (
      db.pragma('user_version', { simple: true }) !== databaseVersion ||
      db.pragma('integrity_check', { simple: true }) !== 'ok'
    )
      throw invalid()
    // A matching user_version alone does not prove this is the formal schema.
    const expectedRoot = path.join(work, 'expected-schema')
    const expected = new DatabaseManager({
      root: expectedRoot,
      data: expectedRoot,
      database: path.join(expectedRoot, 'schema.db'),
      config: path.join(expectedRoot, 'config.json'),
      resumes: path.join(expectedRoot, 'resumes'),
      chatUploads: path.join(expectedRoot, 'chat-uploads'),
    })
    try {
      const schema = expected.db
        .prepare(
          "SELECT name, type, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'",
        )
        .all() as { name: string; type: string; sql: string }[]
      const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim()
      for (const item of schema) {
        const actual = db
          .prepare('SELECT type, sql FROM sqlite_master WHERE name = ?')
          .get(item.name) as { type: string; sql: string } | undefined
        if (!actual || actual.type !== item.type || normalize(actual.sql) !== normalize(item.sql))
          throw invalid()
      }
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('trigger', 'view') LIMIT 1").get())
        throw invalid()
    } finally {
      expected.close()
    }
    if (
      db
        .prepare(
          `SELECT 1 FROM industries i LEFT JOIN industries p ON p.id = i.parent_id
      WHERE i.parent_id IS NOT NULL AND (p.id IS NULL OR p.parent_id IS NOT NULL) LIMIT 1`,
        )
        .get() ||
      db
        .prepare(
          `SELECT 1 FROM company_industries ci LEFT JOIN industries i ON i.id = ci.industry_id
        LEFT JOIN companies c ON c.id = ci.company_id
        WHERE c.id IS NULL OR i.id IS NULL OR i.parent_id IS NULL LIMIT 1`,
        )
        .get() ||
      db
        .prepare(
          `SELECT 1 FROM companies c WHERE c.builtin_key IS NOT NULL AND NOT EXISTS
        (SELECT 1 FROM company_industries ci WHERE ci.company_id = c.id) LIMIT 1`,
        )
        .get()
    )
      throw invalid()
    const resumes = db.prepare('SELECT relative_path AS name FROM resume_versions').all() as {
      name: string
    }[]
    const attachments = db
      .prepare('SELECT relative_path AS name FROM chat_attachments WHERE deleting = 0')
      .all() as { name: string }[]
    for (const [prefix, rows] of [
      ['resumes', resumes],
      ['chat-uploads', attachments],
    ] as const) {
      for (const row of rows) {
        const name = `${prefix}/${row.name}`
        if (!allowedBackupPath(name) || !declared.has(name.toLowerCase())) throw invalid()
      }
    }
    if (
      (
        db
          .prepare('SELECT count(*) AS n FROM calendar_events WHERE reminder_minutes <= 0')
          .get() as { n: number }
      ).n
    )
      throw invalid()
  } finally {
    db.close()
  }
}

export async function importBackup(
  source: string,
  work: string,
): Promise<{ directory: string; manifest: BackupManifest }> {
  const zipPath = path.join(work, 'decrypted.zip')
  const directory = path.join(work, 'incoming')
  try {
    await decryptBackup(source, zipPath)
    await fsp.mkdir(directory)
    await extract(zipPath, directory)
    const manifest = manifestSchema.parse(
      JSON.parse(await fsp.readFile(path.join(directory, 'manifest.json'), 'utf8')),
    )
    // Client semver is informational. Only explicitly supported persistent formats can be restored.
    if (
      manifest.databaseVersion !== DB_SCHEMA_VERSION ||
      manifest.configVersion !== DEFAULT_CONFIG.configVersion
    )
      throw new AppServiceError(
        'BACKUP_VERSION_UNSUPPORTED',
        '备份的数据格式版本不受当前客户端支持，请使用支持该版本迁移的客户端',
      )
    const declared = new Set<string>()
    for (const item of manifest.files) {
      if (!allowedBackupPath(item.path) || declared.has(item.path.toLowerCase())) throw invalid()
      declared.add(item.path.toLowerCase())
      const file = path.join(directory, ...item.path.split('/'))
      if ((await fsp.stat(file)).size !== item.size || (await digest(file)) !== item.sha256)
        throw invalid()
    }
    if (!declared.has('data/zhiji.db') || !declared.has('config.json')) throw invalid()
    // Reject undeclared payloads, including files that happen to use valid names.
    const inventory = async (folder: string, prefix = ''): Promise<string[]> => {
      const result: string[] = []
      for (const entry of await fsp.readdir(folder, { withFileTypes: true })) {
        const name = prefix + entry.name
        if (entry.isDirectory())
          result.push(...(await inventory(path.join(folder, entry.name), name + '/')))
        else if (name !== 'manifest.json') result.push(name.toLowerCase())
      }
      return result
    }
    const actual = await inventory(directory)
    if (actual.length !== declared.size || actual.some((name) => !declared.has(name)))
      throw invalid()
    const configuration = validateConfig(
      JSON.parse(await fsp.readFile(path.join(directory, 'config.json'), 'utf8')),
    )
    validateSnapshot(
      path.join(directory, 'data', 'zhiji.db'),
      manifest.databaseVersion,
      declared,
      work,
    )
    // The portable configuration exists only inside the encrypted archive / temporary staging.
    await fsp.writeFile(path.join(directory, 'config.json'), encryptConfig(configuration))
    await fsp.rm(path.join(directory, 'manifest.json'))
    for (const folder of ['resumes', 'chat-uploads'])
      await fsp.mkdir(path.join(directory, folder), { recursive: true })
    return { directory, manifest }
  } catch (error) {
    if (error instanceof AppServiceError) throw error
    throw invalid()
  } finally {
    await fsp.rm(zipPath, { force: true })
  }
}
