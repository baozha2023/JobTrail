import { app } from 'electron'

import type { Services } from '../service-container'
import { CompanyCatalogUpdater } from '../company-catalog-updater'
import { fetchCompanyCatalog } from '../company-catalog-fetch'
import { localCompanyCatalogSource } from '../company-catalog-local'
import { registerChannel, sendToTrustedWindow } from './register-channel'

export function registerCompanyCatalogIpc(services: Services): () => void {
  const localSource = app.isPackaged ? undefined : localCompanyCatalogSource(app.getAppPath())
  const updater = new CompanyCatalogUpdater(
    services.companyCatalog,
    localSource?.fetcher ?? fetchCompanyCatalog,
    () => app.getVersion(),
    localSource,
  )

  registerChannel('company-catalog:get-status', () => services.companyCatalog.status())
  registerChannel('company-catalog:update', () => {
    return updater.update((progress) => sendToTrustedWindow('company-catalog:progress', progress))
  })

  return () => updater.cancel()
}
