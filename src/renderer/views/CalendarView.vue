<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { NButton, NCard, NSpace, NTag } from 'naive-ui'
import type { CalendarEvent } from '../../shared/types'
import { isCalendarEventCompleted } from '../../shared/calendar'

const currentTime = ref(Date.now())
let clock: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  clock = setInterval(() => {
    currentTime.value = Date.now()
  }, 1000)
})
onUnmounted(() => {
  if (clock) clearInterval(clock)
})

function isCompleted(event: CalendarEvent): boolean {
  return isCalendarEventCompleted(event, currentTime.value)
}

defineProps<{
  monthLabel: string
  weekdays: string[]
  calendarDays: Date[]
  calendarMonth: Date
  selectedCalendarDay: Date
  selectedDayEvents: CalendarEvent[]
  monthEventCount: number
  eventsForDay: (day: Date) => CalendarEvent[]
  isSameDay: (a: Date, b: Date) => boolean
  formatDate: (timestamp: number) => string
  formatEventTime: (event: CalendarEvent, timestamp: number) => string
  isExternalUrl: (value: string) => boolean
  normalizeExternalUrl: (value: string) => string
}>()
const emit = defineEmits<{
  previous: []
  next: []
  today: []
  selectDay: [day: Date]
  addDay: [day: Date]
  openEvent: [event: CalendarEvent]
  add: []
  edit: [event: CalendarEvent]
  delete: [id: number]
  openLink: [value: string]
}>()
</script>

<template>
  <section class="page-section calendar-page">
    <div class="calendar-toolbar">
      <div class="calendar-nav">
        <n-button circle quaternary :aria-label="$t('calendar.previous')" @click="emit('previous')"
          >‹</n-button
        ><strong class="calendar-month-label">{{ monthLabel }}</strong
        ><n-button circle quaternary :aria-label="$t('calendar.next')" @click="emit('next')"
          >›</n-button
        ><n-button secondary @click="emit('today')">{{ $t('calendar.today') }}</n-button>
      </div>
      <div class="calendar-summary">
        <div class="calendar-summary-item">
          <span>{{ $t('calendar.monthEvents') }}</span
          ><strong>{{ monthEventCount }}</strong>
        </div>
        <div class="calendar-summary-divider"></div>
        <div class="calendar-summary-item">
          <span>{{ $t('calendar.dayEvents') }}</span
          ><strong>{{ selectedDayEvents.length }}</strong>
        </div>
      </div>
    </div>
    <n-card bordered class="calendar-card"
      ><div class="weekday-row">
        <span
          v-for="(day, index) in weekdays"
          :key="day"
          :class="{ weekend: index === 0 || index === 6 }"
          >{{ day }}</span
        >
      </div>
      <div class="calendar-grid">
        <div
          v-for="day in calendarDays"
          :key="day.toISOString()"
          class="calendar-day"
          :class="{
            muted: day.getMonth() !== calendarMonth.getMonth(),
            today: isSameDay(day, new Date(currentTime)),
            selected: isSameDay(day, selectedCalendarDay),
          }"
          role="button"
          tabindex="0"
          @click="emit('selectDay', day)"
          @keydown.enter="emit('selectDay', day)"
          @keydown.space.prevent="emit('selectDay', day)"
        >
          <div class="calendar-day-header">
            <span class="day-number">{{ day.getDate() }}</span
            ><button
              class="calendar-day-add"
              type="button"
              :aria-label="$t('calendar.addForDay')"
              @click.stop="emit('addDay', day)"
            >
              +
            </button>
          </div>
          <div class="calendar-event-list">
            <button
              v-for="event in eventsForDay(day).slice(0, 3)"
              :key="event.id"
              class="calendar-event"
              :class="{ completed: isCompleted(event) }"
              type="button"
              @click.stop="emit('openEvent', event)"
            >
              <span class="calendar-event-dot"></span
              ><span class="calendar-event-text">{{ event.title }}</span
              ><span class="calendar-event-time">{{
                event.isAllDay ? $t('calendar.allDay') : formatEventTime(event, event.startAt)
              }}</span>
            </button>
          </div>
          <span v-if="eventsForDay(day).length > 3" class="more-events"
            >+{{ eventsForDay(day).length - 3 }} {{ $t('common.more') }}</span
          >
        </div>
      </div></n-card
    >
    <n-card bordered class="day-list-card"
      ><template #header
        ><div class="day-list-header">
          <div>
            <span class="section-kicker">{{ $t('calendar.selectedDay') }}</span
            ><strong>{{ formatDate(selectedCalendarDay.getTime()) }}</strong>
          </div>
          <n-button type="primary" size="small" @click="emit('add')">{{
            $t('common.add')
          }}</n-button>
        </div></template
      >
      <div v-if="selectedDayEvents.length === 0" class="calendar-empty-state">
        <div class="calendar-empty-icon">＋</div>
        <strong>{{ $t('calendar.empty') }}</strong
        ><span>{{ $t('calendar.noEventsHint') }}</span>
      </div>
      <div v-else class="event-list">
        <article
          v-for="event in selectedDayEvents"
          :key="event.id"
          class="event-detail"
          :class="{ completed: isCompleted(event) }"
        >
          <div class="event-detail-accent"></div>
          <div class="event-detail-main">
            <div class="event-detail-title-row">
              <strong>{{ event.title }}</strong
              ><n-tag :bordered="false" size="small" type="info">{{ event.eventType }}</n-tag
              ><n-tag v-if="isCompleted(event)" :bordered="false" size="small" type="default">{{
                $t('calendar.completed')
              }}</n-tag>
            </div>
            <div class="event-detail-meta">
              <span>{{
                event.isAllDay
                  ? $t('calendar.allDay')
                  : `${formatEventTime(event, event.startAt)} – ${formatEventTime(event, event.endAt)} (${event.timezone})`
              }}</span
              ><span v-if="event.companyName">{{ event.companyName }}</span
              ><span v-if="event.opportunityTitle">{{ event.opportunityTitle }}</span>
            </div>
            <div v-if="event.location || event.description" class="event-detail-extra">
              <span v-if="event.location"
                ><a
                  v-if="isExternalUrl(event.location)"
                  class="event-detail-link"
                  :href="normalizeExternalUrl(event.location)"
                  @click.stop.prevent="emit('openLink', event.location)"
                  >{{ event.location }}</a
                ><template v-else>{{ event.location }}</template></span
              ><span v-if="event.description">{{ event.description }}</span
              ><a
                v-if="event.opportunityJobUrl"
                class="event-detail-link"
                :href="normalizeExternalUrl(event.opportunityJobUrl)"
                @click.stop.prevent="emit('openLink', event.opportunityJobUrl)"
                >{{ $t('calendar.jobLink') }}</a
              >
            </div>
          </div>
          <n-space class="event-detail-actions" :size="6" wrap
            ><n-button size="small" @click="emit('edit', event)">{{ $t('common.edit') }}</n-button
            ><n-button size="small" type="error" tertiary @click="emit('delete', event.id)">{{
              $t('common.delete')
            }}</n-button></n-space
          >
        </article>
      </div></n-card
    >
  </section>
</template>
