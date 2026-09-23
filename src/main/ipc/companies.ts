import type { Services } from '../service-container'
import { registerChannel } from './register-channel'
import { numberValue, parseCompany, parseCompanyQuery } from './validators'

export function registerCompanyIpc(services: Services): void {
  registerChannel('companies:search', (query) =>
    services.companies.search(parseCompanyQuery(query)),
  )
  registerChannel('companies:list', () => services.companies.list())
  registerChannel('companies:get', (id) => services.companies.get(numberValue(id, '公司 ID')))
  registerChannel('companies:mark-read', (id) =>
    services.companies.markRead(numberValue(id, '公司 ID')),
  )
  registerChannel('companies:create', (input) =>
    services.companies.create(parseCompany(input, false)),
  )
  registerChannel('companies:update', (id, input) =>
    services.companies.update(numberValue(id, '公司 ID'), parseCompany(input, true)),
  )
  registerChannel('companies:delete', (id) => services.companies.delete(numberValue(id, '公司 ID')))
}
