import type { Services } from '../service-container'
import { registerChannel } from './register-channel'
import { numberValue, parseCompany, stringValue } from './validators'

export function registerCompanyIpc(services: Services): void {
  registerChannel('companies:search', (keyword) => services.companies.search(stringValue(keyword, '搜索关键词', false) ?? ''))
  registerChannel('companies:list', () => services.companies.list())
  registerChannel('companies:get', (id) => services.companies.get(numberValue(id, '公司 ID') as number))
  registerChannel('companies:mark-read', (id) => services.companies.markRead(numberValue(id, '公司 ID') as number))
  registerChannel('companies:create', (input) => services.companies.create(parseCompany(input, false) as { name: string }))
  registerChannel('companies:update', (id, input) => services.companies.update(numberValue(id, '公司 ID') as number, parseCompany(input, true)))
  registerChannel('companies:delete', (id) => services.companies.delete(numberValue(id, '公司 ID') as number))
}
