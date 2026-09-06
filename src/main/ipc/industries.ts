import type { Services } from '../service-container'
import { registerChannel } from './register-channel'
import { ids, numberValue, parseIndustry } from './validators'

export function registerIndustryIpc(services: Services): void {
  registerChannel('industries:list', () => services.industries.list())
  registerChannel('industries:get', (id) => services.industries.get(numberValue(id, '行业分类 ID') as number))
  registerChannel('industries:create', (input) => services.industries.create(parseIndustry(input, false) as { name: string }))
  registerChannel('industries:update', (id, input) => services.industries.update(numberValue(id, '行业分类 ID') as number, parseIndustry(input, true)))
  registerChannel('industries:delete', (id) => services.industries.delete(numberValue(id, '行业分类 ID') as number))
  registerChannel('industries:reorder', (order) => services.industries.reorder(ids(order, '行业分类顺序')))
}
