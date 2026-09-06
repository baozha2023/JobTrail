import type Database from 'better-sqlite3'
import type { CreateCompanyInput, UpdateCompanyInput } from '../../shared/types'
import { mapCompany, type CompanyAliasRow, type CompanyRow } from './row-mappers'

type SqliteDatabase = InstanceType<typeof Database>

const COMPANY_SELECT = `
  SELECT c.*,
    (
      SELECT group_concat(name, ', ')
      FROM (
        SELECT i.name
        FROM company_industries ci
        JOIN industries i ON i.id = ci.industry_id
        WHERE ci.company_id = c.id
        ORDER BY i.sort_order, i.id
      )
    ) AS industry_name
  FROM companies c
`

export class CompanyRepository {
  constructor(private readonly db: SqliteDatabase) {}

  search(keyword: string): CompanyRow[] {
    const value = `%${keyword}%`
    return this.db.prepare(`${COMPANY_SELECT}
      WHERE ? = '%%' OR c.name LIKE ? OR EXISTS (
        SELECT 1
        FROM company_industries ci
        JOIN industries i ON i.id = ci.industry_id
        WHERE ci.company_id = c.id AND i.name LIKE ?
      )
        OR EXISTS (SELECT 1 FROM company_aliases a WHERE a.company_id = c.id AND a.alias LIKE ?)
      ORDER BY c.is_favorite DESC, c.name ASC
    `).all(value, value, value, value) as CompanyRow[]
  }

  list(): CompanyRow[] {
    return this.db.prepare(`${COMPANY_SELECT}
      ORDER BY c.is_favorite DESC, c.name ASC
    `).all() as CompanyRow[]
  }

  get(id: number): CompanyRow | undefined {
    return this.db.prepare(`${COMPANY_SELECT}
      WHERE c.id = ?
    `).get(id) as CompanyRow | undefined
  }

  aliases(companyId: number): CompanyAliasRow[] {
    return this.db.prepare('SELECT * FROM company_aliases WHERE company_id = ? ORDER BY alias').all(companyId) as CompanyAliasRow[]
  }

  industryIds(companyId: number): number[] {
    return (this.db.prepare(`
      SELECT ci.industry_id
      FROM company_industries ci
      JOIN industries i ON i.id = ci.industry_id
      WHERE ci.company_id = ?
      ORDER BY i.sort_order, i.id
    `).all(companyId) as Array<{ industry_id: number }>).map((item) => item.industry_id)
  }

  create(input: CreateCompanyInput, timestamp: number): number {
    return this.db.transaction(() => {
      const result = this.db.prepare(`
        INSERT INTO companies (name, career_url, last_read_at, is_builtin, is_favorite, created_at, updated_at)
        VALUES (?, ?, NULL, 0, 0, ?, ?)
      `).run(input.name, input.careerUrl ?? null, timestamp, timestamp)
      const id = result.lastInsertRowid as number
      this.replaceIndustries(id, input.industryIds ?? [], timestamp)
      this.replaceAliases(id, input.aliases ?? [], timestamp)
      return id
    })()
  }

  update(id: number, input: UpdateCompanyInput, timestamp: number): void {
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE companies SET name = ?, career_url = ?, is_favorite = ?, updated_at = ? WHERE id = ?
      `).run(input.name, input.careerUrl ?? null, input.isFavorite ? 1 : 0, timestamp, id)
      if (input.industryIds !== undefined) this.replaceIndustries(id, input.industryIds, timestamp)
      if (input.aliases !== undefined) this.replaceAliases(id, input.aliases, timestamp)
    })()
  }

  markRead(id: number, timestamp: number): number {
    return this.db.prepare('UPDATE companies SET last_read_at = ?, updated_at = ? WHERE id = ?').run(timestamp, timestamp, id).changes
  }

  delete(id: number): number {
    return this.db.transaction(() => {
      this.db.prepare('DELETE FROM company_industries WHERE company_id = ?').run(id)
      this.db.prepare('DELETE FROM company_aliases WHERE company_id = ?').run(id)
      return this.db.prepare('DELETE FROM companies WHERE id = ?').run(id).changes
    })()
  }

  countUsage(id: number): number { return (this.db.prepare('SELECT COUNT(*) AS count FROM opportunities WHERE company_id = ?').get(id) as { count: number }).count }

  private replaceIndustries(companyId: number, industryIds: number[], timestamp: number): void {
    this.db.prepare('DELETE FROM company_industries WHERE company_id = ?').run(companyId)
    const insert = this.db.prepare('INSERT INTO company_industries (company_id, industry_id, created_at) VALUES (?, ?, ?)')
    industryIds.forEach((industryId) => insert.run(companyId, industryId, timestamp))
  }

  private replaceAliases(companyId: number, aliases: string[], timestamp: number): void {
    this.db.prepare('DELETE FROM company_aliases WHERE company_id = ?').run(companyId)
    const insert = this.db.prepare('INSERT INTO company_aliases (company_id, alias, created_at) VALUES (?, ?, ?)')
    aliases.forEach((alias) => insert.run(companyId, alias, timestamp))
  }

  map(row: CompanyRow) { return mapCompany(row, this.aliases(row.id).map((alias) => alias.alias), this.industryIds(row.id)) }
}
