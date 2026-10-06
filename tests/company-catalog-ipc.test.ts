import { beforeEach, expect, it, vi } from 'vitest'
import type { Services } from '../src/main/service-container'
import type { CompanyCatalogFetcher, CompanyCatalogUrls } from '../src/main/company-catalog-updater'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { version as currentVersion } from '../package.json'
import { formatVersion, catalogVersion } from '../resource/jobtrail-company-catalog.json'

const mocks = vi.hoisted(() => ({
  app: { isPackaged: false, getVersion: () => currentVersion, getAppPath: () => process.cwd() },
  handlers: new Map<string, () => unknown>(),
  update: vi.fn(),
  construct: vi.fn(),
}))
vi.mock('electron', () => ({ app: mocks.app }))
vi.mock('../src/main/company-catalog-fetch', () => ({ fetchCompanyCatalog: vi.fn() }))
vi.mock('../src/main/company-catalog-updater', () => ({
  CompanyCatalogUpdater: class {
    constructor(
      service: unknown,
      fetcher: CompanyCatalogFetcher,
      version: () => string,
      urls?: CompanyCatalogUrls,
    ) {
      mocks.construct(service, fetcher, version(), urls)
    }
    update = mocks.update
    cancel = vi.fn()
  },
}))
vi.mock('../src/main/ipc/register-channel', () => ({
  registerChannel: (name: string, handler: () => unknown) => mocks.handlers.set(name, handler),
  sendToTrustedWindow: vi.fn(),
}))

import { registerCompanyCatalogIpc } from '../src/main/ipc/company-catalog'
import { fetchCompanyCatalog } from '../src/main/company-catalog-fetch'

beforeEach(() => {
  mocks.handlers.clear()
  mocks.update.mockReset()
  mocks.construct.mockReset()
  mocks.app.isPackaged = false
})

it('uses the local source with the shared updater in development', async () => {
  const status = { formatVersion, catalogVersion, appliedAt: 1 }
  const result = { status: 'up-to-date' }
  mocks.update.mockResolvedValue(result)
  registerCompanyCatalogIpc({ companyCatalog: { status: () => status } } as Services)
  expect(mocks.handlers.get('company-catalog:get-status')!()).toEqual(status)
  await expect(mocks.handlers.get('company-catalog:update')!()).resolves.toBe(result)
  expect(mocks.update).toHaveBeenCalledOnce()
  const [, fetcher, version, urls] = mocks.construct.mock.calls[0]!
  expect(fetcher).not.toBe(fetchCompanyCatalog)
  expect(version).toBe(currentVersion)
  expect(urls.catalogUrl).toBe(
    pathToFileURL(path.join(process.cwd(), 'resource', 'jobtrail-company-catalog.json')).href,
  )
})

it('continues to run catalog updates in packaged clients', async () => {
  mocks.app.isPackaged = true
  const result = { status: 'up-to-date' }
  mocks.update.mockResolvedValue(result)
  registerCompanyCatalogIpc({ companyCatalog: {} } as Services)
  await expect(mocks.handlers.get('company-catalog:update')!()).resolves.toBe(result)
  expect(mocks.update).toHaveBeenCalledOnce()
  expect(mocks.construct).toHaveBeenCalledWith(
    expect.anything(),
    fetchCompanyCatalog,
    currentVersion,
    undefined,
  )
})
