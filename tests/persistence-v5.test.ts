import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, expect, it } from 'vitest'
import {
  DATABASE_MIGRATIONS,
  preparePersistenceUpgrade,
  validateDatabaseVersion,
} from '../src/main/persistence-migrations'
import { SCHEMA_V5 } from '../src/main/persistence/schema-v5'
import { decryptConfig } from '../src/main/config-crypto'
import { seedDiscoveryV4 } from './helpers/discovery-v4'

const roots: string[] = []
afterEach(() =>
  roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })),
)
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v4-v5-'))
  roots.push(root)
  fs.cpSync(path.resolve('tests/fixtures/v2'), root, { recursive: true })
  const file = path.join(root, 'data/zhiji.db'),
    db = new Database(file)
  for (const step of DATABASE_MIGRATIONS.filter((s) => s.from >= 2 && s.to <= 4)) {
    step.apply(db)
    db.pragma(`user_version=${step.to}`)
  }
  seedDiscoveryV4(db)
  validateDatabaseVersion(db, 4)
  return {
    root,
    file,
    db,
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
it('migrates populated v4 without changing any raw row and matches fresh v5', () => {
  const f = fixture(),
    before = contents(f.db)
  f.db.close()
  const result = preparePersistenceUpgrade(f.file, f.config)
  expect(result).toBeDefined()
  const db = new Database(f.file),
    fresh = new Database(':memory:')
  try {
    validateDatabaseVersion(db, 5)
    expect(contents(db)).toEqual(before)
    fresh.exec(SCHEMA_V5)
    const schema = (d: Database.Database) =>
      d
        .prepare(
          "SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT IN ('checkpoints','writes') ORDER BY type,name",
        )
        .all()
    expect(schema(db)).toEqual(schema(fresh))
    expect((schema(db) as { type: string }[]).filter((v) => v.type === 'table')).toHaveLength(30)
    expect((schema(db) as { type: string }[]).filter((v) => v.type === 'index')).toHaveLength(31)
  } finally {
    db.close()
    fresh.close()
  }
})
it('does not relax released v4 JSON validation when live platform enums grow', () => {
  const f = fixture()
  try {
    const row = f.db.prepare('SELECT id,query FROM discovery_runs LIMIT 1').get() as {
      id: string
      query: string
    }
    const query = JSON.parse(row.query)
    query.platforms.push('shixiseng')
    f.db.prepare('UPDATE discovery_runs SET query=? WHERE id=?').run(JSON.stringify(query), row.id)
    expect(() => validateDatabaseVersion(f.db, 4)).toThrow('Invalid persistent platform')
  } finally {
    f.db.close()
  }
})
it('rejects a former development v5 definition without modifying or converting it', () => {
  const f = fixture()
  f.db.exec(
    SCHEMA_V5.slice(SCHEMA_V5.indexOf('CREATE TABLE discovery_jobs_v5')).replaceAll(
      ",'shixiseng'",
      '',
    ),
  )
  f.db.pragma('user_version=5')
  f.db.close()
  const before = fs.readFileSync(f.file)
  expect(() => preparePersistenceUpgrade(f.file, f.config)).toThrow()
  expect(fs.readFileSync(f.file)).toEqual(before)
})
