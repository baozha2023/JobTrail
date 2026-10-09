import { registerChannel } from './register-channel'
import type { JobDiscoveryService } from '../discovery/service'
export function registerDiscoveryIpc(service: JobDiscoveryService) {
  registerChannel('discovery:status', (...args) => service.status(...args))
  registerChannel('discovery:start', (...args) => service.start(...args))
  registerChannel('discovery:run', (...args) => service.run(...args))
  registerChannel('discovery:list', (...args) => service.list(...args))
  registerChannel('discovery:continue', (...args) => service.continue(...args))
  registerChannel('discovery:cancel', (...args) => service.cancel(...args))
  registerChannel('discovery:detail', (...args) => service.detail(...args))
  registerChannel('discovery:history', (...args) => service.history(...args))
  registerChannel('discovery:removeHistory', (...args) => service.removeHistory(...args))
  registerChannel('discovery:save', (...args) => service.save(...args))
  registerChannel('discovery:browser', (...args) => service.browser(...args))
  registerChannel('discovery:qrLogin', (...args) => service.qrLogin(...args))
  registerChannel('discovery:verification', (...args) => service.verification(...args))
  registerChannel('discovery:region', (...args) => service.region(...args))
}
