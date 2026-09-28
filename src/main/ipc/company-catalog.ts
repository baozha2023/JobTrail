import { app } from 'electron'

import type { Services } from '../service-container'
import { CompanyCatalogUpdater } from '../company-catalog-updater'
import { fetchCompanyCatalog } from '../company-catalog-fetch'
import { AppServiceError } from '../services/errors'
import { registerChannel, sendToTrustedWindow } from './register-channel'

export function registerCompanyCatalogIpc(services: Services): () => void {
  const updater = new CompanyCatalogUpdater(services.companyCatalog, fetchCompanyCatalog, () =>
    app.getVersion(),
  )

  registerChannel('company-catalog:get-status', () => services.companyCatalog.status())
  registerChannel('company-catalog:update', () => {
    if (!app.isPackaged)
      throw new AppServiceError('VALIDATION_ERROR', '开发版无法更新，请使用已安装版本。')
    return updater.update((progress) => sendToTrustedWindow('company-catalog:progress', progress))
  })

  return () => updater.cancel()
}
