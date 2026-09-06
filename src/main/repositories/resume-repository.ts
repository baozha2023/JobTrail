import type Database from 'better-sqlite3'
import type { UpdateResumeVersionInput } from '../../shared/types'
import { mapResume, type ResumeRow } from './row-mappers'

type SqliteDatabase = InstanceType<typeof Database>

export class ResumeRepository {
  constructor(private readonly db: SqliteDatabase) {}
  list(): ResumeRow[] { return this.db.prepare('SELECT * FROM resume_versions ORDER BY sort_order, id').all() as ResumeRow[] }
  get(id: number): ResumeRow | undefined { return this.db.prepare('SELECT * FROM resume_versions WHERE id = ?').get(id) as ResumeRow | undefined }
  maxSortOrder(): number { return (this.db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS max_order FROM resume_versions').get() as { max_order: number }).max_order }
  create(name: string, relativePath: string, sizeBytes: number, sha256: string, note: string | null, sortOrder: number, timestamp: number): number {
    return this.db.transaction(() => {
      const result = this.db.prepare(`
        INSERT INTO resume_versions (name, relative_path, size_bytes, sha256, note, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(name, relativePath, sizeBytes, sha256, note, sortOrder, timestamp, timestamp)
      return result.lastInsertRowid as number
    })()
  }
  update(id: number, input: UpdateResumeVersionInput, current: ResumeRow, timestamp: number): void {
    this.db.transaction(() => {
      this.db.prepare('UPDATE resume_versions SET name = ?, note = ?, updated_at = ? WHERE id = ?').run(
        input.name ?? current.name,
        input.note === undefined ? current.note : input.note,
        timestamp,
        id,
      )
    })()
  }
  reorder(order: number[], timestamp: number): void {
    const update = this.db.prepare('UPDATE resume_versions SET sort_order = ?, updated_at = ? WHERE id = ?')
    this.db.transaction(() => { order.forEach((id, index) => update.run(index, timestamp, id)) })()
  }
  delete(id: number): number { return this.db.transaction(() => this.db.prepare('DELETE FROM resume_versions WHERE id = ?').run(id).changes)() }
  countUsage(id: number): number { return (this.db.prepare('SELECT COUNT(*) AS count FROM opportunities WHERE resume_version_id = ?').get(id) as { count: number }).count }
  map(row: ResumeRow) { return mapResume(row) }
}
