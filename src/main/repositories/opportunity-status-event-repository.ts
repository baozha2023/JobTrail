import type Database from 'better-sqlite3'
import type { OpportunityStatusEvent, OpportunityStatusEventKind } from '../../shared/types'
import { mapOpportunityStatusEvent, type OpportunityStatusEventRow } from './row-mappers'

type SqliteDatabase = InstanceType<typeof Database>

export class OpportunityStatusEventRepository {
  constructor(private readonly db: SqliteDatabase) {}

  list(opportunityId: number): OpportunityStatusEvent[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM opportunity_status_events WHERE opportunity_id = ? ORDER BY occurred_at, id',
      )
      .all(opportunityId) as OpportunityStatusEventRow[]
    return rows.map(mapOpportunityStatusEvent)
  }

  create(
    opportunityId: number,
    statusId: number,
    statusLabel: string,
    occurredAt: number,
    kind: OpportunityStatusEventKind,
  ): void {
    this.db
      .prepare(
        'INSERT INTO opportunity_status_events (opportunity_id, status_id, status_label, occurred_at, kind) VALUES (?, ?, ?, ?, ?)',
      )
      .run(opportunityId, statusId, statusLabel, occurredAt, kind)
  }

  deleteForOpportunity(opportunityId: number): void {
    this.db
      .prepare('DELETE FROM opportunity_status_events WHERE opportunity_id = ?')
      .run(opportunityId)
  }
}
