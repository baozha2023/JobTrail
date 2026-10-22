import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { afterEach, expect, it } from 'vitest'
import { DATABASE_MIGRATIONS, validateDatabaseVersion } from '../src/main/persistence-migrations'
import { SCHEMA_V8 } from '../src/main/persistence/schema-v8'
import { decryptConfig } from '../src/main/config-crypto'
import { seedDiscoveryV6 } from './helpers/discovery-v6'
import { DiscoveryRepository } from '../src/main/discovery/repository'
import { searchQuerySchema, type JobPlatform } from '../src/shared/job-discovery'

const roots: string[] = []
afterEach(() =>
  roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })),
)
function addJob(db: Database.Database, platform: JobPlatform, url: string) {
  const repo = new DiscoveryRepository(db)
  const run = repo.create(
    searchQuerySchema.parse({ keyword: 'Java', platforms: [platform] }),
    randomUUID(),
  )
  repo.observe(
    {
      platform,
      url,
      title: '合成岗位',
      company: '合成公司',
      city: '北京',
      salary: '99.9K/月',
      experience: '',
      education: '博士',
      recruitment: '',
      employment: '实习',
      jd: '完整合成职责',
      detailRead: true,
    },
    run.id,
    1234,
    'detail',
  )
  repo.platform({
    ...repo.status().find((s) => s.platform === platform)!,
    state: 'authenticated',
    checkedAt: 1234,
    evidence: 'official_account_check',
  })
  repo.state(run.id, 'completed')
  return run
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-v8-'))
  roots.push(root)
  fs.cpSync(path.resolve('tests/fixtures/v2'), root, { recursive: true })
  const file = path.join(root, 'data/zhiji.db'),
    db = new Database(file)
  for (const step of DATABASE_MIGRATIONS.filter((s) => s.from >= 2 && s.to <= 6)) {
    step.apply(db)
    db.pragma(`user_version=${step.to}`)
  }
  seedDiscoveryV6(db)
  DATABASE_MIGRATIONS.find((s) => s.from === 6)!.apply(db)
  db.pragma('user_version=7')
  addJob(db, 'nowcoder', 'https://www.nowcoder.com/jobs/detail/123456')
  validateDatabaseVersion(db, 7)
  return {
    db,
    file,
    config: decryptConfig(fs.readFileSync(path.join(root, 'config.json'), 'utf8')),
  }
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

it('preserves all eight-platform v7 rows, saved links, checkpoints and indexes; matches a fresh v8', () => {
  const f = fixture(),
    before = contents(f.db)
  expect(
    new Set((before.discovery_jobs as { platform: string }[]).map((r) => r.platform)).size,
  ).toBe(8)
  f.db.close()
  upgradeV8(f.file)
  const db = new Database(f.file),
    fresh = new Database(':memory:')
  try {
    validateDatabaseVersion(db, 8)
    expect(contents(db)).toEqual(before)
    fresh.exec(SCHEMA_V8)
    expect(schema(db)).toEqual(schema(fresh))
    expect((schema(db) as { type: string }[]).filter((r) => r.type === 'table')).toHaveLength(30)
    expect((schema(db) as { type: string }[]).filter((r) => r.type === 'index')).toHaveLength(31)
    const run = addJob(db, 'ncss', 'https://job.ncss.cn/student/jobs/abcdef123456/detail.html')
    validateDatabaseVersion(db, 8)
    expect(new DiscoveryRepository(db).list({ runId: run.id }).items[0]).toMatchObject({
      platform: 'ncss',
      salary: '99.9K/月',
      education: '博士',
      employment: '实习',
    })
    expect(() =>
      db.prepare('INSERT INTO discovery_platforms VALUES(?,?)').run('unknown', '{}'),
    ).toThrow('CHECK')
  } finally {
    db.close()
    fresh.close()
  }
})
it('rolls back v7 replacement tables and every row after a post-copy failure', () => {
  const f = fixture(),
    before = contents(f.db),
    ddl = schema(f.db)
  f.db.close()
  const step = DATABASE_MIGRATIONS.find((s) => s.from === 7)!,
    apply = step.apply
  step.apply = (db) => {
    apply(db)
    throw new Error('post-copy failure')
  }
  try {
    expect(() => upgradeV8(f.file)).toThrow('post-copy failure')
  } finally {
    step.apply = apply
  }
  const db = new Database(f.file)
  try {
    validateDatabaseVersion(db, 7)
    expect(contents(db)).toEqual(before)
    expect(schema(db)).toEqual(ddl)
  } finally {
    db.close()
  }
})
it('keeps released v7 SQL and row JSON validation closed to ncss', () => {
  const f = fixture()
  try {
    expect(() =>
      f.db.prepare('INSERT INTO discovery_platforms VALUES(?,?)').run('ncss', '{}'),
    ).toThrow('CHECK')
    const run = f.db.prepare('SELECT id,query FROM discovery_runs LIMIT 1').get() as {
      id: string
      query: string
    }
    const query = JSON.parse(run.query)
    query.platforms.push('ncss')
    f.db.prepare('UPDATE discovery_runs SET query=? WHERE id=?').run(JSON.stringify(query), run.id)
    expect(() => validateDatabaseVersion(f.db, 7)).toThrow('Invalid persistent platform')
  } finally {
    f.db.close()
  }
})

// Keep the published v8 migration and validation target frozen.
function upgradeV8(file: string) {
  const db = new Database(file)
  try {
    db.transaction(() => {
      const version = Number(db.pragma('user_version', { simple: true }))
      for (const step of DATABASE_MIGRATIONS.filter((s) => s.from >= version && s.to <= 8)) {
        step.apply(db)
        db.pragma(`user_version=${step.to}`)
        validateDatabaseVersion(db, step.to)
      }
    }).immediate()
  } finally {
    db.close()
  }
}
