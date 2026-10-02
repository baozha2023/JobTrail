import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentService } from '../src/main/agent/service'
import { backupSessionPath, restoreDirectory } from '../src/main/backup-restore'
import { ConfigService, type AppPaths } from '../src/main/config'
import { registerBackupIpc } from '../src/main/ipc/backup'
import { createServiceContainer } from '../src/main/service-container'
import { updateFreezePath } from '../src/main/update-freeze'
import { exportBackup } from '../src/main/backup-archive'
import type { BackupImportConfirmation } from '../src/shared/types'

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  open: vi.fn(),
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}))
vi.mock('electron', () => ({
  app: { getVersion: () => '1.0.0' },
  dialog: { showSaveDialog: mocks.save, showOpenDialog: mocks.open },
}))
vi.mock('../src/main/ipc/register-channel', () => ({
  registerChannel: (name: string, handler: (...args: unknown[]) => unknown) =>
    mocks.handlers.set(name, handler),
}))

afterEach(() => {
  vi.restoreAllMocks()
  mocks.handlers.clear()
})

async function importFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrail-backup-confirm-'))
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
  const archive = path.join(directory, 'verified.jobtrail-backup')
  const work = path.join(directory, 'export-work')
  fs.mkdirSync(work)
  const manifest = await exportBackup(paths, container.database, config, '1.2.0', archive, work)
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false, send: vi.fn() })
  const window = { webContents: contents } as unknown as BrowserWindow
  const restart = vi.fn()
  const suspend = vi.spyOn(agent, 'suspendForUpdate')
  registerBackupIpc(paths, container.database, config, agent, restart, () => window)
  mocks.open.mockResolvedValue({ canceled: false, filePaths: [archive] })
  const original = fs.readFileSync(paths.config)
  const confirm = (requestId: unknown, confirmed: unknown) =>
    mocks.handlers.get('backup:confirm-import')!(requestId, confirmed)
  const importing = () => mocks.handlers.get('backup:import')!() as Promise<string>
  const confirmation = async () => {
    await vi.waitFor(() => expect(contents.send).toHaveBeenCalledOnce())
    expect(contents.send.mock.calls[0][0]).toBe('backup:import-confirmation')
    const info = contents.send.mock.calls[0][1] as BackupImportConfirmation
    expect(info).toEqual({
      requestId: expect.any(String),
      appVersion: '1.2.0',
      createdAt: manifest.createdAt,
    })
    expect(suspend).not.toHaveBeenCalled()
    expect(fs.existsSync(updateFreezePath(root))).toBe(false)
    expect(fs.existsSync(restoreDirectory(root))).toBe(false)
    return info
  }
  const assertCancelled = () => {
    expect(fs.readFileSync(paths.config)).toEqual(original)
    expect(fs.existsSync(updateFreezePath(root))).toBe(false)
    expect(fs.existsSync(restoreDirectory(root))).toBe(false)
    expect(
      fs.readdirSync(path.join(root, '.runtime')).some((name) => name.startsWith('backup-work-')),
    ).toBe(false)
    expect(restart).not.toHaveBeenCalled()
    expect(suspend).not.toHaveBeenCalled()
    expect(contents.listenerCount('destroyed')).toBe(0)
  }
  const close = async () => {
    await agent.close()
    container.database.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
  return {
    root,
    paths,
    archive,
    contents,
    restart,
    suspend,
    original,
    importing,
    confirm,
    confirmation,
    assertCancelled,
    close,
  }
}

describe('in-app backup import confirmation', () => {
  it('rejects invalid decisions and cancels without freezing or replacing current data', async () => {
    const f = await importFixture()
    try {
      const running = f.importing()
      const info = await f.confirmation()
      expect(() => f.confirm('unknown-request', true)).toThrow('备份导入确认已失效')
      expect(() => f.confirm(info.requestId, 'yes')).toThrow('备份导入确认已失效')
      f.confirm(info.requestId, false)
      expect(() => f.confirm(info.requestId, true)).toThrow('备份导入确认已失效')
      await expect(running).resolves.toBe('cancelled')
      f.assertCancelled()
      mocks.open.mockResolvedValueOnce({ canceled: true, filePaths: [] })
      await expect(f.importing()).resolves.toBe('cancelled')
    } finally {
      await f.close()
    }
  })

  it('stages the verified backup only after accepting its one-time confirmation', async () => {
    const f = await importFixture()
    try {
      const running = f.importing()
      const info = await f.confirmation()
      f.confirm(info.requestId, true)
      await expect(running).resolves.toBe('restarting')
      expect(f.suspend).toHaveBeenCalledOnce()
      expect(fs.existsSync(restoreDirectory(f.root))).toBe(true)
      expect(fs.existsSync(updateFreezePath(f.root))).toBe(true)
      expect(fs.readFileSync(f.paths.config)).toEqual(f.original)
      await vi.waitFor(() => expect(f.restart).toHaveBeenCalledOnce())
    } finally {
      await f.close()
    }
  })

  it.each(['destroyed', 'render-process-gone', 'did-start-navigation'])(
    'cleans up a pending import when the renderer emits %s',
    async (event) => {
      const f = await importFixture()
      try {
        const running = f.importing()
        await f.confirmation()
        f.contents.emit(event)
        await expect(running).resolves.toBe('cancelled')
        f.assertCancelled()
      } finally {
        await f.close()
      }
    },
  )

  it('rejects an invalid backup before requesting confirmation', async () => {
    const f = await importFixture()
    try {
      fs.writeFileSync(f.archive, 'invalid encrypted backup')
      await expect(f.importing()).rejects.toMatchObject({ code: 'BACKUP_INVALID' })
      expect(f.contents.send).not.toHaveBeenCalled()
      f.assertCancelled()
    } finally {
      await f.close()
    }
  })
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
      registerBackupIpc(paths, container.database, config, agent, restart, () => undefined)
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
