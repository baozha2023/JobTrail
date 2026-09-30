import { preparePersistenceUpgrade } from '../src/main/persistence-migrations'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ZipFile } from 'yazl'
import * as yauzl from 'yauzl'
import { ConfigService, type AppPaths } from '../src/main/config'
import { createServiceContainer } from '../src/main/service-container'
import { configEncryptionKey, decryptConfig, encryptConfig } from '../src/main/config-crypto'
import { exportBackup, importBackup, allowedBackupPath } from '../src/main/backup-archive'
import {
  recoverRestore,
  stageRestore,
  restoreDirectory,
  backupSessionPath,
  recoverBackupWork,
} from '../src/main/backup-restore'
import { updateFreezePath } from '../src/main/update-freeze'

const roots: string[] = []
const containers: ReturnType<typeof createServiceContainer>[] = []
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrail-backup-test-'))
  roots.push(root)
  fs.cpSync(path.resolve('tests/fixtures/v1'), root, { recursive: true })
  const paths: AppPaths = {
    root,
    config: path.join(root, 'config.json'),
    data: path.join(root, 'data'),
    database: path.join(root, 'data/zhiji.db'),
    resumes: path.join(root, 'resumes'),
    chatUploads: path.join(root, 'chat-uploads'),
  }
  const config = new ConfigService(paths)
  preparePersistenceUpgrade(paths.database, config.get())
  const container = createServiceContainer(paths, false)
  containers.push(container)
  const work = fs.mkdtempSync(path.join(root, 'work-'))
  const archive = path.join(root, 'test.jobtrail-backup')
  return { paths, config, container, work, archive }
}
function importWork(root: string) {
  return fs.mkdtempSync(path.join(root, 'import-'))
}
async function backup(f: ReturnType<typeof fixture>, version = '1.0.0') {
  return exportBackup(f.paths, f.container.database, f.config, version, f.archive, f.work)
}

// Independently rewrite an authenticated archive to exercise structural validation.
async function rewrite(file: string, transform: (entries: Map<string, Buffer>) => void) {
  const bytes = fs.readFileSync(file)
  const headerSize = Buffer.byteLength('JOBTRAIL-BACKUP-1\n') + 12
  const header = bytes.subarray(0, headerSize)
  const decipher = createDecipheriv('aes-256-gcm', configEncryptionKey(), header.subarray(-12))
  decipher.setAAD(header)
  decipher.setAuthTag(bytes.subarray(-16))
  const decoded = Buffer.concat([
    decipher.update(bytes.subarray(headerSize, -16)),
    decipher.final(),
  ])
  const entries = new Map<string, Buffer>()
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.fromBuffer(decoded, { lazyEntries: true }, (e, value) =>
      e ? reject(e) : resolve(value!),
    ),
  )
  await new Promise<void>((resolve, reject) => {
    zip.on('error', reject)
    zip.on('end', resolve)
    zip.on('entry', (entry: yauzl.Entry) =>
      zip.openReadStream(entry, (error, stream) => {
        if (error) return reject(error)
        const chunks: Buffer[] = []
        stream!.on('data', (b: Buffer) => chunks.push(b))
        stream!.on('error', reject)
        stream!.on('end', () => {
          entries.set(entry.fileName, Buffer.concat(chunks))
          zip.readEntry()
        })
      }),
    )
    zip.readEntry()
  })
  transform(entries)
  const output = new ZipFile()
  const chunks: Buffer[] = []
  const ready = new Promise<Buffer>((resolve, reject) => {
    output.outputStream.on('data', (b: Buffer) => chunks.push(b))
    output.outputStream.on('error', reject)
    output.outputStream.on('end', () => resolve(Buffer.concat(chunks)))
  })
  for (const [name, data] of entries) output.addBuffer(data, name)
  output.end()
  const iv = randomBytes(12)
  const newHeader = Buffer.concat([Buffer.from('JOBTRAIL-BACKUP-1\n'), iv])
  const cipher = createCipheriv('aes-256-gcm', configEncryptionKey(), iv)
  cipher.setAAD(newHeader)
  fs.writeFileSync(
    file,
    Buffer.concat([newHeader, cipher.update(await ready), cipher.final(), cipher.getAuthTag()]),
  )
}

