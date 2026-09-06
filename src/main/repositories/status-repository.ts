import type Database from 'better-sqlite3'
import type { CreateStatusInput, UpdateStatusInput } from '../../shared/types'
import { mapStatus, type StatusRow } from './row-mappers'

type SqliteDatabase = InstanceType<typeof Database>

export class StatusRepository {
  constructor(private readonly db: SqliteDatabase) {}
  list(): StatusRow[] { return this.db.prepare('SELECT * FROM statuses ORDER BY sort_order, id').all() as StatusRow[] }
  get(id: number): StatusRow | undefined { return this.db.prepare('SELECT * FROM statuses WHERE id = ?').get(id) as StatusRow | undefined }
  maxSortOrder(): number { return (this.db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS max_order FROM statuses').get() as { max_order: number }).max_order }
  create(input: CreateStatusInput, sortOrder: number, timestamp: number): number {
    return this.db.transaction(() => {
      const result = this.db.prepare('INSERT INTO statuses (label, sort_order, is_builtin, created_at, updated_at) VALUES (?, ?, 0, ?, ?)').run(input.label, sortOrder, timestamp, timestamp)
      return result.lastInsertRowid as number
    })()
  }
  update(id: number, input: UpdateStatusInput, timestamp: number): void { this.db.transaction(() => { this.db.prepare('UPDATE statuses SET label = ?, updated_at = ? WHERE id = ?').run(input.label, timestamp, id) })() }
  delete(id: number): number { return this.db.transaction(() => this.db.prepare('DELETE FROM statuses WHERE id = ?').run(id).changes)() }
  count(): number { return (this.db.prepare('SELECT COUNT(*) AS count FROM statuses').get() as { count: number }).count }
  countUsage(id: number): number { return (this.db.prepare('SELECT COUNT(*) AS count FROM opportunities WHERE status_id = ?').get(id) as { count: number }).count }
  reorder(order: number[], timestamp: number): void {
    const update = this.db.prepare('UPDATE statuses SET sort_order = ?, updated_at = ? WHERE id = ?')
    this.db.transaction(() => { order.forEach((id, index) => update.run(index, timestamp, id)) })()
  }
  map(row: StatusRow) { return mapStatus(row) }
}
