import { BrowserWindow, Notification } from 'electron'
import type { Locale } from '../shared/types'
import { CalendarReminderService } from './services/calendar-reminder-service'

const CHECK_INTERVAL_MS = 5 * 60 * 1000

function formatDateTime(timestamp: number, locale: Locale, timezone: string): string {
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timezone,
  }).format(timestamp)
}

export class ReminderScheduler {
  private timer: NodeJS.Timeout | undefined
  private checking = false
  private readonly active = new Map<string, Notification>()

  constructor(
    private readonly reminders: CalendarReminderService,
    private readonly getWindow: () => BrowserWindow | undefined,
    private readonly getLocale: () => Locale,
  ) {}

  start(): void {
    if (this.timer) return
    void this.check()
    this.timer = setInterval(() => {
      void this.check()
    }, CHECK_INTERVAL_MS)
    this.timer.unref?.()
  }

  stop(): void {
    for (const notification of this.active.values()) {
      notification.removeAllListeners()
      notification.close()
    }
    this.active.clear()
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = undefined
  }

  private async check(): Promise<void> {
    if (this.checking || !Notification.isSupported()) return
    this.checking = true
    try {
      for (const reminder of this.reminders.listDue()) {
        const key = `${reminder.eventId}:${reminder.reminderAt}`
        if (this.active.has(key)) continue
        try {
          const notification = new Notification({
            title: this.getLocale() === 'zh-CN' ? '职迹 · 日程提醒' : 'Zhiji · Calendar reminder',
            body: `${reminder.title}\n${formatDateTime(reminder.startAt, this.getLocale(), reminder.timezone)} - ${formatDateTime(reminder.endAt, this.getLocale(), reminder.timezone)}`,
          })
          this.active.set(key, notification)
          notification.once('show', () => {
            try {
              this.reminders.markSent(reminder.eventId, reminder.reminderAt)
            } catch (error) {
              console.error('Failed to persist calendar reminder delivery', error)
            }
          })
          notification.once('failed', (_event, error) => {
            this.active.delete(key)
            console.error('Calendar notification failed', error)
          })
          notification.once('close', () => this.active.delete(key))
          notification.on('click', () => this.openEvent(reminder.eventId, reminder.startAt))
          notification.show()
        } catch (error) {
          this.active.delete(key)
          console.error(`Failed to send calendar reminder ${reminder.eventId}`, error)
        }
      }
    } catch (error) {
      console.error('Failed to check calendar reminders', error)
    } finally {
      this.checking = false
    }
  }

  private openEvent(eventId: number, startAt: number): void {
    const window = this.getWindow()
    if (!window || window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
    const send = () => {
      if (!window.isDestroyed())
        window.webContents.send('calendar:reminder-click', { eventId, startAt })
    }
    if (window.webContents.isLoading()) window.webContents.once('did-finish-load', send)
    else send()
  }
}
