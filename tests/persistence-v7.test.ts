import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, expect, it } from 'vitest'
import { DATABASE_MIGRATIONS, validateDatabaseVersion } from '../src/main/persistence-migrations'
import { SCHEMA_V7 } from '../src/main/persistence/schema-v7'
import { decryptConfig } from '../src/main/config-crypto'
import { seedDiscoveryV6 } from './helpers/discovery-v6'
import { DiscoveryRepository } from '../src/main/discovery/repository'
import { searchQuerySchema } from '../src/shared/job-discovery'
import { randomUUID } from 'node:crypto'

const roots: string[] = []
afterEach(() =>
  roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })),
)
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-v7-'))
  roots.push(root)
  fs.cpSync(path.resolve('tests/fixtures/v2'), root, { recursive: true })
  const file = path.join(root, 'data/zhiji.db'),
    db = new Database(file)
  for (const step of DATABASE_MIGRATIONS.filter((step) => step.from >= 2 && step.to <= 6)) {
    step.apply(db)
    db.pragma(`user_version=${step.to}`)
  }
  seedDiscoveryV6(db)
  validateDatabaseVersion(db, 6)
  return {
    db,
    file,
    config: decryptConfig(fs.readFileSync(path.join(root, 'config.json'), 'utf8')),
  }
}
function contents(db: Database.Database) {
  const names = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as { name: string }[]
  return Object.fromEntries(
    names.map(({ name }) => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]),
  )
}
const schema = (db: Database.Database) =>
  db
    .prepare(
      "SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT IN ('checkpoints','writes') ORDER BY type,name",
    )
    .all()

it('upgrades seven-platform v6 with every row, saved link, observation and checkpoint unchanged', () => {
  const f = fixture(),
    before = contents(f.db)
  expect(
    new Set((before.discovery_jobs as { platform: string }[]).map((r) => r.platform)).size,
  ).toBe(7)
  f.db.close()
  upgradeV7(f.file)
  const db = new Database(f.file),
    fresh = new Database(':memory:')
  try {
    validateDatabaseVersion(db, 7)
    expect(contents(db)).toEqual(before)
    fresh.exec(SCHEMA_V7)
    expect(schema(db)).toEqual(schema(fresh))
    expect((schema(db) as { type: string }[]).filter((r) => r.type === 'table')).toHaveLength(30)
    expect((schema(db) as { type: string }[]).filter((r) => r.type === 'index')).toHaveLength(31)
    expect(() =>
      db.prepare('INSERT INTO discovery_platforms VALUES(?,?)').run('unknown', '{}'),
    ).toThrow('CHECK')
    const repo = new DiscoveryRepository(db),
      run = repo.create(
        searchQuerySchema.parse({ keyword: 'Java', platforms: ['nowcoder'] }),
        randomUUID(),
      )
    repo.observe(
      {
        platform: 'nowcoder',
        url: 'https://www.nowcoder.com/jobs/detail/123456',
        title: 'Java',
        company: '合成公司',
        city: '北京',
        salary: '15-20K/月',
        experience: '',
        education: '本科',
        recruitment: '校招',
        employment: '',
        jd: '完整职责与要求',
        detailRead: true,
      },
      run.id,
      1234,
      'detail',
    )
    repo.platform({
      ...repo.status().find((s) => s.platform === 'nowcoder')!,
      state: 'authenticated',
      checkedAt: 1234,
      evidence: 'official_account_check',
    })
    repo.state(run.id, 'completed')
    validateDatabaseVersion(db, 7)
    expect(repo.list({ runId: run.id }).items[0].platform).toBe('nowcoder')
  } finally {
    db.close()
    fresh.close()
  }
})
it('rolls back v6 to v7 replacement tables and all data on a post-copy failure', () => {
  const f = fixture(),
    before = contents(f.db),
    ddl = schema(f.db)
  f.db.close()
  const step = DATABASE_MIGRATIONS.find((s) => s.from === 6)!,
    apply = step.apply
  step.apply = (db) => {
    apply(db)
    throw new Error('post-copy failure')
  }
  try {
    expect(() => upgradeV7(f.file)).toThrow('post-copy failure')
  } finally {
    step.apply = apply
  }
  const db = new Database(f.file)
  try {
    validateDatabaseVersion(db, 6)
    expect(contents(db)).toEqual(before)
    expect(schema(db)).toEqual(ddl)
  } finally {
    db.close()
  }
})
it('keeps the v6 SQL and nested query JSON contract frozen', () => {
  const f = fixture()
  try {
    expect(() =>
      f.db.prepare('INSERT INTO discovery_platforms VALUES(?,?)').run('nowcoder', '{}'),
    ).toThrow('CHECK')
    const run = f.db.prepare('SELECT id,query FROM discovery_runs LIMIT 1').get() as {
      id: string
      query: string
    }
    const query = JSON.parse(run.query)
    query.platforms.push('nowcoder')
    f.db.prepare('UPDATE discovery_runs SET query=? WHERE id=?').run(JSON.stringify(query), run.id)
    expect(() => validateDatabaseVersion(f.db, 6)).toThrow('Invalid persistent platform')
  } finally {
    f.db.close()
  }
})

// Released v7 remains independently testable after the current target advances.
function upgradeV7(file: string) {
  const db = new Database(file)
  try {
    db.transaction(() => {
      const version = Number(db.pragma('user_version', { simple: true }))
      for (const step of DATABASE_MIGRATIONS.filter((s) => s.from >= version && s.to <= 7)) {
        step.apply(db)
        db.pragma(`user_version=${step.to}`)
        validateDatabaseVersion(db, step.to)
      }
    }).immediate()
  } finally {
    db.close()
  }
}
