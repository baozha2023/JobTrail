import type Database from 'better-sqlite3'
import type { CompanyCatalogEntry } from '../company-catalog'

type SqliteDatabase = InstanceType<typeof Database>

export interface CompanyCatalogStateRow {
  format_version: number
  catalog_version: number
  content_sha256: string
  applied_at: number
}

export interface CatalogCompanySnapshot {
  id: number
  name: string
  builtinKey: string | null
  careerUrl: string | null
  industryIds: number[]
  aliases: string[]
}

interface CatalogCompanyRow {
  id: number
  name: string
  builtin_key: string | null
  career_url: string | null
}

export class CompanyCatalogRepository {
  constructor(private readonly db: SqliteDatabase) {}

  state(): CompanyCatalogStateRow {
    return this.db
      .prepare(
        'SELECT format_version, catalog_version, content_sha256, applied_at FROM builtin_company_catalog_state WHERE id = 1',
      )
      .get() as CompanyCatalogStateRow
  }

  builtinIndustryIds(): Set<number> {
    const rows = this.db
      .prepare('SELECT id FROM industries WHERE is_builtin = 1 ORDER BY id')
      .all() as Array<{ id: number }>
    return new Set(rows.map((row) => row.id))
  }

  findByBuiltinKey(builtinKey: string): CatalogCompanySnapshot | undefined {
    return this.snapshot(
      this.db
        .prepare('SELECT id, name, builtin_key, career_url FROM companies WHERE builtin_key = ?')
        .get(builtinKey) as CatalogCompanyRow | undefined,
    )
  }

  findByName(name: string): CatalogCompanySnapshot | undefined {
    return this.snapshot(
      this.db
        .prepare('SELECT id, name, builtin_key, career_url FROM companies WHERE name = ?')
        .get(name) as CatalogCompanyRow | undefined,
    )
  }

  insert(entry: CompanyCatalogEntry, timestamp: number): number {
    this.db
      .prepare(
        'INSERT INTO companies (name, builtin_key, career_url, last_read_at, is_favorite, created_at, updated_at) VALUES (?, ?, ?, NULL, 0, ?, ?)',
      )
      .run(entry.name, entry.builtinKey, entry.careerUrl, timestamp, timestamp)
    const row = this.db.prepare('SELECT id FROM companies WHERE name = ?').get(entry.name) as {
      id: number
    }
    this.replaceRelations(row.id, entry, timestamp)
    return row.id
  }

  replaceCatalogData(companyId: number, entry: CompanyCatalogEntry, timestamp: number): void {
    this.db
      .prepare(
        'UPDATE companies SET name = ?, builtin_key = ?, career_url = ?, updated_at = ? WHERE id = ?',
      )
      .run(entry.name, entry.builtinKey, entry.careerUrl, timestamp, companyId)
    this.replaceRelations(companyId, entry, timestamp)
  }

  updateState(
    formatVersion: number,
    catalogVersion: number,
    hash: string,
    timestamp: number,
  ): void {
    this.db
      .prepare(
        'UPDATE builtin_company_catalog_state SET format_version = ?, catalog_version = ?, content_sha256 = ?, applied_at = ? WHERE id = 1',
      )
      .run(formatVersion, catalogVersion, hash, timestamp)
  }

  private snapshot(row: CatalogCompanyRow | undefined): CatalogCompanySnapshot | undefined {
    if (!row) return undefined
    const industryIds = this.db
      .prepare(
        'SELECT industry_id AS industryId FROM company_industries WHERE company_id = ? ORDER BY industry_id',
      )
      .all(row.id) as Array<{ industryId: number }>
    const aliases = this.db
      .prepare('SELECT alias FROM company_aliases WHERE company_id = ? ORDER BY alias')
      .all(row.id) as Array<{ alias: string }>
    return {
      id: row.id,
      name: row.name,
      builtinKey: row.builtin_key,
      careerUrl: row.career_url,
      industryIds: industryIds.map((item) => item.industryId),
      aliases: aliases.map((item) => item.alias),
    }
  }

  private replaceRelations(companyId: number, entry: CompanyCatalogEntry, timestamp: number): void {
    this.db.prepare('DELETE FROM company_industries WHERE company_id = ?').run(companyId)
    this.db.prepare('DELETE FROM company_aliases WHERE company_id = ?').run(companyId)
    const insertIndustry = this.db.prepare(
      'INSERT INTO company_industries (company_id, industry_id, created_at) VALUES (?, ?, ?)',
    )
    for (const industryId of entry.industryIds) insertIndustry.run(companyId, industryId, timestamp)
    const insertAlias = this.db.prepare(
      'INSERT INTO company_aliases (company_id, alias, created_at) VALUES (?, ?, ?)',
    )
    for (const alias of entry.aliases) insertAlias.run(companyId, alias, timestamp)
  }
}
