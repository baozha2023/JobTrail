import type Database from 'better-sqlite3'
import type { CompanyLocationQuery, PageResult } from '../../shared/types'

type Db = InstanceType<typeof Database>

export class CompanyLocationRepository {
  constructor(private readonly db: Db) {}

  search(query: CompanyLocationQuery): PageResult<string> {
    const prefix = query.prefix ?? ''
    const where = prefix ? " WHERE name LIKE ? ESCAPE '\\'" : ''
    const params = prefix ? [prefix.replace(/[\\%_]/g, '\\$&') + '%'] : []
    return this.db.transaction(() => {
      const total = (
        this.db.prepare(`SELECT COUNT(*) AS count FROM locations${where}`).get(...params) as {
          count: number
        }
      ).count
      const rows = this.db
        .prepare(
          `SELECT name FROM locations${where}
           ORDER BY name COLLATE NOCASE, id LIMIT ? OFFSET ?`,
        )
        .all(...params, query.pageSize, (query.page - 1) * query.pageSize) as { name: string }[]
      return {
        items: rows.map((row) => row.name),
        total,
        page: query.page,
        pageSize: query.pageSize,
      }
    })()
  }

  forCompanies(companyIds: number[]): Map<number, string[]> {
    const result = new Map<number, string[]>()
    if (!companyIds.length) return result
    const rows = this.db
      .prepare(
        `
      SELECT cl.company_id, l.name FROM company_locations cl
      JOIN locations l ON l.id = cl.location_id
      WHERE cl.company_id IN (SELECT value FROM json_each(?))
      ORDER BY cl.company_id, l.name
    `,
      )
      .all(JSON.stringify(companyIds)) as { company_id: number; name: string }[]
    for (const row of rows) {
      const values = result.get(row.company_id) ?? []
      values.push(row.name)
      result.set(row.company_id, values)
    }
    return result
  }

  // The caller owns the transaction and defers orphan cleanup until the complete
  // operation (including all companies in a catalog update) has established links.
  synchronize(companyId: number, names: string[], timestamp: number): number[] {
    const current = this.db
      .prepare(
        `
      SELECT l.id, l.name FROM company_locations cl
      JOIN locations l ON l.id = cl.location_id WHERE cl.company_id = ?
    `,
      )
      .all(companyId) as { id: number; name: string }[]
    const next = new Set(names)
    const existing = new Set(current.map((row) => row.name))
    const removed = current.filter((row) => !next.has(row.name)).map((row) => row.id)
    const remove = this.db.prepare(
      'DELETE FROM company_locations WHERE company_id = ? AND location_id = ?',
    )
    for (const id of removed) remove.run(companyId, id)
    const create = this.db.prepare(
      'INSERT INTO locations (name, created_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING',
    )
    const find = this.db.prepare('SELECT id FROM locations WHERE name = ?')
    const link = this.db.prepare(
      'INSERT INTO company_locations (company_id, location_id, created_at) VALUES (?, ?, ?)',
    )
    for (const name of next) {
      if (existing.has(name)) continue
      create.run(name, timestamp)
      const { id } = find.get(name) as { id: number }
      link.run(companyId, id, timestamp)
    }
    return removed
  }

  deleteUnused(ids: number[]): void {
    if (!ids.length) return
    this.db
      .prepare(
        `
      DELETE FROM locations WHERE id IN (SELECT value FROM json_each(?))
      AND NOT EXISTS (SELECT 1 FROM company_locations cl WHERE cl.location_id = locations.id)
    `,
      )
      .run(JSON.stringify([...new Set(ids)]))
  }
}
