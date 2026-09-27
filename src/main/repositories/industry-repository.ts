import type Database from 'better-sqlite3'
import type { CreateIndustryInput } from '../../shared/types'
import type { CompanyCatalogDocument } from '../company-catalog'
import { AppServiceError } from '../services/errors'
import { mapIndustry, type IndustryRow } from './row-mappers'

type SqliteDatabase = InstanceType<typeof Database>

export class IndustryRepository {
  constructor(private readonly db: SqliteDatabase) {}
  list(): IndustryRow[] {
    return this.db
      .prepare(
        `SELECT i.* FROM industries i LEFT JOIN industries p ON p.id = i.parent_id
      ORDER BY COALESCE(p.sort_order, i.sort_order), COALESCE(p.id, i.id),
        i.parent_id IS NOT NULL, i.sort_order, i.id`,
      )
      .all() as IndustryRow[]
  }
  get(id: number): IndustryRow | undefined {
    return this.db.prepare('SELECT * FROM industries WHERE id = ?').get(id) as
      | IndustryRow
      | undefined
  }
  siblings(parentId: number | null): IndustryRow[] {
    return this.db
      .prepare('SELECT * FROM industries WHERE parent_id IS ? ORDER BY sort_order, id')
      .all(parentId) as IndustryRow[]
  }
  private nextOrder(parentId: number | null): number {
    return (
      this.db
        .prepare(
          'SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM industries WHERE parent_id IS ?',
        )
        .get(parentId) as { n: number }
    ).n
  }
  create(input: CreateIndustryInput, timestamp: number): number {
    return Number(
      this.db
        .prepare(
          'INSERT INTO industries (name, parent_id, builtin_key, sort_order, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?)',
        )
        .run(input.name, input.parentId, this.nextOrder(input.parentId), timestamp, timestamp)
        .lastInsertRowid,
    )
  }
  update(current: IndustryRow, name: string, parentId: number | null, timestamp: number): void {
    const moved = parentId !== current.parent_id
    this.db
      .prepare(
        'UPDATE industries SET name = ?, parent_id = ?, sort_order = ?, updated_at = ? WHERE id = ?',
      )
      .run(
        name,
        parentId,
        moved ? this.nextOrder(parentId) : current.sort_order,
        timestamp,
        current.id,
      )
    if (moved) {
      this.reorder(
        this.siblings(current.parent_id).map((row) => row.id),
        timestamp,
      )
      this.reorder(
        this.siblings(parentId).map((row) => row.id),
        timestamp,
      )
    }
  }
  delete(id: number): number {
    return this.db.prepare('DELETE FROM industries WHERE id = ?').run(id).changes
  }
  countUsage(id: number): number {
    return (
      this.db
        .prepare('SELECT COUNT(*) AS count FROM company_industries WHERE industry_id = ?')
        .get(id) as { count: number }
    ).count
  }
  reorder(order: number[], timestamp: number): void {
    const update = this.db.prepare(
      'UPDATE industries SET sort_order = ?, updated_at = ? WHERE id = ?',
    )
    order.forEach((id, index) => update.run(index, timestamp, id))
  }
  // Caller owns the seed/catalog transaction; remote keys never prescribe local IDs.
  synchronize(
    entries: CompanyCatalogDocument['industries'],
    timestamp: number,
  ): Map<string, number> {
    const ids = new Map<string, number>()
    const ordered = [
      ...entries.filter((item) => item.parentKey === null),
      ...entries.filter((item) => item.parentKey !== null),
    ]
    for (const entry of ordered) {
      const parentId = entry.parentKey === null ? null : ids.get(entry.parentKey)
      if (parentId === undefined) throw new AppServiceError('CATALOG_INVALID', '行业目录父节点无效')
      const current = this.db
        .prepare('SELECT * FROM industries WHERE builtin_key = ?')
        .get(entry.builtinKey) as IndustryRow | undefined
      if (current) {
        if ((current.parent_id === null) !== (parentId === null))
          throw new AppServiceError('CATALOG_INVALID', '行业目录不能改变节点层级')
        if (current.name !== entry.name || current.parent_id !== parentId)
          this.update(current, entry.name, parentId, timestamp)
        ids.set(entry.builtinKey, current.id)
      } else {
        const result = this.db
          .prepare(
            'INSERT INTO industries (name, parent_id, builtin_key, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run(
            entry.name,
            parentId,
            entry.builtinKey,
            this.nextOrder(parentId),
            timestamp,
            timestamp,
          )
        ids.set(entry.builtinKey, Number(result.lastInsertRowid))
      }
    }
    return ids
  }
  map(row: IndustryRow) {
    return mapIndustry(row)
  }
}
