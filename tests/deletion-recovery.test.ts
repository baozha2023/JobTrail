import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentService } from '../src/main/agent/service'
import { ConfigService, type AppPaths } from '../src/main/config'
import { FileStorageService } from '../src/main/file-storage'
import { createServiceContainer } from '../src/main/service-container'
import { initializeFaultLogger } from '../src/main/diagnostics'
import { updateFreezePath } from '../src/main/update-freeze'

const roots: string[] = []

function fixture(): { paths: AppPaths; config: ConfigService } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrail-recovery-'))
  roots.push(root)
  const paths: AppPaths = {
    root,
    config: path.join(root, 'config.json'),
    data: path.join(root, 'data'),
    database: path.join(root, 'data', 'zhiji.db'),
    resumes: path.join(root, 'resumes'),
    chatUploads: path.join(root, 'chat-uploads'),
  }
  return { paths, config: new ConfigService(paths) }
}

function createAgent(paths: AppPaths, config: ConfigService) {
  const container = createServiceContainer(paths, false)
  const agent = new AgentService(
    paths,
    container.database.db,
    config,
    container.services,
    () => {
      throw new Error('MCP is disabled in this test')
    },
    () => undefined,
  )
  return { container, agent }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('crash recovery for managed files and agent cleanup', () => {
  it('does not close a resumed MCP client after an earlier maintenance timeout', async () => {
    const { paths, config } = fixture()
    const { container, agent } = createAgent(paths, config)
    const conversation = agent.create()
    const internals = agent as unknown as {
      readHistory(id: string): ReturnType<AgentService['history']>
      mcp: { close(): Promise<void> }
    }
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const original = internals.readHistory.bind(agent)
    vi.spyOn(internals, 'readHistory').mockImplementationOnce((id) => held.then(() => original(id)))
    const closeMcp = vi.spyOn(internals.mcp, 'close')
    const pending = agent.history(conversation.id)
    vi.useFakeTimers()
    try {
      const suspended = expect(agent.suspendForUpdate()).rejects.toThrow(
        'agent_operations_did_not_stop',
      )
      await vi.advanceTimersByTimeAsync(15000)
      await suspended
      agent.resumeAfterUpdate()
      release()
      await pending
      await Promise.resolve()
      expect(closeMcp).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
      release()
      await agent.close()
      container.database.close()
    }
  })

  it('restores a staged resume when its database row survived', () => {
    const { paths } = fixture()
    const container = createServiceContainer(paths, false)
    const source = path.join(paths.root, 'source.pdf')
    fs.writeFileSync(source, '%PDF-1.4 synthetic resume')
    const resume = container.services.resumes.importFromPath(source, 'synthetic')
    const files = new FileStorageService(paths)
    const staged = files.stageRemove(resume.relativePath)
    container.database.close()

    const reopened = createServiceContainer(paths, false)
    expect(fs.readFileSync(reopened.services.resumes.getPath(resume.id), 'utf8')).toBe(
      '%PDF-1.4 synthetic resume',
    )
    expect(fs.existsSync(staged.temporaryPath)).toBe(false)
    reopened.database.close()
  })

  it('finishes staged resume deletion after the row was committed', () => {
    const { paths } = fixture()
    const container = createServiceContainer(paths, false)
    const source = path.join(paths.root, 'source.pdf')
    fs.writeFileSync(source, '%PDF-1.4 synthetic resume')
    const resume = container.services.resumes.importFromPath(source, 'synthetic')
    const staged = new FileStorageService(paths).stageRemove(resume.relativePath)
    container.database.db.prepare('DELETE FROM resume_versions WHERE id = ?').run(resume.id)
    container.database.close()

    const reopened = createServiceContainer(paths, false)
    expect(reopened.services.resumes.list()).toEqual([])
    expect(fs.existsSync(staged.temporaryPath)).toBe(false)
    reopened.database.close()
  })

  it('defers recovery while an update rollback snapshot is frozen', () => {
    const { paths } = fixture()
    const container = createServiceContainer(paths, false)
    const source = path.join(paths.root, 'source.pdf')
    fs.writeFileSync(source, '%PDF-1.4 synthetic resume')
    const resume = container.services.resumes.importFromPath(source, 'synthetic')
    const staged = new FileStorageService(paths).stageRemove(resume.relativePath)
    container.database.close()
    const freeze = updateFreezePath(paths.root)
    fs.mkdirSync(path.dirname(freeze), { recursive: true })
    fs.writeFileSync(freeze, '')

    const frozen = createServiceContainer(paths, false)
    expect(fs.existsSync(staged.temporaryPath)).toBe(true)
    frozen.database.close()
    fs.rmSync(freeze)
    const reopened = createServiceContainer(paths, false)
    expect(fs.existsSync(reopened.services.resumes.getPath(resume.id))).toBe(true)
    reopened.database.close()
  })

  it('retries a conversation deletion after an interrupted attachment cleanup', async () => {
    const { paths, config } = fixture()
    initializeFaultLogger('main', '1.1.0', true, paths.root)
    const first = createAgent(paths, config)
    const conversation = first.agent.create()
    const attachment = first.agent.uploadBytes(
      conversation.id,
      'synthetic.txt',
      'text/plain',
      new TextEncoder().encode('synthetic data'),
    )
    const attachmentPath = first.agent.getAttachmentPath(conversation.id, attachment.id)
    vi.spyOn(first.agent.files, 'deleteConversation').mockImplementationOnce(() => {
      throw new Error('simulated interruption')
    })
    await first.agent.delete(conversation.id)
    expect(first.agent.list()).toEqual([])
    expect(fs.existsSync(attachmentPath)).toBe(true)
    expect(
      first.container.database.db
        .prepare('SELECT deleting FROM agent_conversations WHERE id = ?')
        .get(conversation.id),
    ).toEqual({ deleting: 1 })
    expect(
      JSON.parse(fs.readFileSync(path.join(paths.root, 'logs', 'app.jsonl'), 'utf8')),
    ).toMatchObject({
      operation: 'agent.conversation-cleanup',
      code: 'INTERNAL_ERROR',
    })
    await first.agent.close()
    first.container.database.close()
    vi.restoreAllMocks()

    const second = createAgent(paths, config)
    await second.agent.recoverPendingDeletions()
    expect(second.agent.list()).toEqual([])
    expect(
      second.container.database.db
        .prepare('SELECT 1 FROM agent_conversations WHERE id = ?')
        .get(conversation.id),
    ).toBeUndefined()
    expect(fs.existsSync(attachmentPath)).toBe(false)
    await second.agent.close()
    second.container.database.close()
  })

  it('retries a pending single attachment removal on the next startup', async () => {
    const { paths, config } = fixture()
    const first = createAgent(paths, config)
    const conversation = first.agent.create()
    const attachment = first.agent.uploadBytes(
      conversation.id,
      'synthetic.txt',
      'text/plain',
      new TextEncoder().encode('synthetic data'),
    )
    const attachmentPath = first.agent.getAttachmentPath(conversation.id, attachment.id)
    first.container.database.db
      .prepare('UPDATE chat_attachments SET deleting = 1 WHERE id = ?')
      .run(attachment.id)
    await first.agent.close()
    first.container.database.close()

    const second = createAgent(paths, config)
    await second.agent.recoverPendingDeletions()
    expect(fs.existsSync(attachmentPath)).toBe(false)
    expect(
      second.container.database.db
        .prepare('SELECT 1 FROM chat_attachments WHERE id = ?')
        .get(attachment.id),
    ).toBeUndefined()
    await second.agent.close()
    second.container.database.close()
  })

  it('drains in-flight agent work and blocks new writes during update preparation', async () => {
    const { paths, config } = fixture()
    const { container, agent } = createAgent(paths, config)
    const conversation = agent.create()
    const mcp = (agent as unknown as { mcp: { close(): Promise<void> } }).mcp
    const closeMcp = vi.spyOn(mcp, 'close')
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const internals = agent as unknown as {
      readHistory(id: string): ReturnType<AgentService['history']>
    }
    const original = internals.readHistory.bind(agent)
    // Hold a tracked operation long enough to prove the update waits for it.
    vi.spyOn(internals, 'readHistory').mockImplementationOnce((id) => held.then(() => original(id)))
    const pending = agent.history(conversation.id)
    const freeze = updateFreezePath(paths.root)
    fs.mkdirSync(path.dirname(freeze), { recursive: true })
    fs.writeFileSync(freeze, '')
    const suspending = agent.suspendForUpdate()
    let drained = false
    void suspending.then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    expect(() => agent.create()).toThrow('应用正在更新')
    expect(() => agent.rename(conversation.id, 'blocked')).toThrow('应用正在更新')
    expect(() =>
      agent.uploadBytes(
        conversation.id,
        'blocked.txt',
        'text/plain',
        new TextEncoder().encode('blocked'),
      ),
    ).toThrow('应用正在更新')
    await expect(agent.delete(conversation.id)).rejects.toThrow('应用正在更新')
    release()
    await pending
    await suspending
    expect(closeMcp).toHaveBeenCalledOnce()
    fs.rmSync(freeze)
    agent.resumeAfterUpdate()
    expect(agent.create().id).toBeDefined()
    await agent.close()
    container.database.close()
  })
})
