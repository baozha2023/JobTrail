import type Database from 'better-sqlite3'
import type { CreateCalendarEventInput, CalendarRange } from '../../shared/types'
import { mapCalendarEvent, type CalendarEventRow } from './row-mappers'

type SqliteDatabase = InstanceType<typeof Database>
const SELECT = `
  SELECT e.*, o.title AS opportunity_title, o.job_url AS opportunity_job_url, c.name AS company_name
  FROM calendar_events e
  LEFT JOIN opportunities o ON o.id = e.opportunity_id
  LEFT JOIN companies c ON c.id = o.company_id
`

export class CalendarEventRepository {
  constructor(private readonly db: SqliteDatabase) {}
  list(range: CalendarRange): CalendarEventRow[] { return this.db.prepare(`${SELECT} WHERE e.start_at < ? AND e.end_at > ? ORDER BY e.start_at, e.id`).all(range.endAt, range.startAt) as CalendarEventRow[] }
  get(id: number): CalendarEventRow | undefined { return this.db.prepare(`${SELECT} WHERE e.id = ?`).get(id) as CalendarEventRow | undefined }
  create(input: CreateCalendarEventInput, timezone: string, timestamp: number): number {
    return this.db.transaction(() => {
      const result = this.db.prepare(`
        INSERT INTO calendar_events (opportunity_id, title, event_type, start_at, end_at, is_all_day, timezone, location, description, reminder_minutes, is_completed, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      `).run(input.opportunityId ?? null, input.title, input.eventType, input.startAt, input.endAt, input.isAllDay ? 1 : 0, timezone, input.location ?? null, input.description ?? null, input.reminderMinutes ?? null, timestamp, timestamp)
      return result.lastInsertRowid as number
    })()
  }
  update(id: number, input: CreateCalendarEventInput, timezone: string, timestamp: number): void {
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE calendar_events SET opportunity_id = ?, title = ?, event_type = ?, start_at = ?, end_at = ?, is_all_day = ?, timezone = ?, location = ?, description = ?, reminder_minutes = ?, updated_at = ? WHERE id = ?
      `).run(input.opportunityId ?? null, input.title, input.eventType, input.startAt, input.endAt, input.isAllDay ? 1 : 0, timezone, input.location ?? null, input.description ?? null, input.reminderMinutes ?? null, timestamp, id)
    })()
  }
  complete(id: number, completed: boolean, timestamp: number): void { this.db.transaction(() => { this.db.prepare('UPDATE calendar_events SET is_completed = ?, updated_at = ? WHERE id = ?').run(completed ? 1 : 0, timestamp, id) })() }
  delete(id: number): number {
    return this.db.transaction(() => {
      const changes = this.db.prepare('DELETE FROM calendar_events WHERE id = ?').run(id).changes
      this.db.prepare('DELETE FROM calendar_event_reminders WHERE calendar_event_id = ?').run(id)
      return changes
    })()
  }
  listDue(currentAt: number): Array<{ event_id: number; title: string; start_at: number; end_at: number; timezone: string; reminder_at: number }> {
    return this.db.prepare(`
      SELECT e.id AS event_id, e.title, e.start_at, e.end_at, e.timezone,
             e.start_at - (e.reminder_minutes * 60000) AS reminder_at
      FROM calendar_events e
      LEFT JOIN calendar_event_reminders r
        ON r.calendar_event_id = e.id
       AND r.reminder_at = e.start_at - (e.reminder_minutes * 60000)
      WHERE e.reminder_minutes IS NOT NULL
        AND e.is_completed = 0
        AND ? >= e.start_at - (e.reminder_minutes * 60000)
        AND r.id IS NULL
      ORDER BY e.start_at, e.id
    `).all(currentAt) as Array<{ event_id: number; title: string; start_at: number; end_at: number; timezone: string; reminder_at: number }>
  }
  markReminderSent(eventId: number, reminderAt: number, sentAt: number): void {
    this.db.transaction(() => { this.db.prepare('INSERT OR IGNORE INTO calendar_event_reminders (calendar_event_id, reminder_at, sent_at) VALUES (?, ?, ?)').run(eventId, reminderAt, sentAt) })()
  }
  map(row: CalendarEventRow) { return mapCalendarEvent(row) }
}
