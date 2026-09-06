import type { Services } from '../service-container'
import { registerChannel } from './register-channel'
import { numberValue, parseOpportunity, parseOpportunityQuery } from './validators'

export function registerOpportunityIpc(services: Services): void {
  registerChannel('opportunities:list', (query) => services.opportunities.list(parseOpportunityQuery(query)))
  registerChannel('opportunities:get', (id) => services.opportunities.get(numberValue(id, '求职记录 ID') as number))
  registerChannel('opportunities:create', (input) => services.opportunities.create(parseOpportunity(input, false) as { companyId: number; title: string; statusId: number }))
  registerChannel('opportunities:update', (id, input) => services.opportunities.update(numberValue(id, '求职记录 ID') as number, parseOpportunity(input, true)))
  registerChannel('opportunities:delete', (id) => services.opportunities.delete(numberValue(id, '求职记录 ID') as number))
  registerChannel('opportunities:change-status', (id, statusId) => services.opportunities.changeStatus(numberValue(id, '求职记录 ID') as number, numberValue(statusId, '状态 ID') as number))
}