it('imports an authentic v1 payload, migrates it, exports v2 and restores again', async () => {
  const f = fixture()
  await backup(f)
  await rewrite(f.archive, (entries) => {
    entries.set('data/zhiji.db', fs.readFileSync('tests/fixtures/v1/data/zhiji.db'))
    entries.set(
      'config.json',
      Buffer.from(
        JSON.stringify(decryptConfig(fs.readFileSync('tests/fixtures/v1/config.json', 'utf8'))),
      ),
    )
    const manifest = JSON.parse(entries.get('manifest.json')!.toString())
    manifest.databaseVersion = 1
    manifest.configVersion = 1
    manifest.appVersion = '1.0.0'
    for (const item of manifest.files) {
      const data = entries.get(item.path)!
      item.size = data.length
      item.sha256 = createHash('sha256').update(data).digest('hex')
    }
    entries.set('manifest.json', Buffer.from(JSON.stringify(manifest)))
  })
  const original = fs.readFileSync(f.archive)
  const prepared = await importBackup(f.archive, importWork(f.paths.root))
  expect(fs.readFileSync(f.archive)).toEqual(original)
  f.container.database.close()
  fs.mkdirSync(path.join(f.paths.root, '.runtime'), { recursive: true })
  stageRestore(f.paths, prepared.directory)
  recoverRestore(f.paths)
  const restored = createServiceContainer(f.paths, false)
  containers.push(restored)
  expect(restored.database.db.pragma('user_version', { simple: true })).toBe(2)
  expect(restored.database.db.prepare('SELECT * FROM checkpoints').all().length).toBeGreaterThan(0)
  const chats = restored.database.db.prepare('SELECT * FROM agent_chat_events').all()
  const secondArchive = path.join(f.paths.root, 'upgraded.jobtrail-backup')
  const manifest = await exportBackup(
    f.paths,
    restored.database,
    new ConfigService(f.paths),
    '1.3.0',
    secondArchive,
    importWork(f.paths.root),
  )
  expect(manifest.databaseVersion).toBe(2)
  const second = await importBackup(secondArchive, importWork(f.paths.root))
  restored.database.close()
  stageRestore(f.paths, second.directory)
  recoverRestore(f.paths)
  const final = createServiceContainer(f.paths, false)
  containers.push(final)
  expect(final.database.db.prepare('SELECT * FROM agent_chat_events').all()).toEqual(chats)
})

