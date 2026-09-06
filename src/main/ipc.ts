import type { ConfigService } from './config'
import type { Services } from './service-container'
import { registerCalendarIpc } from './ipc/calendar'
import { registerCompanyIpc } from './ipc/companies'
import { registerConfigIpc } from './ipc/config'
import { registerIndustryIpc } from './ipc/industries'
import { registerOpportunityIpc } from './ipc/opportunities'
import { registerResumeIpc } from './ipc/resumes'
import { registerStatusIpc } from './ipc/statuses'
import { registerSystemIpc, registerWindowIpc as registerWindowHandlers } from './ipc/system'

export { registerChannel } from './ipc/register-channel'

export function registerIpc(services: Services, config: ConfigService): void {
  registerConfigIpc(config)
  registerStatusIpc(services)
  registerIndustryIpc(services)
  registerCompanyIpc(services)
  registerResumeIpc(services)
  registerOpportunityIpc(services)
  registerCalendarIpc(services)
  registerSystemIpc()
}

export function registerWindowIpc(window: Electron.BrowserWindow): void { registerWindowHandlers(window) }
