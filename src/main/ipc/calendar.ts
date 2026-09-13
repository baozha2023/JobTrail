import type { Services } from '../service-container'
import { registerChannel } from './register-channel'
import { numberValue, parseCalendarEvent, parseCalendarRange } from './validators'

export function registerCalendarIpc(services: Services): void {
  registerChannel('calendar:list', (range) => services.calendar.list(parseCalendarRange(range)))
  registerChannel('calendar:get', (id) => services.calendar.get(numberValue(id, '日程 ID')))
  registerChannel('calendar:create', (input) =>
    services.calendar.create(parseCalendarEvent(input, false)),
  )
  registerChannel('calendar:update', (id, input) =>
    services.calendar.update(numberValue(id, '日程 ID'), parseCalendarEvent(input, true)),
  )
  registerChannel('calendar:delete', (id) => services.calendar.delete(numberValue(id, '日程 ID')))
}