it('round-trips all exam types, draft answers, scores and interrupted jobs into a fresh installation', async () => {
  const f = fixture(),
    exam = f.container.services.exams
  const { id: conversationId } = f.container.database.db
    .prepare('SELECT id FROM agent_conversations LIMIT 1')
    .get() as { id: string }
  const p = exam.create({
    conversationId,
    requestId: randomUUID(),
    taskId: randomUUID(),
    title: 'Backup exam',
    topic: 'TS',
    difficulty: 'Medium',
    counts: { single_choice: 1, true_false: 1, short_answer: 2 },
  })
  const identity = { conversationId, paperId: p.id }
  exam.append({
    ...identity,
    requestId: randomUUID(),
    question: {
      type: 'single_choice',
      prompt: '2+2',
      options: ['1', '2', '3', '4'],
      correct: 'D',
      explanation: 'Addition',
    },
  })
  exam.append({
    ...identity,
    requestId: randomUUID(),
    question: { type: 'true_false', prompt: '1=1', correct: true, explanation: 'Identity' },
  })
  exam.append({
    ...identity,
    requestId: randomUUID(),
    question: { type: 'short_answer', prompt: 'Define promise' },
  })
  let paper = exam.append({
    ...identity,
    requestId: randomUUID(),
    question: { type: 'short_answer', prompt: 'Explain async' },
  })
  exam.submit({
    ...identity,
    questionId: paper.questions[0].id,
    resetVersion: 0,
    expectedVersion: 0,
    value: 'D',
  })
  exam.save({
    ...identity,
    questionId: paper.questions[1].id,
    resetVersion: 0,
    expectedVersion: 0,
    value: false,
  })
  const graded = exam.beginGrade({
    ...identity,
    questionId: paper.questions[2].id,
    resetVersion: 0,
    expectedVersion: 0,
    value: 'Future result',
  })
  exam.finishGrade(
    graded,
    { score: 85, evaluation: 'Good answer', referenceAnswer: 'Future completion' },
    { input_tokens: 12, output_tokens: 25 },
  )
  exam.beginGrade({
    ...identity,
    questionId: paper.questions[3].id,
    resetVersion: 0,
    expectedVersion: 0,
    value: 'Unfinished draft',
  })
  paper = exam.get(identity)
  await backup(f)
  const prepared = await importBackup(f.archive, importWork(f.paths.root))
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-restore-fresh-'))
  roots.push(root)
  const paths = {
    root,
    data: path.join(root, 'data'),
    database: path.join(root, 'data/zhiji.db'),
    config: path.join(root, 'config.json'),
    resumes: path.join(root, 'resumes'),
    chatUploads: path.join(root, 'chat-uploads'),
  }
  fs.mkdirSync(path.join(paths.root, '.runtime'), { recursive: true })
  stageRestore(paths, prepared.directory)
  recoverRestore(paths)
  const restored = createServiceContainer(paths, false)
  containers.push(restored)
  expect(restored.services.exams.get(identity)).toEqual(paper)
  restored.services.exams.recover()
  const recovered = restored.services.exams.get(identity)
  expect(recovered.status).toBe('interrupted')
  expect(recovered.questions[0].answer.result).toMatchObject({ correct: true })
  expect(recovered.questions[1].answer).toMatchObject({ value: false, submitted: false })
  expect(recovered.questions[2].answer.result).toMatchObject({ score: 85 })
  expect(recovered.questions[3].answer).toMatchObject({
    value: 'Unfinished draft',
    gradeStatus: 'interrupted',
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const c of containers.splice(0)) if (c.database.db.open) c.database.close()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('encrypted configuration', () => {
  it('uses fresh nonces, authenticates contents and never accepts plaintext', () => {
    const data = { configVersion: 1, ai: { apiKey: 'synthetic-private-key' } }
    const a = encryptConfig(data),
      b = encryptConfig(data)
    expect(a).not.toBe(b)
    expect(a).not.toContain(data.ai.apiKey)
    expect(decryptConfig(a)).toEqual(data)
    expect(() => decryptConfig(JSON.stringify(data))).toThrow()
    expect(() => decryptConfig(JSON.stringify({ ...JSON.parse(a), extension: true }))).toThrow()
    const modified = JSON.parse(a)
    modified.ciphertext = Buffer.from('tampered').toString('base64')
    expect(() => decryptConfig(JSON.stringify(modified))).toThrow()
  })
})

describe('complete backup and restore', () => {
  it('rejects configuration exceeding the import metadata limit before replacing a backup', async () => {
    const f = fixture()
    fs.writeFileSync(
      f.paths.config,
      encryptConfig({
        ...f.config.get(),
        ai: { ...f.config.get().ai, baseUrl: 'https://example.com/' + 'x'.repeat(16 * 1024 ** 2) },
      }),
    )
    fs.writeFileSync(f.archive, 'previous backup')
    await expect(backup(f)).rejects.toMatchObject({ code: 'BACKUP_SOURCE_INVALID' })
    expect(fs.readFileSync(f.archive, 'utf8')).toBe('previous backup')
  })

  it.each(['schema', 'missing-resume'])(
    'does not publish an unrestorable backup with %s errors',
    async (kind) => {
      const f = fixture()
      if (kind === 'schema')
        f.container.database.db.exec('CREATE VIEW unexpected_view AS SELECT id FROM companies')
      else {
        const row = f.container.database.db
          .prepare('SELECT relative_path FROM resume_versions LIMIT 1')
          .get() as { relative_path: string }
        fs.rmSync(path.join(f.paths.resumes, row.relative_path))
      }
      fs.writeFileSync(f.archive, 'previous backup')
      await expect(backup(f)).rejects.toMatchObject({ code: 'BACKUP_SOURCE_INVALID' })
      expect(fs.readFileSync(f.archive, 'utf8')).toBe('previous backup')
    },
  )

  it('round-trips configuration, WAL records, resumes, chats and attachments across client versions', async () => {
    const f = fixture()
    const company = f.container.services.companies.create({ name: 'Only in exported WAL' })
    f.config.update({
      locale: 'en-US',
      ai: { ...f.config.get().ai, apiKey: 'synthetic-backup-key' },
    })
    const before = f.container.database.db.prepare('SELECT * FROM agent_chat_events').all()
    const manifest = await backup(f, '1.4.2')
    expect(fs.readFileSync(f.archive).includes(Buffer.from('synthetic-backup-key'))).toBe(false)
    expect(manifest.files.some((item) => item.path.startsWith('resumes/'))).toBe(true)
    expect(manifest.files.some((item) => item.path.startsWith('chat-uploads/'))).toBe(true)
    const prepared = await importBackup(f.archive, importWork(f.paths.root))
    expect(prepared.manifest.appVersion).toBe('1.4.2')
    f.container.services.companies.create({ name: 'Must disappear after restore' })
    f.config.update({ locale: 'zh-CN' })
    f.container.database.close()
    fs.mkdirSync(path.dirname(updateFreezePath(f.paths.root)), { recursive: true })
    fs.writeFileSync(updateFreezePath(f.paths.root), '')
    stageRestore(f.paths, prepared.directory)
    recoverRestore(f.paths)
    const restored = createServiceContainer(f.paths, false)
    containers.push(restored)
    expect(restored.services.companies.get(company.id).name).toBe(company.name)
    expect(
      restored.services.companies.list().some((c) => c.name === 'Must disappear after restore'),
    ).toBe(false)
    expect(restored.database.db.prepare('SELECT * FROM agent_chat_events').all()).toEqual(before)
    expect(new ConfigService(f.paths).get().locale).toBe('en-US')
    expect(new ConfigService(f.paths).get().ai.apiKey).toBe('synthetic-backup-key')
    for (const item of manifest.files.filter((item) =>
      /^(resumes|chat-uploads)\//.test(item.path),
    )) {
      expect(fs.readFileSync(path.join(f.paths.root, item.path))).toEqual(
        fs.readFileSync(path.join('tests/fixtures/v1', item.path)),
      )
    }
    expect(fs.existsSync(updateFreezePath(f.paths.root))).toBe(false)
  })

  it.each([0, -1])('rejects reminder %s through the service without conversion', (minutes) => {
    const f = fixture()
    const now = Date.now() + 60_000
    expect(() =>
      f.container.services.calendar.create({
        title: 'point',
        eventType: '面试',
        startAt: now,
        endAt: now,
        reminderMinutes: minutes,
      }),
    ).toThrow('提醒时间无效')
  })

  it('rejects tampering before touching live files', async () => {
    const f = fixture()
    await backup(f)
    const original = fs.readFileSync(f.paths.config)
    const archive = fs.readFileSync(f.archive)
    archive[archive.length - 1] ^= 1
    fs.writeFileSync(f.archive, archive)
    await expect(importBackup(f.archive, importWork(f.paths.root))).rejects.toMatchObject({
      code: 'BACKUP_INVALID',
    })
    expect(fs.readFileSync(f.paths.config)).toEqual(original)
  })

  it.each(['databaseVersion', 'configVersion'])(
    'rejects newer %s without resetting data',
    async (field) => {
      const f = fixture()
      await backup(f)
      await rewrite(f.archive, (entries) => {
        const manifest = JSON.parse(entries.get('manifest.json')!.toString())
        manifest[field] = 99
        entries.set('manifest.json', Buffer.from(JSON.stringify(manifest)))
      })
      await expect(importBackup(f.archive, importWork(f.paths.root))).rejects.toMatchObject({
        code: 'BACKUP_VERSION_UNSUPPORTED',
      })
      expect(f.container.services.companies.list().length).toBeGreaterThan(0)
    },
  )

  it.each(['missing', 'unknown'])(
    'rejects a %s config field in an otherwise valid backup',
    async (kind) => {
      const f = fixture()
      await backup(f)
      const original = fs.readFileSync(f.paths.config)
      await rewrite(f.archive, (entries) => {
        const value = JSON.parse(entries.get('config.json')!.toString())
        if (kind === 'missing') delete value.ai.multimodal
        else value.mcp.extension = true
        const bytes = Buffer.from(JSON.stringify(value))
        entries.set('config.json', bytes)
        const manifest = JSON.parse(entries.get('manifest.json')!.toString())
        const configEntry = manifest.files.find(
          (entry: { path: string }) => entry.path === 'config.json',
        )
        configEntry.size = bytes.length
        configEntry.sha256 = createHash('sha256').update(bytes).digest('hex')
        entries.set('manifest.json', Buffer.from(JSON.stringify(manifest)))
      })
      await expect(importBackup(f.archive, importWork(f.paths.root))).rejects.toMatchObject({
        code: 'BACKUP_INVALID',
      })
      expect(fs.readFileSync(f.paths.config)).toEqual(original)
    },
  )

  it.each(['checksum', 'undeclared', 'missing'])('rejects %s payload errors', async (kind) => {
    const f = fixture()
    await backup(f)
    await rewrite(f.archive, (entries) => {
      if (kind === 'checksum') entries.set('config.json', Buffer.from('{}'))
      if (kind === 'undeclared')
        entries.set('resumes/11111111-1111-4111-8111-111111111111.pdf', Buffer.from('extra'))
      if (kind === 'missing') entries.delete('data/zhiji.db')
    })
    await expect(importBackup(f.archive, importWork(f.paths.root))).rejects.toMatchObject({
      code: 'BACKUP_INVALID',
    })
  })

  it.each(['orphan-parent', 'third-level', 'root-company', 'empty-builtin'])(
    'rejects invalid industry relations: %s',
    async (kind) => {
      const f = fixture()
      const db = f.container.database.db
      const root = (
        db.prepare('SELECT id FROM industries WHERE parent_id IS NULL LIMIT 1').get() as {
          id: number
        }
      ).id
      const children = db
        .prepare('SELECT id FROM industries WHERE parent_id=? LIMIT 2')
        .all(root) as { id: number }[]
      if (kind === 'orphan-parent')
        db.prepare('UPDATE industries SET parent_id=999999 WHERE id=?').run(children[0].id)
      if (kind === 'third-level')
        db.prepare('UPDATE industries SET parent_id=? WHERE id=?').run(
          children[0].id,
          children[1].id,
        )
      if (kind === 'root-company')
        db.prepare('INSERT INTO company_industries VALUES(1,?,0)').run(root)
      if (kind === 'empty-builtin')
        db.prepare('DELETE FROM company_industries WHERE company_id=1').run()
      await expect(backup(f)).rejects.toMatchObject({ code: 'BACKUP_SOURCE_INVALID' })
    },
  )

  it('rejects paths outside the managed file allowlist', () => {
    for (const name of [
      '../config.json',
      '/config.json',
      'C:/config.json',
      'resumes/../config.json',
      'resumes/CON',
      'data/zhiji.db-wal',
      'config.json:stream',
    ])
      expect(allowedBackupPath(name)).toBe(false)
  })

  it('rolls back the whole set when replacing a file fails', async () => {
    const f = fixture()
    await backup(f)
    const prepared = await importBackup(f.archive, importWork(f.paths.root))
    f.config.update({ locale: 'en-US' })
    f.container.database.close()
    const original = fs.readFileSync(f.paths.config)
    fs.mkdirSync(path.join(f.paths.root, '.runtime'), { recursive: true })
    stageRestore(f.paths, prepared.directory)
    const rename = fs.renameSync
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from) === path.join(restoreDirectory(f.paths.root), 'incoming', 'resumes'))
        throw new Error('locked')
      return rename(from, to)
    })
    expect(() => recoverRestore(f.paths)).toThrow('locked')
    expect(fs.readFileSync(f.paths.config)).toEqual(original)
    vi.restoreAllMocks()
    recoverRestore(f.paths)
    expect(new ConfigService(f.paths).get().locale).toBe('en-US')
  })

  it('recovers a process crash between two directory replacements', async () => {
    const f = fixture()
    await backup(f)
    const prepared = await importBackup(f.archive, importWork(f.paths.root))
    f.config.update({ locale: 'en-US' })
    f.container.database.close()
    fs.mkdirSync(path.join(f.paths.root, '.runtime'), { recursive: true })
    stageRestore(f.paths, prepared.directory)
    const directory = restoreDirectory(f.paths.root)
    const journal = path.join(directory, 'journal.json')
    const value = JSON.parse(fs.readFileSync(journal, 'utf8'))
    value.phase = 'applying'
    fs.writeFileSync(journal, JSON.stringify(value))
    fs.renameSync(f.paths.config, path.join(directory, 'previous', 'config.json'))
    fs.renameSync(path.join(directory, 'incoming', 'config.json'), f.paths.config)
    recoverRestore(f.paths)
    expect(new ConfigService(f.paths).get().locale).toBe('en-US')
  })

  it('cleans interrupted backup workspace and its freeze after the owning process exited', () => {
    const f = fixture()
    fs.mkdirSync(path.dirname(backupSessionPath(f.paths.root)), { recursive: true })
    fs.writeFileSync(backupSessionPath(f.paths.root), JSON.stringify({ pid: 2147483647 }))
    fs.writeFileSync(updateFreezePath(f.paths.root), '')
    const work = fs.mkdtempSync(path.join(f.paths.root, '.runtime/backup-work-'))
    fs.writeFileSync(path.join(work, 'decrypted.zip'), 'synthetic')
    recoverBackupWork(f.paths)
    expect(fs.existsSync(work)).toBe(false)
    expect(fs.existsSync(updateFreezePath(f.paths.root))).toBe(false)
  })
})
