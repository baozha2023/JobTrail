import { beforeEach, expect, it, vi } from 'vitest'
import type { Services } from '../src/main/service-container'
import { version as currentVersion } from '../package.json'
import { formatVersion, catalogVersion } from '../resource/jobtrail-company-catalog.json'

const mocks = vi.hoisted(() => ({
  app: { isPackaged: false, getVersion: () => currentVersion },
  handlers: new Map<string, () => unknown>(),
  update: vi.fn(),
}))
vi.mock('electron', () => ({ app: mocks.app }))
vi.mock('../src/main/company-catalog-fetch', () => ({ fetchCompanyCatalog: vi.fn() }))
vi.mock('../src/main/company-catalog-updater', () => ({
  CompanyCatalogUpdater: class {
    update = mocks.update
    cancel = vi.fn()
  },
}))
vi.mock('../src/main/ipc/register-channel', () => ({
  registerChannel: (name: string, handler: () => unknown) => mocks.handlers.set(name, handler),
  sendToTrustedWindow: vi.fn(),
}))

import { registerCompanyCatalogIpc } from '../src/main/ipc/company-catalog'

beforeEach(() => {
  mocks.handlers.clear()
  mocks.update.mockReset()
  mocks.app.isPackaged = false
})

it('allows reading development catalog status but blocks updates before any download or write', () => {
  const status = { formatVersion, catalogVersion, appliedAt: 1 }
  registerCompanyCatalogIpc({ companyCatalog: { status: () => status } } as Services)
  expect(mocks.handlers.get('company-catalog:get-status')!()).toEqual(status)
  expect(() => mocks.handlers.get('company-catalog:update')!()).toThrow(
    '开发版无法更新，请使用已安装版本。',
  )
  expect(mocks.update).not.toHaveBeenCalled()
})

it('continues to run catalog updates in packaged clients', async () => {
  mocks.app.isPackaged = true
  const result = { status: 'up-to-date' }
  mocks.update.mockResolvedValue(result)
  registerCompanyCatalogIpc({ companyCatalog: {} } as Services)
  await expect(mocks.handlers.get('company-catalog:update')!()).resolves.toBe(result)
  expect(mocks.update).toHaveBeenCalledOnce()
})
