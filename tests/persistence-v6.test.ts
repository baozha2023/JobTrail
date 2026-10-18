import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, expect, it } from 'vitest'
import { DATABASE_MIGRATIONS, validateDatabaseVersion } from '../src/main/persistence-migrations'
import { SCHEMA_V6 } from '../src/main/persistence/schema-v6'
import { decryptConfig } from '../src/main/config-crypto'
import { seedDiscoveryV4 } from './helpers/discovery-v4'
import { DiscoveryRepository } from '../src/main/discovery/repository'
import { searchQuerySchema } from '../src/shared/job-discovery'
import { randomUUID } from 'node:crypto'

// Keep the released v6 step under test even after the current target advances.
function upgradeV6(file: string) {
  const db = new Database(file)
  try {
    db.transaction(() => {
      const version = Number(db.pragma('user_version', { simple: true }))
      for (const step of DATABASE_MIGRATIONS.filter((s) => s.from >= version && s.to <= 6)) {
        step.apply(db)
        db.pragma(`user_version=${step.to}`)
        validateDatabaseVersion(db, step.to)
      }
    }).immediate()
  } finally {
    db.close()
  }
}

const roots: string[] = []
afterEach(() =>
  roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })),
)
function fixture(version: number) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-v6-'))
  roots.push(root)
  fs.cpSync(path.resolve('tests/fixtures/v2'), root, { recursive: true })
  const file = path.join(root, 'data/zhiji.db'),
    db = new Database(file)
  for (const step of DATABASE_MIGRATIONS.filter((step) => step.from >= 2 && step.to <= version)) {
    step.apply(db)
    db.pragma(`user_version=${step.to}`)
  }
  seedDiscoveryV4(db)
  validateDatabaseVersion(db, version)
  const config = decryptConfig(fs.readFileSync(path.join(root, 'config.json'), 'utf8'))
  return { db, file, config }
}
function contents(db: Database.Database) {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as { name: string }[]
  return Object.fromEntries(
    tables.map(({ name }) => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]),
  )
}
const schema = (db: Database.Database) =>
  db
    .prepare(
      "SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT IN ('checkpoints','writes') ORDER BY type,name",
    )
    .all()

it.each([4, 5])(
  'upgrades populated v%i to v6 with every row, ID, observation and link preserved',
  (version) => {
    const f = fixture(version),
      before = contents(f.db)
    f.db.close()
    upgradeV6(f.file)
    const db = new Database(f.file),
      fresh = new Database(':memory:')
    try {
      validateDatabaseVersion(db, 6)
      expect(contents(db)).toEqual(before)
      fresh.exec(SCHEMA_V6)
      expect(schema(db)).toEqual(schema(fresh))
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name LIKE 'discovery_%'",
          )
          .get(),
      ).toEqual({ n: 10 })
    } finally {
      db.close()
      fresh.close()
    }
  },
)
it('rolls back a failed v5 to v6 step, including table replacements and user_version', () => {
  const f = fixture(5),
    before = contents(f.db),
    ddl = schema(f.db)
  f.db.close()
  const step = DATABASE_MIGRATIONS.find((step) => step.from === 5)!,
    apply = step.apply
  step.apply = (db) => {
    apply(db)
    throw new Error('injected post-copy failure')
  }
  try {
    expect(() => upgradeV6(f.file)).toThrow('injected post-copy failure')
  } finally {
    step.apply = apply
  }
  const db = new Database(f.file)
  try {
    validateDatabaseVersion(db, 5)
    expect(contents(db)).toEqual(before)
    expect(schema(db)).toEqual(ddl)
  } finally {
    db.close()
  }
})
it('admits Yupao jobs, sources, status and query JSON after the formal migration', () => {
  const f = fixture(5)
  f.db.close()
  upgradeV6(f.file)
  const db = new Database(f.file)
  try {
    const repo = new DiscoveryRepository(db)
    const run = repo.create(
      searchQuerySchema.parse({ keyword: 'Java', city: '北京', platforms: ['yupao'] }),
      randomUUID(),
    )
    repo.observe(
      {
        platform: 'yupao',
        externalId: '123456',
        url: 'https://www.yupao.com/zhaogong/123456.html',
        title: 'Java',
        company: '迁移验收公司',
        city: '北京',
        salary: '1-2万/月',
        education: '',
        experience: '',
        employment: '',
        recruitment: '',
        jd: '合成原始职责',
        detailRead: true,
      },
      run.id,
      Date.now(),
      'detail',
    )
    repo.platform({
      ...repo.status().find((s) => s.platform === 'yupao')!,
      state: 'authenticated',
      checkedAt: Date.now(),
      evidence: 'official_account_check',
    })
    repo.state(run.id, 'completed')
    expect(repo.list({ runId: run.id }).items[0]).toMatchObject({
      platform: 'yupao',
      externalId: '123456',
    })
    validateDatabaseVersion(db, 6)
  } finally {
    db.close()
  }
})
it.each([4, 5])(
  'keeps v%i JSON platform validation frozen even when current schemas accept yupao',
  (version) => {
    const f = fixture(version)
    try {
      const run = f.db.prepare('SELECT id,query FROM discovery_runs LIMIT 1').get() as {
        id: string
        query: string
      }
      const query = JSON.parse(run.query)
      query.platforms.push('yupao')
      f.db
        .prepare('UPDATE discovery_runs SET query=? WHERE id=?')
        .run(JSON.stringify(query), run.id)
      expect(() => validateDatabaseVersion(f.db, version)).toThrow('Invalid persistent platform')
      expect(() =>
        f.db.prepare('INSERT INTO discovery_platforms VALUES(?,?)').run('yupao', '{}'),
      ).toThrow('CHECK')
    } finally {
      f.db.close()
    }
  },
)
