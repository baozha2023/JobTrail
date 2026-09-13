import type { CalendarEvent } from './types'

export interface TimeRange {
  startAt: number
  endAt: number
}

export interface CalendarDateParts {
  year: number
  month: number
  day: number
}

export function isCalendarEventCompleted(
  event: Pick<CalendarEvent, 'endAt'>,
  now = Date.now(),
): boolean {
  return event.endAt <= now
}

const dateFormatterCache = new Map<string, Intl.DateTimeFormat>()
const dateTimeFormatterCache = new Map<string, Intl.DateTimeFormat>()

function formatter(timezone: string, withTime: boolean): Intl.DateTimeFormat {
  const cache = withTime ? dateTimeFormatterCache : dateFormatterCache
  const cached = cache.get(timezone)
  if (cached) return cached
  const created = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(withTime
      ? { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' as const }
      : {}),
  })
  cache.set(timezone, created)
  return created
}

function numericPart(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): number {
  const value = parts.find((part) => part.type === type)?.value
  if (value === undefined) throw new RangeError(`Missing calendar part: ${type}`)
  return Number(value)
}

export function calendarDateParts(timestamp: number, timezone: string): CalendarDateParts {
  const parts = formatter(timezone, false).formatToParts(timestamp)
  return {
    year: numericPart(parts, 'year'),
    month: numericPart(parts, 'month'),
    day: numericPart(parts, 'day'),
  }
}

export function localCalendarDateParts(timestamp: number): CalendarDateParts {
  const date = new Date(timestamp)
  return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() }
}

export function calendarDateKey(parts: CalendarDateParts): string {
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
}

export function timestampForZonedDate(parts: CalendarDateParts, timezone: string): number {
  const targetWallTime = Date.UTC(parts.year, parts.month - 1, parts.day)
  let candidate = targetWallTime
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const observed = formatter(timezone, true).formatToParts(candidate)
    const observedWallTime = Date.UTC(
      numericPart(observed, 'year'),
      numericPart(observed, 'month') - 1,
      numericPart(observed, 'day'),
      numericPart(observed, 'hour'),
      numericPart(observed, 'minute'),
      numericPart(observed, 'second'),
    )
    const adjustment = targetWallTime - observedWallTime
    candidate += adjustment
    if (adjustment === 0) break
  }
  return candidate
}

export function startOfCalendarDay(timestamp: number, timezone: string): number {
  return timestampForZonedDate(calendarDateParts(timestamp, timezone), timezone)
}

export function pickerValueForZonedDate(timestamp: number, timezone: string): number {
  const parts = calendarDateParts(timestamp, timezone)
  return new Date(parts.year, parts.month - 1, parts.day).getTime()
}

export function zonedDateFromPickerValue(timestamp: number, timezone: string): number {
  return timestampForZonedDate(localCalendarDateParts(timestamp), timezone)
}

export function eventTouchesCalendarDate(
  event: Pick<CalendarEvent, 'startAt' | 'endAt' | 'timezone'>,
  day: Date,
): boolean {
  const target = calendarDateKey(localCalendarDateParts(day.getTime()))
  const first = calendarDateKey(calendarDateParts(event.startAt, event.timezone))
  const lastTimestamp = event.endAt > event.startAt ? event.endAt - 1 : event.startAt
  const last = calendarDateKey(calendarDateParts(lastTimestamp, event.timezone))
  return target >= first && target <= last
}

export function eventTouchesCalendarMonth(
  event: Pick<CalendarEvent, 'startAt' | 'endAt' | 'timezone'>,
  month: Date,
): boolean {
  const firstOfMonth = new Date(month.getFullYear(), month.getMonth(), 1)
  const firstOfNextMonth = new Date(month.getFullYear(), month.getMonth() + 1, 1)
  const rangeStart = calendarDateKey(localCalendarDateParts(firstOfMonth.getTime()))
  const rangeEnd = calendarDateKey(localCalendarDateParts(firstOfNextMonth.getTime()))
  const eventStart = calendarDateKey(calendarDateParts(event.startAt, event.timezone))
  const lastTimestamp = event.endAt > event.startAt ? event.endAt - 1 : event.startAt
  const eventEnd = calendarDateKey(calendarDateParts(lastTimestamp, event.timezone))
  return eventStart < rangeEnd && eventEnd >= rangeStart
}

export function calendarDayRange(day: Date): TimeRange {
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate())
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  return { startAt: start.getTime(), endAt: end.getTime() }
}

export function calendarMonthRange(month: Date): TimeRange {
  return {
    startAt: new Date(month.getFullYear(), month.getMonth(), 1).getTime(),
    endAt: new Date(month.getFullYear(), month.getMonth() + 1, 1).getTime(),
  }
}

export function eventOverlapsRange(
  event: Pick<CalendarEvent, 'startAt' | 'endAt'>,
  range: TimeRange,
): boolean {
  if (event.startAt === event.endAt)
    return event.startAt >= range.startAt && event.startAt < range.endAt
  return event.startAt < range.endAt && event.endAt > range.startAt
}
