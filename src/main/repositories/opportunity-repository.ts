import type Database from 'better-sqlite3'
import type { CreateOpportunityInput, OpportunityQuery, UpdateOpportunityInput } from '../../shared/types'
import { mapOpportunity, type OpportunityRow } from './row-mappers'

type SqliteDatabase = InstanceType<typeof Database>

const SELECT = `
  SELECT o.*, c.name AS company_name, s.label AS status_label, r.name AS resume_version_name
  FROM opportunities o
  JOIN companies c ON c.id = o.company_id
  JOIN statuses s ON s.id = o.status_id
  LEFT JOIN resume_versions r ON r.id = o.resume_version_id
`

export class OpportunityRepository {
  constructor(private readonly db: SqliteDatabase) {}
  list(query: OpportunityQuery): OpportunityRow[] {
    const clauses: string[] = []
    const params: Array<string | number> = []
    if (query.search) {
      const value = `%${query.search}%`
      clauses.push('(c.name LIKE ? OR EXISTS (SELECT 1 FROM company_aliases a WHERE a.company_id = c.id AND a.alias LIKE ?) OR o.title LIKE ? OR COALESCE(o.source, \'\') LIKE ? OR COALESCE(o.notes, \'\') LIKE ?)')
      params.push(value, value, value, value, value)
    }
    if (query.statusId !== null && query.statusId !== undefined) { clauses.push('o.status_id = ?'); params.push(query.statusId) }
    if (query.companyId !== null && query.companyId !== undefined) { clauses.push('o.company_id = ?'); params.push(query.companyId) }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : ''
    return this.db.prepare(`${SELECT}${where} ORDER BY COALESCE(o.deadline_at, 9223372036854775807), o.updated_at DESC`).all(...params) as OpportunityRow[]
  }
  get(id: number): OpportunityRow | undefined { return this.db.prepare(`${SELECT} WHERE o.id = ?`).get(id) as OpportunityRow | undefined }
  create(input: CreateOpportunityInput, timestamp: number): number {
    return this.db.transaction(() => {
      const result = this.db.prepare(`
        INSERT INTO opportunities (company_id, title, department, location, source, job_url, description, status_id, resume_version_id, discovered_at, applied_at, deadline_at, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(input.companyId, input.title, input.department ?? null, input.location ?? null, input.source ?? null, input.jobUrl ?? null, input.description ?? null, input.statusId, input.resumeVersionId ?? null, input.discoveredAt ?? null, input.appliedAt ?? null, input.deadlineAt ?? null, input.notes ?? null, timestamp, timestamp)
      return result.lastInsertRowid as number
    })()
  }
  update(id: number, input: CreateOpportunityInput, timestamp: number): void {
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE opportunities SET company_id = ?, title = ?, department = ?, location = ?, source = ?, job_url = ?, description = ?, status_id = ?, resume_version_id = ?, discovered_at = ?, applied_at = ?, deadline_at = ?, notes = ?, updated_at = ? WHERE id = ?
      `).run(input.companyId, input.title, input.department ?? null, input.location ?? null, input.source ?? null, input.jobUrl ?? null, input.description ?? null, input.statusId, input.resumeVersionId ?? null, input.discoveredAt ?? null, input.appliedAt ?? null, input.deadlineAt ?? null, input.notes ?? null, timestamp, id)
    })()
  }
  changeStatus(id: number, statusId: number, timestamp: number): void { this.db.transaction(() => { this.db.prepare('UPDATE opportunities SET status_id = ?, updated_at = ? WHERE id = ?').run(statusId, timestamp, id) })() }
  delete(id: number): number {
    return this.db.transaction(() => {
      const changes = this.db.prepare('DELETE FROM opportunities WHERE id = ?').run(id).changes
      this.db.prepare('UPDATE calendar_events SET opportunity_id = NULL, updated_at = ? WHERE opportunity_id = ?').run(Date.now(), id)
      return changes
    })()
  }
  map(row: OpportunityRow) { return mapOpportunity(row) }
}
