import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CalendarReminderService } from '../src/main/services/calendar-reminder-service'
const state = vi.hoisted(() => ({ notifications: [] as EventEmitter[] }))
vi.mock('electron', () => ({
  Notification: class extends EventEmitter {
    static isSupported() {
      return true
    }
    constructor() {
      super()
      state.notifications.push(this)
    }
    show() {}
    close() {
      this.emit('close')
    }
  },
}))
import { ReminderScheduler } from '../src/main/reminder-scheduler'
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  state.notifications.length = 0
})
describe('notification delivery', () => {
  it('records delivery only when Windows confirms showing the notification', () => {
    vi.useFakeTimers()
    const markSent = vi.fn()
    const reminders = {
      listDue: () => [
        { eventId: 1, title: 'Interview', startAt: 0, endAt: 1, timezone: 'UTC', reminderAt: 0 },
      ],
      markSent,
    } as unknown as CalendarReminderService
    const scheduler = new ReminderScheduler(
      reminders,
      () => undefined,
      () => 'zh-CN',
    )
    scheduler.start()
    expect(markSent).not.toHaveBeenCalled()
    state.notifications[0].emit('show')
    expect(markSent).toHaveBeenCalledWith(1, 0)
    scheduler.stop()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('retries failed delivery and removes callbacks on shutdown', () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const markSent = vi.fn()
    const reminders = {
      listDue: () => [
        { eventId: 1, title: 'Interview', startAt: 0, endAt: 1, timezone: 'UTC', reminderAt: 0 },
      ],
      markSent,
    } as unknown as CalendarReminderService
    const scheduler = new ReminderScheduler(
      reminders,
      () => undefined,
      () => 'en-US',
    )
    scheduler.start()
    state.notifications[0].emit('failed', {}, 'unavailable')
    expect(markSent).not.toHaveBeenCalled()
    vi.advanceTimersByTime(5 * 60 * 1000)
    expect(state.notifications).toHaveLength(2)
    scheduler.stop()
    state.notifications[1].emit('show')
    expect(markSent).not.toHaveBeenCalled()
  })
})
