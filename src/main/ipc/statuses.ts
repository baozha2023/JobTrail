import type { Services } from '../service-container'
import { registerChannel } from './register-channel'
import { ids, numberValue, parseStatus } from './validators'

export function registerStatusIpc(services: Services): void {
  registerChannel('statuses:list', () => services.statuses.list())
  registerChannel('statuses:get', (id) => services.statuses.get(numberValue(id, '状态 ID') as number))
  registerChannel('statuses:create', (input) => services.statuses.create(parseStatus(input, false) as { label: string }))
  registerChannel('statuses:update', (id, input) => services.statuses.update(numberValue(id, '状态 ID') as number, parseStatus(input, true)))
  registerChannel('statuses:delete', (id) => services.statuses.delete(numberValue(id, '状态 ID') as number))
  registerChannel('statuses:reorder', (order) => services.statuses.reorder(ids(order, '状态顺序')))
}
