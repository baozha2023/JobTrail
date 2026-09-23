import type { Services } from '../service-container'
import { registerChannel } from './register-channel'
import { numberValue, parseOpportunity, parseOpportunityQuery } from './validators'

export function registerOpportunityIpc(services: Services): void {
  registerChannel('opportunities:search', (query) =>
    services.opportunities.search(parseOpportunityQuery(query)),
  )
  registerChannel('opportunities:list', () => services.opportunities.list())
  registerChannel('opportunities:get', (id) =>
    services.opportunities.get(numberValue(id, '求职记录 ID')),
  )
  registerChannel('opportunities:status-flow', (id) =>
    services.opportunities.statusFlow(numberValue(id, '求职记录 ID')),
  )
  registerChannel('opportunities:create', (input) =>
    services.opportunities.create(parseOpportunity(input, false)),
  )
  registerChannel('opportunities:update', (id, input) =>
    services.opportunities.update(numberValue(id, '求职记录 ID'), parseOpportunity(input, true)),
  )
  registerChannel('opportunities:delete', (id) =>
    services.opportunities.delete(numberValue(id, '求职记录 ID')),
  )
  registerChannel('opportunities:change-status', (id, statusId) =>
    services.opportunities.changeStatus(
      numberValue(id, '求职记录 ID'),
      numberValue(statusId, '状态 ID'),
    ),
  )
}
