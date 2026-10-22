import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { afterEach, expect, it } from 'vitest'
import {
  DATABASE_MIGRATIONS,
  preparePersistenceUpgrade,
  validateDatabaseVersion,
} from '../src/main/persistence-migrations'
import { decryptConfig } from '../src/main/config-crypto'
import { SCHEMA_V9 } from '../src/main/persistence/schema-v9'
import { seedDiscoveryV6 } from './helpers/discovery-v6'
import baseline from './fixtures/v8/manifest.json'

const roots: string[] = []
afterEach(() =>
  roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })),
)

function fixture(version: number) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nature-v9-'))
  roots.push(root)
  fs.cpSync(path.resolve(`tests/fixtures/v${version === 1 ? 1 : 2}`), root, { recursive: true })
  const file = path.join(root, 'data/zhiji.db')
  const db = new Database(file)
  for (const step of DATABASE_MIGRATIONS.filter((s) => s.from >= 2 && s.to <= version)) {
    step.apply(db)
    db.pragma(`user_version=${step.to}`)
  }
  if (version >= 6) seedDiscoveryV6(db)
  validateDatabaseVersion(db, version)
  return {
    db,
    file,
    config: decryptConfig(fs.readFileSync(path.join(root, 'config.json'), 'utf8')),
  }
}

const contents = (db: Database.Database) =>
  Object.fromEntries(
    (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map(({ name }) => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]),
  ) as Record<string, Record<string, unknown>[]>

const schema = (db: Database.Database) =>
  db
    .prepare(
      "SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT IN ('checkpoints','writes') ORDER BY type,name",
    )
    .all()

it('pins released v1–v8 schema sources to the v2.6.0 baseline', () => {
  expect(baseline.sourceCommit).toBe('3890679')
  for (const [file, hash] of Object.entries(baseline.files))
    expect(
      createHash('sha256')
        .update(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'))
        .digest('hex'),
    ).toBe(hash)
})

it.each([1, 2, 3, 4, 5, 6, 7, 8])(
  'upgrades v%i preserving original columns, references and catalog state',
  (version) => {
    const f = fixture(version)
    const before = contents(f.db)
    f.db.close()
    const upgraded = preparePersistenceUpgrade(f.file, f.config)
    const db = new Database(f.file)
    const fresh = new Database(':memory:')
    try {
      validateDatabaseVersion(db, 9)
      fresh.exec(SCHEMA_V9)
      expect(schema(db)).toEqual(schema(fresh))
      for (const [table, rows] of Object.entries(before)) {
        const expected =
          table === 'companies'
            ? rows.map((row) => ({ ...row, company_nature: null }))
            : table === 'exam_questions'
              ? rows.map((row) => ({ ...row, default_answer: null }))
              : rows
        expect(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).toEqual(expected)
      }
      expect(db.prepare('SELECT * FROM company_natures ORDER BY sort_order').all()).toEqual(
        fresh.prepare('SELECT * FROM company_natures ORDER BY sort_order').all(),
      )
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('checkpoints','writes')",
          )
          .all(),
      ).toHaveLength(31)
      const snapshot = contents(db)
      db.close()
      preparePersistenceUpgrade(f.file, upgraded.config)
      const reopened = new Database(f.file)
      try {
        expect(contents(reopened)).toEqual(snapshot)
      } finally {
        reopened.close()
      }
    } finally {
      if (db.open) db.close()
      fresh.close()
    }
  },
)

it('rolls back the dictionary, added columns and version after an injected migration failure', () => {
  const f = fixture(8)
  const before = contents(f.db),
    ddl = schema(f.db)
  f.db.close()
  const step = DATABASE_MIGRATIONS.find((s) => s.from === 8)!
  const apply = step.apply
  step.apply = (db) => {
    apply(db)
    throw new Error('v9 migration failure')
  }
  try {
    expect(() => preparePersistenceUpgrade(f.file, f.config)).toThrow('v9 migration failure')
  } finally {
    step.apply = apply
  }
  const db = new Database(f.file)
  try {
    validateDatabaseVersion(db, 8)
    expect(schema(db)).toEqual(ddl)
    expect(contents(db)).toEqual(before)
  } finally {
    db.close()
  }
})
