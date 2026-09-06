import type { Services } from '../service-container'
import { registerChannel } from './register-channel'
import { booleanValue, numberValue, parseCalendarEvent, parseCalendarRange } from './validators'

export function registerCalendarIpc(services: Services): void {
  registerChannel('calendar:list', (range) => services.calendar.list(parseCalendarRange(range)))
  registerChannel('calendar:get', (id) => services.calendar.get(numberValue(id, '日程 ID') as number))
  registerChannel('calendar:create', (input) => services.calendar.create(parseCalendarEvent(input, false) as { title: string; eventType: string; startAt: number; endAt: number }))
  registerChannel('calendar:update', (id, input) => services.calendar.update(numberValue(id, '日程 ID') as number, parseCalendarEvent(input, true)))
  registerChannel('calendar:delete', (id) => services.calendar.delete(numberValue(id, '日程 ID') as number))
  registerChannel('calendar:complete', (id, completed) => services.calendar.complete(numberValue(id, '日程 ID') as number, booleanValue(completed, '完成状态') as boolean))
}
