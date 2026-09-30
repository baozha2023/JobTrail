import { ensurePersistenceReady } from '../src/main/persistence-migrations'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { AgentService } from '../src/main/agent/service'
import { ConfigService, DEFAULT_CONFIG, type AppPaths } from '../src/main/config'
import { DB_SCHEMA_VERSION } from '../src/main/database'
import { decryptConfig } from '../src/main/config-crypto'
import { createServiceContainer } from '../src/main/service-container'

const baseline = path.resolve('tests/fixtures/v1')
const V1_MANIFEST_SHA256 = '4d88dfe6a51a33264fca26df4a30b8ffd2fede8e8bf13dab85f0587ab348530b'

function fixtureFiles(root: string): string[] {
  const visit = (directory: string, prefix = ''): string[] =>
    fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) throw new Error(`Baseline contains a link: ${relative}`)
      if (entry.isDirectory()) return visit(path.join(directory, entry.name), relative)
      return entry.isFile() &&
        !['README.md', 'manifest.json'].includes(relative) &&
        !relative.endsWith('.db-wal') &&
        !relative.endsWith('.db-shm')
        ? [relative]
        : []
    })
  return visit(root).sort()
}

describe('immutable v1.0.0 persisted-data baseline', () => {
  it('retains the original synthetic files byte for byte', () => {
    const manifestBytes = fs.readFileSync(path.join(baseline, 'manifest.json'))
    expect(createHash('sha256').update(manifestBytes).digest('hex')).toBe(V1_MANIFEST_SHA256)
    const manifest = JSON.parse(manifestBytes.toString('utf8')) as {
      format: string
      files: Record<string, string>
    }
    expect(manifest.format).toBe('jobtrail-v1-baseline')
    expect(fixtureFiles(baseline)).toEqual(Object.keys(manifest.files).sort())
    for (const [relative, expectedHash] of Object.entries(manifest.files)) {
      expect(
        createHash('sha256')
          .update(fs.readFileSync(path.join(baseline, relative)))
          .digest('hex'),
      ).toBe(expectedHash)
    }
    expect(
      (
        decryptConfig(fs.readFileSync(path.join(baseline, 'config.json'), 'utf8')) as {
          configVersion: number
        }
      ).configVersion,
    ).toBe(1)
  })

  it('opens a copy through the current services and preserves v1 business data', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrail-v1-baseline-'))
    fs.cpSync(baseline, root, { recursive: true })
    const paths: AppPaths = {
      root,
      config: path.join(root, 'config.json'),
      data: path.join(root, 'data'),
      database: path.join(root, 'data', 'zhiji.db'),
      resumes: path.join(root, 'resumes'),
      chatUploads: path.join(root, 'chat-uploads'),
    }
    let container: ReturnType<typeof createServiceContainer> | undefined
    let agent: AgentService | undefined
    try {
      const raw = new Database(paths.database, { readonly: true, fileMustExist: true })
      try {
        expect(raw.pragma('user_version', { simple: true })).toBe(1)
      } finally {
        raw.close()
      }
      await ensurePersistenceReady(paths)
      const config = new ConfigService(paths)
      expect(config.get().configVersion).toBe(DEFAULT_CONFIG.configVersion)
      expect(config.get().ai.apiKey).toBe('')
      container = createServiceContainer(paths, false)
      expect(container.database.db.pragma('user_version', { simple: true })).toBe(DB_SCHEMA_VERSION)
      const company = container.services.companies
        .list()
        .find((item) => item.name === 'V1 基线样例公司')
      expect(company).toBeDefined()
      const opportunity = container.services.opportunities.search({
        page: 1,
        pageSize: 20,
        search: '示例工程师',
      }).items[0]
      expect(opportunity.companyId).toBe(company!.id)
      const resume = container.services.resumes.list().find((item) => item.name === '合成简历')
      expect(resume).toBeDefined()
      expect(fs.readFileSync(container.services.resumes.getPath(resume!.id), 'utf8')).toContain(
        'Synthetic fixture',
      )
      agent = new AgentService(
        paths,
        container.database.db,
        config,
        container.services,
        () => {
          throw new Error('MCP is disabled in the baseline test')
        },
        () => undefined,
      )
      await agent.recoverPendingDeletions()
      const conversation = agent.list().find((item) => item.title === '基线样例对话')
      expect(conversation).toBeDefined()
      const attachment = container.database.db
        .prepare('SELECT id FROM chat_attachments WHERE conversation_id = ?')
        .get(conversation!.id) as { id: string }
      expect(
        fs.readFileSync(agent.getAttachmentPath(conversation!.id, attachment.id), 'utf8'),
      ).toBe('Synthetic attachment; no personal data.')
      const history = await agent.history(conversation!.id)
      expect(history.messages.map((message) => message.role)).toEqual([
        'user',
        'assistant',
        'user',
        'tool',
        'assistant',
      ])
      expect(history.messages[0]).toMatchObject({
        parts: [{ kind: 'text', text: '请阅读基线合成附件。' }],
        attachments: [{ id: attachment.id }],
      })
      expect(history.messages[2].attachments).toEqual([])
      expect(history.messages[3]).toMatchObject({ name: 'ask_user', status: 'completed' })
      expect(history.messages[3].role === 'tool' && history.messages[3].result).toContain('上海')
      expect(history.pending).toBeNull()
      expect(history.usage.inputTokens).toBeGreaterThan(0)
      const waiting = agent.list().find((item) => item.title === '基线待回答对话')!
      const pending = await agent.history(waiting.id)
      expect(pending.pending).toEqual({
        kind: 'question',
        questions: [{ question: '基线：希望在哪个城市工作？' }],
      })
      expect(pending.messages.at(-1)).toMatchObject({ role: 'tool', status: 'waiting' })
      for (const table of ['agent_chat_events', 'agent_model_usage', 'checkpoints', 'writes']) {
        expect(
          (
            container.database.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
              n: number
            }
          ).n,
        ).toBeGreaterThan(0)
      }
    } finally {
      await agent?.close()
      container?.database.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
