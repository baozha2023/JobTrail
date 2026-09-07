import type Database from 'better-sqlite3'
import type { Company, CreateCompanyInput, UpdateCompanyInput } from '../../shared/types'
import { mapCompany, type CompanyAliasRow, type CompanyRow } from './row-mappers'
import { containsLikePattern } from './sql'

type SqliteDatabase = InstanceType<typeof Database>

const COMPANY_SELECT = 'SELECT c.*, NULL AS industry_name FROM companies c'

interface CompanyIndustryRow {
  company_id: number
  industry_id: number
  industry_name: string
}

export class CompanyRepository {
  constructor(private readonly db: SqliteDatabase) {}

  search(keyword: string): CompanyRow[] {
    if (!keyword) return this.list()
    const value = containsLikePattern(keyword)
    return this.db
      .prepare(
        `${COMPANY_SELECT}
      WHERE c.name LIKE ? ESCAPE '\\' OR EXISTS (
        SELECT 1
        FROM company_industries ci
        JOIN industries i ON i.id = ci.industry_id
        WHERE ci.company_id = c.id AND i.name LIKE ? ESCAPE '\\'
      )
        OR EXISTS (SELECT 1 FROM company_aliases a WHERE a.company_id = c.id AND a.alias LIKE ? ESCAPE '\\')
      ORDER BY c.is_favorite DESC, c.name ASC
    `,
      )
      .all(value, value, value) as CompanyRow[]
  }

  list(): CompanyRow[] {
    return this.db
      .prepare(
        `${COMPANY_SELECT}
      ORDER BY c.is_favorite DESC, c.name ASC
    `,
      )
      .all() as CompanyRow[]
  }

  get(id: number): CompanyRow | undefined {
    return this.db
      .prepare(
        `${COMPANY_SELECT}
      WHERE c.id = ?
    `,
      )
      .get(id) as CompanyRow | undefined
  }

  aliases(companyId: number): CompanyAliasRow[] {
    return this.db
      .prepare('SELECT * FROM company_aliases WHERE company_id = ? ORDER BY alias')
      .all(companyId) as CompanyAliasRow[]
  }

  industries(companyId: number): CompanyIndustryRow[] {
    return this.db
      .prepare(
        `
      SELECT ci.company_id, ci.industry_id, i.name AS industry_name
      FROM company_industries ci
      JOIN industries i ON i.id = ci.industry_id
      WHERE ci.company_id = ?
      ORDER BY i.sort_order, i.id
    `,
      )
      .all(companyId) as CompanyIndustryRow[]
  }

  mapMany(rows: CompanyRow[]): Company[] {
    if (rows.length === 0) return []
    const companyIds = JSON.stringify(rows.map((row) => row.id))
    const aliases = this.db
      .prepare(
        `
      SELECT company_id, alias
      FROM company_aliases
      WHERE company_id IN (SELECT value FROM json_each(?))
      ORDER BY company_id, alias
    `,
      )
      .all(companyIds) as Array<Pick<CompanyAliasRow, 'company_id' | 'alias'>>
    const industries = this.db
      .prepare(
        `
      SELECT ci.company_id, ci.industry_id, i.name AS industry_name
      FROM company_industries ci
      JOIN industries i ON i.id = ci.industry_id
      WHERE ci.company_id IN (SELECT value FROM json_each(?))
      ORDER BY ci.company_id, i.sort_order, i.id
    `,
      )
      .all(companyIds) as CompanyIndustryRow[]
    const aliasesByCompany = new Map<number, string[]>()
    const industriesByCompany = new Map<number, number[]>()
    const industryNamesByCompany = new Map<number, string[]>()
    for (const alias of aliases) {
      const values = aliasesByCompany.get(alias.company_id) ?? []
      values.push(alias.alias)
      aliasesByCompany.set(alias.company_id, values)
    }
    for (const industry of industries) {
      const values = industriesByCompany.get(industry.company_id) ?? []
      values.push(industry.industry_id)
      industriesByCompany.set(industry.company_id, values)
      const names = industryNamesByCompany.get(industry.company_id) ?? []
      names.push(industry.industry_name)
      industryNamesByCompany.set(industry.company_id, names)
    }
    return rows.map((row) =>
      mapCompany(
        { ...row, industry_name: industryNamesByCompany.get(row.id)?.join(', ') ?? null },
        aliasesByCompany.get(row.id) ?? [],
        industriesByCompany.get(row.id) ?? [],
      ),
    )
  }

  create(input: CreateCompanyInput, timestamp: number): number {
    return this.db.transaction(() => {
      const result = this.db
        .prepare(
          `
        INSERT INTO companies (name, career_url, last_read_at, is_builtin, is_favorite, created_at, updated_at)
        VALUES (?, ?, NULL, 0, 0, ?, ?)
      `,
        )
        .run(input.name, input.careerUrl ?? null, timestamp, timestamp)
      const id = result.lastInsertRowid as number
      this.replaceIndustries(id, input.industryIds ?? [], timestamp)
      this.replaceAliases(id, input.aliases ?? [], timestamp)
      return id
    })()
  }

  update(id: number, input: UpdateCompanyInput, timestamp: number): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `
        UPDATE companies SET name = ?, career_url = ?, is_favorite = ?, updated_at = ? WHERE id = ?
      `,
        )
        .run(input.name, input.careerUrl ?? null, input.isFavorite ? 1 : 0, timestamp, id)
      if (input.industryIds !== undefined) this.replaceIndustries(id, input.industryIds, timestamp)
      if (input.aliases !== undefined) this.replaceAliases(id, input.aliases, timestamp)
    })()
  }

  markRead(id: number, timestamp: number): number {
    return this.db.transaction(
      () =>
        this.db
          .prepare('UPDATE companies SET last_read_at = ?, updated_at = ? WHERE id = ?')
          .run(timestamp, timestamp, id).changes,
    )()
  }

  delete(id: number): number {
    return this.db.transaction(() => {
      this.db.prepare('DELETE FROM company_industries WHERE company_id = ?').run(id)
      this.db.prepare('DELETE FROM company_aliases WHERE company_id = ?').run(id)
      return this.db.prepare('DELETE FROM companies WHERE id = ?').run(id).changes
    })()
  }

  countUsage(id: number): number {
    return (
      this.db
        .prepare('SELECT COUNT(*) AS count FROM opportunities WHERE company_id = ?')
        .get(id) as { count: number }
    ).count
  }

  private replaceIndustries(companyId: number, industryIds: number[], timestamp: number): void {
    this.db.prepare('DELETE FROM company_industries WHERE company_id = ?').run(companyId)
    const insert = this.db.prepare(
      'INSERT INTO company_industries (company_id, industry_id, created_at) VALUES (?, ?, ?)',
    )
    industryIds.forEach((industryId) => insert.run(companyId, industryId, timestamp))
  }

  private replaceAliases(companyId: number, aliases: string[], timestamp: number): void {
    this.db.prepare('DELETE FROM company_aliases WHERE company_id = ?').run(companyId)
    const insert = this.db.prepare(
      'INSERT INTO company_aliases (company_id, alias, created_at) VALUES (?, ?, ?)',
    )
    aliases.forEach((alias) => insert.run(companyId, alias, timestamp))
  }

  map(row: CompanyRow) {
    const industries = this.industries(row.id)
    return mapCompany(
      {
        ...row,
        industry_name: industries.map((industry) => industry.industry_name).join(', ') || null,
      },
      this.aliases(row.id).map((alias) => alias.alias),
      industries.map((industry) => industry.industry_id),
    )
  }
}
