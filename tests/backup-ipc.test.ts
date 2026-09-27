import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentService } from '../src/main/agent/service'
import { backupSessionPath, restoreDirectory } from '../src/main/backup-restore'
import { ConfigService, type AppPaths } from '../src/main/config'
import { registerBackupIpc } from '../src/main/ipc/backup'
import { createServiceContainer } from '../src/main/service-container'
import { updateFreezePath } from '../src/main/update-freeze'

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  handlers: new Map<string, () => Promise<string>>(),
}))
vi.mock('electron', () => ({
  app: { getVersion: () => '1.0.0' },
  dialog: { showSaveDialog: mocks.save },
}))
vi.mock('../src/main/ipc/register-channel', () => ({
  registerChannel: (name: string, handler: () => Promise<string>) =>
    mocks.handlers.set(name, handler),
}))

afterEach(() => {
  vi.restoreAllMocks()
  mocks.handlers.clear()
})

describe('backup maintenance cleanup', () => {
  it.each([false, true])(
    'keeps the write freeze when restore status cannot be read: %s',
    async (denied) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrail-backup-ipc-'))
      const root = path.join(directory, 'data-root')
      const paths: AppPaths = {
        root,
        config: path.join(root, 'config.json'),
        data: path.join(root, 'data'),
        database: path.join(root, 'data', 'zhiji.db'),
        resumes: path.join(root, 'resumes'),
        chatUploads: path.join(root, 'chat-uploads'),
      }
      const config = new ConfigService(paths)
      const container = createServiceContainer(paths, false)
      const agent = new AgentService(
        paths,
        container.database.db,
        config,
        container.services,
        () => {
          throw new Error('MCP is not used by this test')
        },
        () => undefined,
      )
      const destination = path.join(directory, 'export.jobtrail-backup')
      mocks.save.mockResolvedValue({ canceled: false, filePath: destination })
      const restart = vi.fn()
      registerBackupIpc(paths, container.database, config, agent, restart)
      if (denied) {
        const stat = fsp.stat
        vi.spyOn(fsp, 'stat').mockImplementation((file, options) => {
          if (String(file) === restoreDirectory(root))
            return Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' }))
          return stat(file, options)
        })
      }
      try {
        const exported = mocks.handlers.get('backup:export')!()
        if (denied) {
          await expect(exported).rejects.toMatchObject({ code: 'EACCES' })
          expect(() => agent.create()).toThrow('应用正在更新')
        } else {
          await expect(exported).resolves.toBe('exported')
          expect(agent.create().id).toBeDefined()
        }
        expect(fs.existsSync(destination)).toBe(true)
        expect(fs.existsSync(updateFreezePath(root))).toBe(denied)
        expect(fs.existsSync(backupSessionPath(root))).toBe(denied)
        expect(restart).not.toHaveBeenCalled()
      } finally {
        await agent.close()
        container.database.close()
        fs.rmSync(directory, { recursive: true, force: true })
      }
    },
  )
})
