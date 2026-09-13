import { describe, expect, it } from 'vitest'
import type { CalendarEvent } from '../src/shared/types'
import {
  calendarDateKey,
  calendarDateParts,
  calendarDayRange,
  calendarMonthRange,
  eventOverlapsRange,
  eventTouchesCalendarDate,
  eventTouchesCalendarMonth,
  isCalendarEventCompleted,
  timestampForZonedDate,
} from '../src/shared/calendar'

function event(startAt: number, endAt: number): Pick<CalendarEvent, 'startAt' | 'endAt'> {
  return { startAt, endAt }
}

describe('calendar range helpers', () => {
  it('completes an event when its end time arrives', () => {
    expect(isCalendarEventCompleted({ endAt: 1000 }, 999)).toBe(false)
    expect(isCalendarEventCompleted({ endAt: 1000 }, 1000)).toBe(true)
  })
  it('includes events spanning into a day or month and excludes touching boundaries', () => {
    const day = calendarDayRange(new Date(2026, 8, 7, 12))
    expect(eventOverlapsRange(event(day.startAt - 60_000, day.startAt + 60_000), day)).toBe(true)
    expect(eventOverlapsRange(event(day.endAt - 60_000, day.endAt + 60_000), day)).toBe(true)
    expect(eventOverlapsRange(event(day.startAt - 60_000, day.startAt), day)).toBe(false)
    expect(eventOverlapsRange(event(day.endAt, day.endAt + 60_000), day)).toBe(false)

    const month = calendarMonthRange(new Date(2026, 8, 15))
    expect(eventOverlapsRange(event(month.startAt - 60_000, month.startAt + 60_000), month)).toBe(
      true,
    )
  })

  it('includes zero-duration events as time points', () => {
    const day = calendarDayRange(new Date(2026, 8, 7))
    expect(eventOverlapsRange(event(day.startAt, day.startAt), day)).toBe(true)
    expect(eventOverlapsRange(event(day.endAt, day.endAt), day)).toBe(false)
  })

  it('uses the event timezone to decide its calendar date', () => {
    const timestamp = Date.UTC(2026, 8, 7, 2)
    const zonedEvent = {
      startAt: timestamp,
      endAt: timestamp + 60_000,
      timezone: 'America/Los_Angeles',
    }
    expect(eventTouchesCalendarDate(zonedEvent, new Date(2026, 8, 6))).toBe(true)
    expect(eventTouchesCalendarDate(zonedEvent, new Date(2026, 8, 7))).toBe(false)
    expect(eventTouchesCalendarMonth(zonedEvent, new Date(2026, 8, 1))).toBe(true)
    expect(calendarDateKey(calendarDateParts(timestamp, 'Asia/Shanghai'))).toBe('2026-09-07')
    expect(calendarDateKey(calendarDateParts(timestamp, 'America/Los_Angeles'))).toBe('2026-09-06')
  })

  it('converts a calendar date to midnight in its timezone', () => {
    const timestamp = timestampForZonedDate({ year: 2026, month: 9, day: 7 }, 'Asia/Shanghai')
    expect(timestamp).toBe(Date.UTC(2026, 8, 6, 16))
    expect(calendarDateParts(timestamp, 'Asia/Shanghai')).toEqual({ year: 2026, month: 9, day: 7 })

    const beforeDst = timestampForZonedDate({ year: 2026, month: 3, day: 8 }, 'America/New_York')
    const afterDst = timestampForZonedDate({ year: 2026, month: 3, day: 9 }, 'America/New_York')
    expect(beforeDst).toBe(Date.UTC(2026, 2, 8, 5))
    expect(afterDst).toBe(Date.UTC(2026, 2, 9, 4))
  })
})
