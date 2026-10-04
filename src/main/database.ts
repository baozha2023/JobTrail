import { validateDatabaseVersion } from './persistence/validation'
import { SCHEMA_V3 } from './persistence/schema-v3'
import { CompanyLocationRepository } from './repositories/company-location-repository'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import type { AppPaths } from './config'
import { IndustryRepository } from './repositories/industry-repository'
import { BUNDLED_COMPANY_CATALOG, BUNDLED_COMPANY_CATALOG_HASH } from './company-catalog'

type SqliteDatabase = InstanceType<typeof Database>
export { TARGET_DATABASE_VERSION as DB_SCHEMA_VERSION } from './persistence/versions'
import { TARGET_DATABASE_VERSION as DB_SCHEMA_VERSION } from './persistence/versions'
export const INCOMPATIBLE_DATA_EXIT_CODE = 78

export { DatabaseVersionError } from './persistence/versions'
import { DatabaseVersionError } from './persistence/versions'

const DEFAULT_STATUSES = [
  '感兴趣',
  '待投递',
  '已投递',
  '初筛',
  '笔试',
  'AI面试',
  '一面',
  '二面',
  '三面',
  'HR面',
  'Offer',
  '淘汰',
  '主动放弃',
]

export class DatabaseManager {
  readonly db: SqliteDatabase

  constructor(paths: AppPaths) {
    fs.mkdirSync(path.dirname(paths.database), { recursive: true })
    this.db = new Database(paths.database)
    try {
      const version = this.db.pragma('user_version', { simple: true }) as number
      if (version !== 0 && version !== DB_SCHEMA_VERSION) throw new DatabaseVersionError(version)
      this.db.pragma('journal_mode = WAL')
      this.db.pragma('busy_timeout = 5000')
      this.db.transaction(() => this.initialize()).immediate()
      validateDatabaseVersion(this.db, DB_SCHEMA_VERSION)
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  close(): void {
    this.db.close()
  }

  async snapshotForUpdate(destination: string): Promise<void> {
    // SQLite's online backup includes committed WAL content in one consistent image.
    await this.db.backup(destination)
  }

  dataVersion(): number {
    return this.db.pragma('data_version', { simple: true }) as number
  }

  private initialize(): void {
    const version = this.db.pragma('user_version', { simple: true }) as number
    if (version === DB_SCHEMA_VERSION) return
    if (version !== 0) throw new DatabaseVersionError(version)
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get())
      throw new DatabaseVersionError(0)

    this.db.exec(SCHEMA_V3)

    this.seed()
  }

  private seed(): void {
    const now = Date.now()
    const locations = new CompanyLocationRepository(this.db)
    const insertCompany = this.db.prepare(`
      INSERT INTO companies (name, builtin_key, career_url, is_favorite, created_at, updated_at)
      VALUES (?, ?, ?, 0, ?, ?)
    `)
    const getCompanyId = this.db.prepare('SELECT id FROM companies WHERE name = ?')
    const addIndustry = this.db.prepare(`
      INSERT INTO company_industries (company_id, industry_id, created_at)
      VALUES (?, ?, ?)
    `)
    const addAlias = this.db.prepare(`
      INSERT INTO company_aliases (company_id, alias, created_at)
      VALUES (?, ?, ?)
    `)
    const seedTransaction = this.db.transaction(() => {
      const insertStatus = this.db.prepare(
        'INSERT INTO statuses (id, label, sort_order, is_builtin, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)',
      )
      DEFAULT_STATUSES.forEach((label, index) =>
        insertStatus.run(index + 1, label, index + 1, now, now),
      )
      const industryIds = new IndustryRepository(this.db).synchronize(
        BUNDLED_COMPANY_CATALOG.industries,
        now,
      )
      for (const companySeed of BUNDLED_COMPANY_CATALOG.companies) {
        insertCompany.run(companySeed.name, companySeed.builtinKey, companySeed.careerUrl, now, now)
        const { id: companyId } = getCompanyId.get(companySeed.name) as { id: number }
        locations.synchronize(companyId, companySeed.locations, now)
        for (const industryKey of companySeed.industryKeys)
          addIndustry.run(companyId, industryIds.get(industryKey)!, now)
        for (const alias of companySeed.aliases) addAlias.run(companyId, alias, now)
      }
      this.db
        .prepare(
          'INSERT INTO builtin_company_catalog_state (id, format_version, catalog_version, content_sha256, applied_at) VALUES (1, ?, ?, ?, ?)',
        )
        .run(
          BUNDLED_COMPANY_CATALOG.formatVersion,
          BUNDLED_COMPANY_CATALOG.catalogVersion,
          BUNDLED_COMPANY_CATALOG_HASH,
          now,
        )
      // Commit the seed data and its schema marker atomically. Otherwise a
      // process interruption between the two writes leaves a populated v0
      // database that cannot be initialized on the next launch.
      this.db.pragma(`user_version = ${DB_SCHEMA_VERSION}`)
    })
    seedTransaction()
  }
}
