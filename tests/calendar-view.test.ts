// @vitest-environment jsdom

import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CalendarEvent } from '../src/shared/types'
import CalendarView from '../src/renderer/views/CalendarView.vue'
import { i18n } from '../src/renderer/i18n'

afterEach(() => vi.useRealTimers())

describe('calendar completion display', () => {
  it('updates automatically at the event end without a completion control', async () => {
    vi.useFakeTimers()
    const now = Date.UTC(2026, 8, 12, 8)
    vi.setSystemTime(now)
    const event: CalendarEvent = {
      id: 1,
      opportunityId: null,
      opportunityTitle: null,
      opportunityJobUrl: null,
      companyName: null,
      title: '面试',
      eventType: '面试',
      startAt: now - 60_000,
      endAt: now + 1000,
      isAllDay: false,
      timezone: 'Asia/Shanghai',
      location: null,
      description: null,
      reminderMinutes: null,
      isCompleted: false,
      createdAt: now,
      updatedAt: now,
    }
    const day = new Date(now)
    const wrapper = mount(CalendarView, {
      props: {
        monthLabel: '2026年9月',
        weekdays: ['日', '一', '二', '三', '四', '五', '六'],
        calendarDays: [day],
        calendarMonth: day,
        selectedCalendarDay: day,
        selectedDayEvents: [event],
        monthEventCount: 1,
        eventsForDay: () => [event],
        isSameDay: (a: Date, b: Date) => a.toDateString() === b.toDateString(),
        formatDate: () => '2026/09/12',
        formatEventTime: () => '16:00',
        isExternalUrl: () => false,
        normalizeExternalUrl: (value: string) => value,
      },
      global: { plugins: [i18n] },
    })

    try {
      expect(wrapper.find('.event-detail').classes()).not.toContain('completed')
      expect(wrapper.find('.event-detail-title-row').text()).toContain('面试')
      expect(wrapper.findAll('.event-detail-actions button')).toHaveLength(2)
      vi.advanceTimersByTime(1000)
      await nextTick()
      expect(wrapper.find('.event-detail').classes()).toContain('completed')
      expect(wrapper.find('.event-detail-title-row').text()).toContain('已完成')
      expect(wrapper.findAll('.event-detail-actions button')).toHaveLength(2)
    } finally {
      wrapper.unmount()
    }
  })
})
