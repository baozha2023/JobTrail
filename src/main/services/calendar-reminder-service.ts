import { CalendarEventRepository } from '../repositories/calendar-event-repository'

export interface DueCalendarReminder {
  eventId: number
  title: string
  startAt: number
  endAt: number
  timezone: string
  reminderAt: number
}

export class CalendarReminderService {
  constructor(private readonly repository: CalendarEventRepository) {}
  listDue(currentAt = Date.now()): DueCalendarReminder[] {
    return this.repository.listDue(currentAt).map((row) => ({ eventId: row.event_id, title: row.title, startAt: row.start_at, endAt: row.end_at, timezone: row.timezone, reminderAt: row.reminder_at }))
  }
  markSent(eventId: number, reminderAt: number, sentAt = Date.now()): void { this.repository.markReminderSent(eventId, reminderAt, sentAt) }
}
