import { computed, ref, toRaw, watch, type Ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import type {
  CalendarEvent,
  CalendarReminderNotification,
  CreateCalendarEventInput,
} from '../../shared/types'
import {
  eventTouchesCalendarDate,
  eventTouchesCalendarMonth,
  pickerValueForZonedDate,
  zonedDateFromPickerValue,
} from '../../shared/calendar'
import { useCalendarStore } from '../stores/calendar'
import type { ViewKey } from '../types'

interface CalendarWorkspaceOptions {
  activeView: Ref<ViewKey>
  showError: (error: unknown) => void
  notifySuccess: (text: string) => void
  notifyError: (text: string) => void
}

export function useCalendarWorkspace(options: CalendarWorkspaceOptions) {
  const { t, locale } = useI18n()
  const calendarStore = useCalendarStore()
  const { items: events } = storeToRefs(calendarStore)
  const showEventModal = ref(false)
  const editingEventId = ref<number | null>(null)
  const calendarMonth = ref(new Date(new Date().getFullYear(), new Date().getMonth(), 1))
  const selectedCalendarDay = ref(new Date())
  const eventForm = ref<CreateCalendarEventInput>(newEventInput(selectedCalendarDay.value))

  const eventTypeOptions = computed(() => [
    { label: t('calendar.types.interview'), value: 'interview' },
    { label: t('calendar.types.writtenTest'), value: 'written_test' },
    { label: t('calendar.types.deadline'), value: 'deadline' },
    { label: t('calendar.types.reminder'), value: 'reminder' },
    { label: t('calendar.types.other'), value: 'other' },
  ])
  const reminderOptions = computed(() => [
    { label: t('calendar.reminder5Minutes'), value: 5 },
    { label: t('calendar.reminder10Minutes'), value: 10 },
    { label: t('calendar.reminder15Minutes'), value: 15 },
    { label: t('calendar.reminder30Minutes'), value: 30 },
    { label: t('calendar.reminder1Hour'), value: 60 },
    { label: t('calendar.reminder2Hours'), value: 120 },
    { label: t('calendar.reminder1Day'), value: 1440 },
  ])
  const weekdays = computed(() =>
    locale.value === 'zh-CN'
      ? ['日', '一', '二', '三', '四', '五', '六']
      : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  )
  const selectedDayEvents = computed(() => eventsForDay(selectedCalendarDay.value))
  const monthEventCount = computed(
    () =>
      events.value.filter((event) => eventTouchesCalendarMonth(event, calendarMonth.value)).length,
  )
  const monthLabel = computed(() =>
    new Intl.DateTimeFormat(locale.value, { year: 'numeric', month: 'long' }).format(
      calendarMonth.value,
    ),
  )
  const calendarDays = computed(() => {
    const first = calendarMonth.value
    const start = new Date(first.getFullYear(), first.getMonth(), 1 - first.getDay())
    return Array.from({ length: 42 }, (_, index) => {
      const day = new Date(start)
      day.setDate(start.getDate() + index)
      return day
    })
  })

  function formatEventTime(event: CalendarEvent, timestamp: number): string {
    return new Intl.DateTimeFormat(locale.value, {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: event.timezone,
    }).format(timestamp)
  }

  function isSameDay(a: Date, b: Date): boolean {
    return (
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate()
    )
  }

  function eventsForDay(day: Date): CalendarEvent[] {
    return events.value.filter((event) => eventTouchesCalendarDate(event, day))
  }

  function selectCalendarDay(day: Date): void {
    selectedCalendarDay.value = day
    if (
      day.getFullYear() !== calendarMonth.value.getFullYear() ||
      day.getMonth() !== calendarMonth.value.getMonth()
    ) {
      calendarMonth.value = new Date(day.getFullYear(), day.getMonth(), 1)
    }
  }

  const eventTypeTranslationKeys = {
    interview: 'interview',
    written_test: 'writtenTest',
    deadline: 'deadline',
    reminder: 'reminder',
    other: 'other',
  } as const
  function eventTypeLabel(eventType: string): string {
    const type =
      eventTypeTranslationKeys[eventType as keyof typeof eventTypeTranslationKeys] ??
      eventTypeTranslationKeys.other
    return t(`calendar.types.${type}`)
  }

  const eventTagTypes = {
    interview: 'info',
    written_test: 'warning',
    deadline: 'error',
    reminder: 'success',
    other: 'default',
  } as const
  function eventTypeTagType(eventType: string): (typeof eventTagTypes)[keyof typeof eventTagTypes] {
    return eventTagTypes[eventType as keyof typeof eventTagTypes] ?? eventTagTypes.other
  }

  async function loadCalendar(): Promise<void> {
    const month = calendarMonth.value
    const start = new Date(month.getFullYear(), month.getMonth(), 1 - month.getDay())
    const end = new Date(start)
    end.setDate(start.getDate() + 42)
    const timezoneMargin = 36 * 60 * 60 * 1000
    await calendarStore.load({
      startAt: start.getTime() - timezoneMargin,
      endAt: end.getTime() + timezoneMargin,
    })
  }

  function newEvent(day = selectedCalendarDay.value): void {
    editingEventId.value = null
    eventForm.value = newEventInput(day)
    showEventModal.value = true
  }

  function openEvent(event: CalendarEvent): void {
    editingEventId.value = event.id
    eventForm.value = {
      opportunityId: event.opportunityId,
      title: event.title,
      eventType: event.eventType,
      startAt: event.isAllDay
        ? pickerValueForZonedDate(event.startAt, event.timezone)
        : event.startAt,
      endAt: event.isAllDay ? pickerValueForZonedDate(event.endAt, event.timezone) : event.endAt,
      isAllDay: event.isAllDay,
      timezone: event.timezone,
      location: event.location,
      description: event.description,
      reminderMinutes: event.reminderMinutes,
    }
    showEventModal.value = true
  }

  function setEventAllDay(isAllDay: boolean): void {
    eventForm.value.isAllDay = isAllDay
    const start = new Date(eventForm.value.startAt)
    if (isAllDay) {
      start.setHours(0, 0, 0, 0)
      const end = new Date(eventForm.value.endAt)
      end.setHours(0, 0, 0, 0)
      if (end.getTime() <= start.getTime()) end.setDate(start.getDate() + 1)
      eventForm.value.startAt = start.getTime()
      eventForm.value.endAt = end.getTime()
    } else if (eventForm.value.endAt <= eventForm.value.startAt) {
      eventForm.value.endAt = eventForm.value.startAt + 60 * 60 * 1000
    }
  }

  async function openCalendarEventFromReminder(
    notification: CalendarReminderNotification,
  ): Promise<void> {
    try {
      const event = await window.zhijiApi.calendar.get(notification.eventId)
      const day = new Date(pickerValueForZonedDate(event.startAt, event.timezone))
      options.activeView.value = 'calendar'
      selectedCalendarDay.value = day
      calendarMonth.value = new Date(day.getFullYear(), day.getMonth(), 1)
      openEvent(event)
    } catch (error) {
      options.showError(error)
    }
  }

  async function saveEvent(): Promise<void> {
    if (!eventForm.value.title.trim()) {
      options.notifyError(t('error.required'))
      return
    }
    try {
      const isEditing = editingEventId.value !== null
      const input = structuredClone(toRaw(eventForm.value))
      if (input.isAllDay) {
        const timezone = input.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
        input.startAt = zonedDateFromPickerValue(input.startAt, timezone)
        input.endAt = zonedDateFromPickerValue(input.endAt, timezone)
      }
      if (isEditing) await window.zhijiApi.calendar.update(editingEventId.value!, input)
      else await window.zhijiApi.calendar.create(input)
      showEventModal.value = false
      await loadCalendar()
      options.notifySuccess(t(isEditing ? 'feedback.editSuccess' : 'feedback.addSuccess'))
    } catch (error) {
      options.showError(error)
    }
  }

  async function deleteEvent(id: number): Promise<void> {
    try {
      await window.zhijiApi.calendar.delete(id)
      await loadCalendar()
      options.notifySuccess(t('feedback.deleteSuccess'))
    } catch (error) {
      options.showError(error)
    }
  }

  async function completeEvent(event: CalendarEvent): Promise<void> {
    try {
      await window.zhijiApi.calendar.complete(event.id, !event.isCompleted)
      await loadCalendar()
      options.notifySuccess(t('feedback.completeSuccess'))
    } catch (error) {
      options.showError(error)
    }
  }

  function previousMonth(): void {
    calendarMonth.value = new Date(
      calendarMonth.value.getFullYear(),
      calendarMonth.value.getMonth() - 1,
      1,
    )
  }
  function nextMonth(): void {
    calendarMonth.value = new Date(
      calendarMonth.value.getFullYear(),
      calendarMonth.value.getMonth() + 1,
      1,
    )
  }
  function goToday(): void {
    const today = new Date()
    calendarMonth.value = new Date(today.getFullYear(), today.getMonth(), 1)
    selectedCalendarDay.value = today
  }

  watch(calendarMonth, () => {
    void loadCalendar().catch(options.showError)
  })

  return {
    events,
    showEventModal,
    editingEventId,
    eventForm,
    calendarMonth,
    selectedCalendarDay,
    eventTypeOptions,
    reminderOptions,
    weekdays,
    selectedDayEvents,
    monthEventCount,
    monthLabel,
    calendarDays,
    formatEventTime,
    isSameDay,
    eventsForDay,
    selectCalendarDay,
    eventTypeLabel,
    eventTypeTagType,
    loadCalendar,
    newEvent,
    openEvent,
    setEventAllDay,
    openCalendarEventFromReminder,
    saveEvent,
    deleteEvent,
    completeEvent,
    previousMonth,
    nextMonth,
    goToday,
  }
}

function newEventInput(day: Date): CreateCalendarEventInput {
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 10, 0, 0)
  return {
    title: '',
    eventType: 'other',
    startAt: start.getTime(),
    endAt: start.getTime() + 60 * 60 * 1000,
    isAllDay: false,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    location: null,
    description: null,
    reminderMinutes: null,
  }
}
