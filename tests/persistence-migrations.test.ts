import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ensurePersistenceReady,
  migrationChain,
  preparePersistenceUpgrade,
  validateDatabaseVersion,
  DATABASE_MIGRATIONS,
} from '../src/main/persistence-migrations'
import { decryptConfig } from '../src/main/config-crypto'
import { createHash } from 'node:crypto'
import { DatabaseManager } from '../src/main/database'
import { DiscoveryRepository } from '../src/main/discovery/repository'
import { searchQuerySchema } from '../src/shared/job-discovery'
import { SCHEMA_V4 } from '../src/main/persistence/schema-v4'
const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }))
})
function fixture(version = 1) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-'))
  roots.push(root)
  fs.cpSync(path.resolve(`tests/fixtures/v${version}`), root, { recursive: true })
  return {
    root,
    data: path.join(root, 'data'),
    database: path.join(root, 'data/zhiji.db'),
    config: path.join(root, 'config.json'),
    resumes: path.join(root, 'resumes'),
    chatUploads: path.join(root, 'chat-uploads'),
  }
}
describe('persistent version upgrades', () => {
  it('checks the agreed v4 tables, columns, constraints and explicit indexes', () => {
    const db = new Database(':memory:')
    try {
      db.exec(SCHEMA_V4)
      const objects = db
        .prepare(
          "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name",
        )
        .all() as { type: string; name: string; tbl_name: string; sql: string }[]
      expect(objects.filter((row) => row.type === 'table')).toHaveLength(30)
      expect(objects.filter((row) => row.type === 'index')).toHaveLength(31)
      // Before v2.0.0 ships, correct v4 and this baseline together; never repair
      // intermediate development databases at startup. Freeze both on release.
      expect(
        createHash('sha256')
          .update(
            JSON.stringify(
              objects.map((row) => ({ ...row, sql: row.sql.replace(/\s+/g, ' ').trim() })),
            ),
          )
          .digest('hex'),
      ).toBe('a97d94112163a46013d070d037212bd52cb571feddd1b098986a86b97f772aae')
    } finally {
      db.close()
    }
  })
  it('retains the frozen v2 fixture hashes and verifies its original schema', () => {
    const paths = fixture(2)
    const bytes = fs.readFileSync(path.join(paths.root, 'manifest.json'))
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      'eaba584cd864f4127f8e9b2ca9557b25b09e69748fd4f919c26fc3e3e9cff714',
    )
    const manifest = JSON.parse(bytes.toString()) as { files: Record<string, string> }
    for (const [relative, hash] of Object.entries(manifest.files))
      expect(
        createHash('sha256')
          .update(fs.readFileSync(path.join(paths.root, relative)))
          .digest('hex'),
      ).toBe(hash)
    const db = new Database(paths.database)
    try {
      validateDatabaseVersion(db, 2)
      expect(db.prepare('SELECT * FROM exam_answers').all()).toHaveLength(3)
      expect(db.prepare('SELECT * FROM checkpoints').all().length).toBeGreaterThan(0)
    } finally {
      db.close()
    }
  })

  it.each([1, 2, 3])(
    'upgrades v%i without changing existing rows and matches a fresh v4 schema',
    async (version) => {
      const paths = fixture(version === 3 ? 2 : version)
      if (version === 3) {
        const source = new Database(paths.database)
        try {
          DATABASE_MIGRATIONS[1].apply(source)
          source.pragma('user_version = 3')
          source.exec("INSERT INTO locations(id,name,created_at) VALUES(1,'上海',1234)")
          source.exec(
            'INSERT INTO company_locations(company_id,location_id,created_at) SELECT id,1,1234 FROM companies ORDER BY id LIMIT 1',
          )
          validateDatabaseVersion(source, 3)
        } finally {
          source.close()
        }
      }
      const read = (file: string, tables?: string[]) => {
        const db = new Database(file, { readonly: true })
        try {
          const names =
            tables ??
            (
              db
                .prepare(
                  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
                )
                .all() as { name: string }[]
            ).map((row) => row.name)
          return Object.fromEntries(
            names.map((name) => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]),
          )
        } finally {
          db.close()
        }
      }
      const before = read(paths.database)
      await ensurePersistenceReady(paths)
      expect(read(paths.database, Object.keys(before))).toEqual(before)
      const upgraded = new Database(paths.database)
      const freshRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-v4-'))
      roots.push(freshRoot)
      const fresh = new DatabaseManager({
        ...paths,
        root: freshRoot,
        database: path.join(freshRoot, 'data/zhiji.db'),
      })
      try {
        validateDatabaseVersion(upgraded, 4)
        if (version < 3) expect(upgraded.prepare('SELECT * FROM locations').all()).toEqual([])
        const schema = (db: Database.Database) =>
          db
            .prepare(
              "SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT IN ('checkpoints','writes') ORDER BY name",
            )
            .all()
        expect(schema(upgraded)).toEqual(schema(fresh.db))
      } finally {
        upgraded.close()
        fresh.close()
      }
      await ensurePersistenceReady(paths)
      expect(read(paths.database, Object.keys(before))).toEqual(before)
    },
  )

  it.each([0, 1, 2])('rolls the entire v1 chain back if migration step %i fails', (index) => {
    const paths = fixture()
    const original = DATABASE_MIGRATIONS[index].apply
    DATABASE_MIGRATIONS[index].apply = (db) => {
      original(db)
      throw new Error('migration-step failure')
    }
    try {
      expect(() =>
        preparePersistenceUpgrade(
          paths.database,
          decryptConfig(fs.readFileSync(paths.config, 'utf8')),
        ),
      ).toThrow('migration-step failure')
    } finally {
      DATABASE_MIGRATIONS[index].apply = original
    }
    const db = new Database(paths.database)
    try {
      validateDatabaseVersion(db, 1)
    } finally {
      db.close()
    }
  })

  it('requires desktop migration before a v2 database can be opened for business', () => {
    const paths = fixture(2)
    const before = fs.readFileSync(paths.database)
    expect(() => new DatabaseManager(paths)).toThrow('需要版本 4')
    expect(fs.readFileSync(paths.database)).toEqual(before)
  })

  it('upgrades under the root launcher freeze and leaves that freeze owned by the launcher', async () => {
    const paths = fixture(),
      freeze = path.join(paths.root, '.runtime/state/update-freeze')
    fs.mkdirSync(path.dirname(freeze), { recursive: true })
    fs.writeFileSync(freeze, '')
    await ensurePersistenceReady(paths, true)
    expect(fs.existsSync(freeze)).toBe(true)
    const db = new Database(paths.database)
    validateDatabaseVersion(db, 4)
    db.close()
  })
  it('refuses a second live migration owner without changing user data', async () => {
    const paths = fixture(),
      work = path.join(paths.root, '.runtime/persistence-upgrade')
    fs.mkdirSync(work, { recursive: true })
    fs.writeFileSync(path.join(work, 'owner.json'), JSON.stringify({ pid: process.pid }))
    const bytes = fs.readFileSync(paths.database)
    await expect(ensurePersistenceReady(paths)).rejects.toMatchObject({ code: 'PERSISTENCE_BUSY' })
    expect(fs.readFileSync(paths.database)).toEqual(bytes)
  })
  it('keeps MCP clients connected when a current-schema desktop starts', async () => {
    const paths = fixture()
    await ensurePersistenceReady(paths)
    const leases = path.join(paths.root, '.runtime/state/mcp-sessions')
    fs.mkdirSync(leases, { recursive: true })
    const lease = path.join(leases, `${process.pid}-00000000-0000-0000-0000-000000000000`)
    fs.writeFileSync(lease, '')
    await ensurePersistenceReady(paths)
    expect(fs.existsSync(lease)).toBe(true)
    expect(fs.existsSync(path.join(paths.root, '.runtime/state/update-freeze'))).toBe(false)
  })
  it('interrupts discovery work during supervised startup without releasing the launcher freeze', async () => {
    const paths = fixture()
    await ensurePersistenceReady(paths)
    const db = new Database(paths.database)
    const repo = new DiscoveryRepository(db)
    for (const status of repo.status())
      repo.platform({
        ...status,
        state: 'authenticated',
        checkedAt: 1234,
        evidence: 'official_qr_login_confirmed',
        limitations: [],
      })
    const run = repo.create(
      searchQuerySchema.parse({ keyword: 'Java', platforms: ['boss'] }),
      crypto.randomUUID(),
    )
    db.close()
    const freeze = path.join(paths.root, '.runtime/state/update-freeze')
    fs.mkdirSync(path.dirname(freeze), { recursive: true })
    fs.writeFileSync(freeze, '')
    await ensurePersistenceReady(paths, true)
    const reopened = new Database(paths.database)
    expect(new DiscoveryRepository(reopened).run(run.id).state).toBe('interrupted')
    for (const status of new DiscoveryRepository(reopened).status())
      expect(status).toMatchObject({
        state: 'authenticated',
        checkedAt: 1234,
        evidence: 'official_qr_login_confirmed',
        limitations: ['session_recheck_required'],
      })
    expect(fs.existsSync(freeze)).toBe(true)
    reopened.close()
    await ensurePersistenceReady(paths, true)
    const again = new Database(paths.database)
    try {
      for (const status of new DiscoveryRepository(again).status())
        expect(status).toMatchObject({
          state: 'authenticated',
          checkedAt: 1234,
          generation: 3,
          limitations: ['session_recheck_required'],
        })
    } finally {
      again.close()
    }
  })
  it.each(['prepared', 'applying', 'committed'])(
    'recovers a stopped process at the %s replacement phase',
    async (phase) => {
      const paths = fixture(),
        work = path.join(paths.root, '.runtime/persistence-upgrade')
      fs.mkdirSync(work, { recursive: true })
      fs.mkdirSync(path.join(paths.root, '.runtime/state'), { recursive: true })
      const configuration = decryptConfig(fs.readFileSync(paths.config, 'utf8'))
      fs.copyFileSync(paths.database, path.join(work, 'previous.db'))
      fs.copyFileSync(paths.config, path.join(work, 'previous.config'))
      if (phase !== 'prepared') preparePersistenceUpgrade(paths.database, configuration)
      if (phase === 'applying') fs.writeFileSync(paths.config, 'interrupted replacement')
      fs.writeFileSync(path.join(work, 'journal.json'), JSON.stringify({ phase }))
      fs.writeFileSync(path.join(work, 'owner.json'), JSON.stringify({ pid: 2147483647 }))
      fs.writeFileSync(path.join(paths.root, '.runtime/state/update-freeze'), '')
      await ensurePersistenceReady(paths)
      expect(decryptConfig(fs.readFileSync(paths.config, 'utf8'))).toEqual(configuration)
      const db = new Database(paths.database)
      validateDatabaseVersion(db, 4)
      db.close()
      expect(fs.existsSync(path.join(work, 'journal.json'))).toBe(false)
      expect(fs.existsSync(path.join(paths.root, '.runtime/state/update-freeze'))).toBe(false)
    },
  )
  it('runs continuous independent whitelists and rejects gaps, duplicates and downgrades', () => {
    const steps = [
      { from: 1, to: 2, apply: (v: string) => v + '2' },
      { from: 2, to: 3, apply: (v: string) => v + '3' },
      { from: 3, to: 4, apply: (v: string) => v + '4' },
    ]
    expect(migrationChain(1, 4, steps).reduce((v, s) => s.apply(v), '1')).toBe('1234')
    expect(migrationChain(2, 4, steps).map((s) => s.from)).toEqual([2, 3])
    expect(migrationChain(4, 4, steps)).toEqual([])
    expect(() => migrationChain(1, 4, steps.slice(1))).toThrow()
    expect(() => migrationChain(1, 4, [...steps, steps[0]])).toThrow()
    expect(() => migrationChain(4, 2, steps)).toThrow()
    const configSteps = [
      {
        from: 1,
        to: 2,
        apply: (v: { configVersion: number; key: string }) => ({ ...v, configVersion: 2 }),
      },
    ]
    expect(
      migrationChain(1, 2, configSteps).reduce((v, s) => s.apply(v), {
        configVersion: 1,
        key: 'keep',
      }),
    ).toEqual({ configVersion: 2, key: 'keep' })
  })
  it('upgrades the formal baseline at startup, preserves config bytes and is repeatable', async () => {
    const paths = fixture(),
      config = fs.readFileSync(paths.config)
    await ensurePersistenceReady(paths)
    let db = new Database(paths.database)
    validateDatabaseVersion(db, 4)
    expect(db.prepare('SELECT * FROM checkpoints').all().length).toBeGreaterThan(0)
    db.close()
    expect(decryptConfig(fs.readFileSync(paths.config, 'utf8'))).toEqual(
      decryptConfig(config.toString()),
    )
    const upgraded = fs.readFileSync(paths.config)
    await ensurePersistenceReady(paths)
    expect(fs.readFileSync(paths.config)).toEqual(upgraded)
    db = new Database(paths.database)
    validateDatabaseVersion(db, 4)
    db.close()
  })
  it('rolls back a failed migration transaction without stamping a new version', () => {
    const paths = fixture(),
      original = DATABASE_MIGRATIONS[0].apply
    DATABASE_MIGRATIONS[0].apply = (db) => {
      original(db)
      throw new Error('injected')
    }
    try {
      expect(() =>
        preparePersistenceUpgrade(
          paths.database,
          decryptConfig(fs.readFileSync(paths.config, 'utf8')),
        ),
      ).toThrow('injected')
    } finally {
      DATABASE_MIGRATIONS[0].apply = original
    }
    const db = new Database(paths.database)
    validateDatabaseVersion(db, 1)
    db.close()
  })
  it('recovers both files if replacement fails after the database was replaced', async () => {
    const paths = fixture(),
      oldConfig = fs.readFileSync(paths.config),
      copy = fs.copyFileSync
    let failed = false
    vi.spyOn(fs, 'copyFileSync').mockImplementation((source, dest, mode) => {
      if (String(source).endsWith('next.config') && !failed) {
        failed = true
        throw new Error('injected')
      }
      return copy(source, dest, mode)
    })
    await expect(ensurePersistenceReady(paths)).rejects.toThrow()
    expect(fs.readFileSync(paths.config)).toEqual(oldConfig)
    const db = new Database(paths.database)
    validateDatabaseVersion(db, 1)
    db.close()
    await ensurePersistenceReady(paths)
  })
  it('rejects forged and future versions without resetting source files', async () => {
    const paths = fixture(),
      db = new Database(paths.database)
    db.pragma('user_version=99')
    db.close()
    const bytes = fs.readFileSync(paths.database)
    await expect(ensurePersistenceReady(paths)).rejects.toThrow()
    expect(fs.readFileSync(paths.database)).toEqual(bytes)
  })
  it('rejects unknown tables even when the declared version is supported', async () => {
    const paths = fixture(),
      db = new Database(paths.database)
    db.exec('CREATE TABLE unexpected (id TEXT)')
    db.close()
    const bytes = fs.readFileSync(paths.database)
    await expect(ensurePersistenceReady(paths)).rejects.toMatchObject({
      code: 'PERSISTENCE_FAILED',
    })
    expect(fs.readFileSync(paths.database)).toEqual(bytes)
  })
})
