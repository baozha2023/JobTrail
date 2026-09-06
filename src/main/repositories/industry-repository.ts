import type Database from 'better-sqlite3'
import type { CreateIndustryInput, UpdateIndustryInput } from '../../shared/types'
import { mapIndustry, type IndustryRow } from './row-mappers'

type SqliteDatabase = InstanceType<typeof Database>

export class IndustryRepository {
  constructor(private readonly db: SqliteDatabase) {}
  list(): IndustryRow[] { return this.db.prepare('SELECT * FROM industries ORDER BY sort_order, id').all() as IndustryRow[] }
  get(id: number): IndustryRow | undefined { return this.db.prepare('SELECT * FROM industries WHERE id = ?').get(id) as IndustryRow | undefined }
  maxSortOrder(): number { return (this.db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS max_order FROM industries').get() as { max_order: number }).max_order }
  create(input: CreateIndustryInput, sortOrder: number, timestamp: number): number {
    return this.db.transaction(() => {
      const result = this.db.prepare('INSERT INTO industries (name, sort_order, is_builtin, created_at, updated_at) VALUES (?, ?, 0, ?, ?)').run(input.name, sortOrder, timestamp, timestamp)
      return result.lastInsertRowid as number
    })()
  }
  update(id: number, input: UpdateIndustryInput, timestamp: number): void { this.db.transaction(() => { this.db.prepare('UPDATE industries SET name = ?, updated_at = ? WHERE id = ?').run(input.name, timestamp, id) })() }
  delete(id: number): number { return this.db.transaction(() => this.db.prepare('DELETE FROM industries WHERE id = ?').run(id).changes)() }
  countUsage(id: number): number { return (this.db.prepare('SELECT COUNT(*) AS count FROM company_industries WHERE industry_id = ?').get(id) as { count: number }).count }
  reorder(order: number[], timestamp: number): void {
    const update = this.db.prepare('UPDATE industries SET sort_order = ?, updated_at = ? WHERE id = ?')
    this.db.transaction(() => { order.forEach((id, index) => update.run(index, timestamp, id)) })()
  }
  map(row: IndustryRow) { return mapIndustry(row) }
}
