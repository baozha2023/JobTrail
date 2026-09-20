import type { ConfigService } from './config'
import type { Services } from './service-container'
import { registerCalendarIpc } from './ipc/calendar'
import { registerAgentIpc } from './ipc/agent'
import type { AgentService } from './agent/service'
import { registerCompanyIpc } from './ipc/companies'
import { registerCompanyCatalogIpc } from './ipc/company-catalog'
import { registerConfigIpc } from './ipc/config'
import { registerIndustryIpc } from './ipc/industries'
import { registerMcpIpc } from './ipc/mcp'
import { registerOpportunityIpc } from './ipc/opportunities'
import { registerResumeIpc } from './ipc/resumes'
import { registerStatusIpc } from './ipc/statuses'
import { registerSystemIpc, registerWindowIpc as registerWindowHandlers } from './ipc/system'

export { registerChannel } from './ipc/register-channel'

export function registerIpc(
  services: Services,
  config: ConfigService,
  agent: AgentService,
): () => void {
  registerAgentIpc(agent)
  registerConfigIpc(config)
  registerMcpIpc()
  registerStatusIpc(services)
  registerIndustryIpc(services)
  registerCompanyIpc(services)
  const cancelCompanyCatalogUpdate = registerCompanyCatalogIpc(services)
  registerResumeIpc(services)
  registerOpportunityIpc(services)
  registerCalendarIpc(services)
  registerSystemIpc()
  return cancelCompanyCatalogUpdate
}

export function registerWindowIpc(window: Electron.BrowserWindow): void {
  registerWindowHandlers(window)
}
