import type { CalendarEvent, CalendarRange, CreateCalendarEventInput, UpdateCalendarEventInput } from '../../shared/types'
import { CalendarEventRepository } from '../repositories/calendar-event-repository'
import { OpportunityRepository } from '../repositories/opportunity-repository'
import { AppServiceError, assertFiniteInteger, assertPositiveId, nullableText } from './errors'

type CompleteCalendarEventInput = CreateCalendarEventInput

export class CalendarEventService {
  constructor(private readonly repository: CalendarEventRepository, private readonly opportunities: OpportunityRepository) {}
  list(range: CalendarRange): CalendarEvent[] {
    assertFiniteInteger(range.startAt, '日历开始时间')
    assertFiniteInteger(range.endAt, '日历结束时间')
    if (range.endAt <= range.startAt) throw new AppServiceError('VALIDATION_ERROR', '日历时间范围无效')
    return this.repository.list(range).map((row) => this.repository.map(row))
  }
  get(id: number): CalendarEvent {
    assertPositiveId(id, '日程 ID')
    const row = this.repository.get(id)
    if (!row) throw new AppServiceError('NOT_FOUND', '日程不存在')
    return this.repository.map(row)
  }
  create(input: CreateCalendarEventInput): CalendarEvent {
    const normalized = this.normalize(input)
    this.validate(normalized)
    return this.get(this.repository.create(normalized, normalized.timezone!, Date.now()))
  }
  update(id: number, input: UpdateCalendarEventInput): CalendarEvent {
    const current = this.get(id)
    const normalized = this.normalize({
      opportunityId: input.opportunityId === undefined ? current.opportunityId : input.opportunityId,
      title: input.title ?? current.title,
      eventType: input.eventType ?? current.eventType,
      startAt: input.startAt ?? current.startAt,
      endAt: input.endAt ?? current.endAt,
      isAllDay: input.isAllDay ?? current.isAllDay,
      timezone: input.timezone ?? current.timezone,
      location: input.location === undefined ? current.location : input.location,
      description: input.description === undefined ? current.description : input.description,
      reminderMinutes: input.reminderMinutes === undefined ? current.reminderMinutes : input.reminderMinutes,
    })
    this.validate(normalized)
    this.repository.update(id, normalized, normalized.timezone!, Date.now())
    return this.get(id)
  }
  complete(id: number, completed: boolean): CalendarEvent {
    this.get(id)
    this.repository.complete(id, completed, Date.now())
    return this.get(id)
  }
  delete(id: number): void {
    this.get(id)
    if (this.repository.delete(id) === 0) throw new AppServiceError('NOT_FOUND', '日程不存在')
  }
  private normalize(input: CompleteCalendarEventInput): CompleteCalendarEventInput {
    return {
      ...input,
      title: input.title.trim(), eventType: input.eventType.trim(), timezone: input.timezone?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone,
      location: nullableText(input.location), description: nullableText(input.description),
    }
  }
  private validate(input: CompleteCalendarEventInput): void {
    if (!input.title || !input.eventType) throw new AppServiceError('VALIDATION_ERROR', '日程标题和类型不能为空')
    assertFiniteInteger(input.startAt, '日程开始时间')
    assertFiniteInteger(input.endAt, '日程结束时间')
    if (input.endAt < input.startAt) throw new AppServiceError('VALIDATION_ERROR', '日程结束时间不能早于开始时间')
    if (input.opportunityId !== null && input.opportunityId !== undefined) {
      assertPositiveId(input.opportunityId, '求职记录 ID')
      if (!this.opportunities.get(input.opportunityId)) throw new AppServiceError('VALIDATION_ERROR', '关联的求职记录不存在')
    }
    if (input.reminderMinutes !== null && input.reminderMinutes !== undefined && (!Number.isSafeInteger(input.reminderMinutes) || input.reminderMinutes < 0)) {
      throw new AppServiceError('VALIDATION_ERROR', '提醒时间无效')
    }
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: input.timezone })
    } catch {
      throw new AppServiceError('VALIDATION_ERROR', '时区无效')
    }
  }
}
