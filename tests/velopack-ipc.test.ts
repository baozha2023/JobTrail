import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseManager } from '../src/main/database'
import { afterEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  root: '',
  handlers: new Map<string, () => Promise<unknown>>(),
}))
vi.mock('electron', () => ({ app: { isPackaged: true, getVersion: () => '1.3.0' } }))
vi.mock('../src/main/config', () => ({ getStorageRoot: () => mocks.root }))
vi.mock('../src/main/ipc/register-channel', () => ({
  registerChannel: (channel: string, handler: () => Promise<unknown>) =>
    mocks.handlers.set(channel, handler),
  sendToTrustedWindow: vi.fn(),
}))
vi.mock('../src/main/update-rollback', () => ({
  preserveRollbackPackage: vi.fn(),
  createRollbackPoint: vi.fn(),
}))
vi.mock('velopack', () => ({
  UpdateManager: class {
    async checkForUpdatesAsync() {
      return { TargetFullRelease: { Version: '1.4.0' } }
    }
    async downloadUpdateAsync() {}
    getUpdatePendingRestart() {
      return { Version: '1.4.0' }
    }
  },
}))
import { registerVelopackIpc } from '../src/main/velopack'
import { closeDiagnostics } from '../src/main/diagnostics'

afterEach(() => {
  closeDiagnostics()
  vi.restoreAllMocks()
  mocks.handlers.clear()
  if (mocks.root) fs.rmSync(mocks.root, { recursive: true, force: true })
  mocks.root = ''
})

it('retains both update preparation and cleanup failures and releases the agent pause', async () => {
  mocks.root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrail-velopack-ipc-'))
  fs.writeFileSync(path.join(mocks.root, '.jobtrail-root'), '')
  const preparationError = new Error('agent pause failed')
  const cleanupError = Object.assign(new Error('state cleanup denied'), { code: 'EACCES' })
  const agent = {
    suspendForUpdate: vi.fn().mockRejectedValue(preparationError),
    resumeAfterUpdate: vi.fn(),
  }
  registerVelopackIpc({} as DatabaseManager, agent)
  await mocks.handlers.get('velopack:check-for-update')!()
  await mocks.handlers.get('velopack:download-update')!()
  const remove = fsp.rm.bind(fsp)
  vi.spyOn(fsp, 'rm').mockImplementation((target, options) =>
    String(target).endsWith('pending-update.json')
      ? Promise.reject(cleanupError)
      : remove(target, options),
  )
  await expect(mocks.handlers.get('velopack:apply-update')!()).rejects.toMatchObject({
    errors: [preparationError, cleanupError],
  })
  expect(agent.resumeAfterUpdate).toHaveBeenCalledOnce()
})
