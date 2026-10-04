import type Database from 'better-sqlite3'
import type { CompanyCatalogEntry } from '../company-catalog'
import type { CompanyLocationRepository } from './company-location-repository'

export type ResolvedCatalogCompany = Omit<CompanyCatalogEntry, 'industryKeys'> & {
  industryIds: number[]
}

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
  locations: string[]
}

interface CatalogCompanyRow {
  id: number
  name: string
  builtin_key: string | null
  career_url: string | null
}

function changedValues<T extends number | string>(current: T[], next: T[]) {
  const currentSet = new Set(current)
  const nextSet = new Set(next)
  return {
    removed: current.filter((value) => !nextSet.has(value)),
    added: next.filter((value) => !currentSet.has(value)),
  }
}

export class CompanyCatalogRepository {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly locations: CompanyLocationRepository,
  ) {}

  deleteUnusedLocations(ids: number[]): void {
    this.locations.deleteUnused(ids)
  }

  state(): CompanyCatalogStateRow {
    return this.db
      .prepare(
        'SELECT format_version, catalog_version, content_sha256, applied_at FROM builtin_company_catalog_state WHERE id = 1',
      )
      .get() as CompanyCatalogStateRow
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

  insert(entry: ResolvedCatalogCompany, timestamp: number): number {
    this.db
      .prepare(
        'INSERT INTO companies (name, builtin_key, career_url, last_read_at, is_favorite, created_at, updated_at) VALUES (?, ?, ?, NULL, 0, ?, ?)',
      )
      .run(entry.name, entry.builtinKey, entry.careerUrl, timestamp, timestamp)
    const row = this.db.prepare('SELECT id FROM companies WHERE name = ?').get(entry.name) as {
      id: number
    }
    this.syncIndustries(row.id, [], entry.industryIds, timestamp)
    this.syncAliases(row.id, [], entry.aliases, timestamp)
    this.locations.synchronize(row.id, entry.locations, timestamp)
    return row.id
  }

  updateCatalogData(
    current: CatalogCompanySnapshot,
    entry: ResolvedCatalogCompany,
    timestamp: number,
  ): number[] {
    this.db
      .prepare(
        'UPDATE companies SET name = ?, builtin_key = ?, career_url = ?, updated_at = ? WHERE id = ?',
      )
      .run(entry.name, entry.builtinKey, entry.careerUrl, timestamp, current.id)
    this.syncIndustries(current.id, current.industryIds, entry.industryIds, timestamp)
    this.syncAliases(current.id, current.aliases, entry.aliases, timestamp)
    return this.locations.synchronize(current.id, entry.locations, timestamp)
  }

  convertOmittedToCustom(builtinKeys: string[], timestamp: number): number {
    return this.db
      .prepare(
        `UPDATE companies SET builtin_key = NULL, updated_at = ?
         WHERE builtin_key IS NOT NULL
           AND builtin_key NOT IN (SELECT value FROM json_each(?))`,
      )
      .run(timestamp, JSON.stringify(builtinKeys)).changes
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
      locations: this.locations.forCompanies([row.id]).get(row.id) ?? [],
    }
  }

  private syncIndustries(
    companyId: number,
    current: number[],
    next: number[],
    timestamp: number,
  ): void {
    const { removed, added } = changedValues(current, next)
    const replacements = Math.min(removed.length, added.length)
    if (replacements > 0) {
      const update = this.db.prepare(
        'UPDATE company_industries SET industry_id = ? WHERE company_id = ? AND industry_id = ?',
      )
      for (let index = 0; index < replacements; index++)
        update.run(added[index], companyId, removed[index])
    }
    if (removed.length > replacements) {
      const remove = this.db.prepare(
        'DELETE FROM company_industries WHERE company_id = ? AND industry_id = ?',
      )
      for (const industryId of removed.slice(replacements)) remove.run(companyId, industryId)
    }
    if (added.length > replacements) {
      const insert = this.db.prepare(
        'INSERT INTO company_industries (company_id, industry_id, created_at) VALUES (?, ?, ?)',
      )
      for (const industryId of added.slice(replacements))
        insert.run(companyId, industryId, timestamp)
    }
  }

  private syncAliases(
    companyId: number,
    current: string[],
    next: string[],
    timestamp: number,
  ): void {
    const { removed, added } = changedValues(current, next)
    const replacements = Math.min(removed.length, added.length)
    if (replacements > 0) {
      const update = this.db.prepare(
        'UPDATE company_aliases SET alias = ? WHERE company_id = ? AND alias = ?',
      )
      for (let index = 0; index < replacements; index++)
        update.run(added[index], companyId, removed[index])
    }
    if (removed.length > replacements) {
      const remove = this.db.prepare(
        'DELETE FROM company_aliases WHERE company_id = ? AND alias = ?',
      )
      for (const alias of removed.slice(replacements)) remove.run(companyId, alias)
    }
    if (added.length > replacements) {
      const insert = this.db.prepare(
        'INSERT INTO company_aliases (company_id, alias, created_at) VALUES (?, ?, ?)',
      )
      for (const alias of added.slice(replacements)) insert.run(companyId, alias, timestamp)
    }
  }
}
