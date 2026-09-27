import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import type { AppPaths } from './config'
import { IndustryRepository } from './repositories/industry-repository'
import { BUNDLED_COMPANY_CATALOG, BUNDLED_COMPANY_CATALOG_HASH } from './company-catalog'

type SqliteDatabase = InstanceType<typeof Database>
export const DB_SCHEMA_VERSION = 1
export const INCOMPATIBLE_DATA_EXIT_CODE = 78

export class DatabaseVersionError extends Error {
  constructor(version: number) {
    super(`不支持的数据库结构版本：${version}，需要版本 ${DB_SCHEMA_VERSION}`)
    this.name = 'DatabaseVersionError'
  }
}

const DEFAULT_STATUSES = [
  '感兴趣',
  '待投递',
  '已投递',
  '初筛',
  '笔试',
  'AI面试',
  '一面',
  '二面',
  '三面',
  'HR面',
  'Offer',
  '淘汰',
  '主动放弃',
]

export class DatabaseManager {
  readonly db: SqliteDatabase

  constructor(paths: AppPaths) {
    fs.mkdirSync(path.dirname(paths.database), { recursive: true })
    this.db = new Database(paths.database)
    try {
      const version = this.db.pragma('user_version', { simple: true }) as number
      if (version !== 0 && version !== DB_SCHEMA_VERSION) throw new DatabaseVersionError(version)
      this.db.pragma('journal_mode = WAL')
      this.db.pragma('busy_timeout = 5000')
      this.db.transaction(() => this.initialize()).immediate()
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  close(): void {
    this.db.close()
  }

  async snapshotForUpdate(destination: string): Promise<void> {
    // SQLite's online backup includes committed WAL content in one consistent image.
    await this.db.backup(destination)
  }

  dataVersion(): number {
    return this.db.pragma('data_version', { simple: true }) as number
  }

  private initialize(): void {
    const version = this.db.pragma('user_version', { simple: true }) as number
    if (version === DB_SCHEMA_VERSION) return
    if (version !== 0) throw new DatabaseVersionError(version)

    this.db.exec(`
      CREATE TABLE statuses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        label TEXT NOT NULL UNIQUE,
        sort_order INTEGER NOT NULL,
        is_builtin INTEGER NOT NULL DEFAULT 0 CHECK (is_builtin IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE industries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        parent_id INTEGER CHECK (parent_id IS NULL OR (parent_id > 0 AND parent_id <> id)),
        builtin_key TEXT UNIQUE,
        sort_order INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK (parent_id IS NOT NULL OR builtin_key IS NOT NULL)
      );

      CREATE TABLE companies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        builtin_key TEXT UNIQUE,
        career_url TEXT,
        last_read_at INTEGER,
        is_favorite INTEGER NOT NULL DEFAULT 0 CHECK (is_favorite IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE builtin_company_catalog_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        format_version INTEGER NOT NULL,
        catalog_version INTEGER NOT NULL,
        content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
        applied_at INTEGER NOT NULL
      );

      CREATE TABLE company_industries (
        company_id INTEGER NOT NULL,
        industry_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (company_id, industry_id)
      );

      CREATE TABLE company_aliases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER NOT NULL,
        alias TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(company_id, alias)
      );

      CREATE TABLE resume_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        relative_path TEXT NOT NULL UNIQUE,
        size_bytes INTEGER,
        sha256 TEXT,
        note TEXT,
        sort_order INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE agent_conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        title_finalized INTEGER NOT NULL DEFAULT 0 CHECK (title_finalized IN (0, 1)),
        deleting INTEGER NOT NULL DEFAULT 0 CHECK (deleting IN (0, 1)),
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE agent_chat_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        conversation_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('user', 'assistant', 'tool', 'compact')),
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE agent_model_usage (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('agent', 'compact')),
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_tokens INTEGER,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE chat_attachments (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        deleting INTEGER NOT NULL DEFAULT 0 CHECK (deleting IN (0, 1)),
        original_name TEXT NOT NULL,
        relative_path TEXT NOT NULL UNIQUE,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE opportunities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        department TEXT,
        location TEXT,
        source TEXT,
        job_url TEXT,
        description TEXT,
        status_id INTEGER NOT NULL,
        resume_version_id INTEGER,
        discovered_at INTEGER,
        applied_at INTEGER,
        deadline_at INTEGER,
        notes TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE opportunity_status_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        opportunity_id INTEGER NOT NULL,
        status_id INTEGER NOT NULL,
        status_label TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('created', 'changed'))
      );

      CREATE TABLE calendar_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        opportunity_id INTEGER,
        title TEXT NOT NULL,
        event_type TEXT NOT NULL,
        start_at INTEGER NOT NULL,
        end_at INTEGER NOT NULL CHECK (end_at >= start_at),
        is_all_day INTEGER NOT NULL DEFAULT 0 CHECK (is_all_day IN (0, 1)),
        timezone TEXT NOT NULL,
        location TEXT,
        description TEXT,
        reminder_minutes INTEGER CHECK (reminder_minutes IS NULL OR reminder_minutes >= 0),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE calendar_event_reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        calendar_event_id INTEGER NOT NULL,
        reminder_at INTEGER NOT NULL,
        sent_at INTEGER NOT NULL,
        UNIQUE(calendar_event_id, reminder_at)
      );

      CREATE INDEX idx_opportunities_status_id ON opportunities(status_id);
      CREATE INDEX idx_opportunity_status_events_flow ON opportunity_status_events(opportunity_id, occurred_at, id);
      CREATE INDEX idx_opportunity_status_events_status_id ON opportunity_status_events(status_id);
      CREATE INDEX idx_opportunities_company_id ON opportunities(company_id);
      CREATE INDEX idx_opportunities_deadline_at ON opportunities(deadline_at);
      CREATE INDEX idx_opportunities_updated_at ON opportunities(updated_at);
      CREATE UNIQUE INDEX idx_industries_root_name ON industries(name) WHERE parent_id IS NULL;
      CREATE UNIQUE INDEX idx_industries_child_name ON industries(parent_id, name) WHERE parent_id IS NOT NULL;
      CREATE INDEX idx_industries_parent_order ON industries(parent_id, sort_order, id);
      CREATE INDEX idx_company_industries_industry_id ON company_industries(industry_id);
      CREATE INDEX idx_calendar_events_range ON calendar_events(start_at, end_at);
      CREATE INDEX idx_agent_conversations_updated_at ON agent_conversations(updated_at DESC);
      CREATE INDEX idx_agent_chat_events_conversation ON agent_chat_events(conversation_id, seq);
      CREATE INDEX idx_agent_model_usage_conversation ON agent_model_usage(conversation_id, created_at);
      CREATE INDEX idx_chat_attachments_conversation_id ON chat_attachments(conversation_id);
    `)

    this.seed()
  }

  private seed(): void {
    const now = Date.now()
    const insertCompany = this.db.prepare(`
      INSERT INTO companies (name, builtin_key, career_url, is_favorite, created_at, updated_at)
      VALUES (?, ?, ?, 0, ?, ?)
    `)
    const getCompanyId = this.db.prepare('SELECT id FROM companies WHERE name = ?')
    const addIndustry = this.db.prepare(`
      INSERT INTO company_industries (company_id, industry_id, created_at)
      VALUES (?, ?, ?)
    `)
    const addAlias = this.db.prepare(`
      INSERT INTO company_aliases (company_id, alias, created_at)
      VALUES (?, ?, ?)
    `)
    const seedTransaction = this.db.transaction(() => {
      const insertStatus = this.db.prepare(
        'INSERT INTO statuses (id, label, sort_order, is_builtin, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)',
      )
      DEFAULT_STATUSES.forEach((label, index) =>
        insertStatus.run(index + 1, label, index + 1, now, now),
      )
      const industryIds = new IndustryRepository(this.db).synchronize(
        BUNDLED_COMPANY_CATALOG.industries,
        now,
      )
      for (const companySeed of BUNDLED_COMPANY_CATALOG.companies) {
        insertCompany.run(companySeed.name, companySeed.builtinKey, companySeed.careerUrl, now, now)
        const { id: companyId } = getCompanyId.get(companySeed.name) as { id: number }
        for (const industryKey of companySeed.industryKeys)
          addIndustry.run(companyId, industryIds.get(industryKey)!, now)
        for (const alias of companySeed.aliases) addAlias.run(companyId, alias, now)
      }
      this.db
        .prepare(
          'INSERT INTO builtin_company_catalog_state (id, format_version, catalog_version, content_sha256, applied_at) VALUES (1, ?, ?, ?, ?)',
        )
        .run(
          BUNDLED_COMPANY_CATALOG.formatVersion,
          BUNDLED_COMPANY_CATALOG.catalogVersion,
          BUNDLED_COMPANY_CATALOG_HASH,
          now,
        )
      // Commit the seed data and its schema marker atomically. Otherwise a
      // process interruption between the two writes leaves a populated v0
      // database that cannot be initialized on the next launch.
      this.db.pragma(`user_version = ${DB_SCHEMA_VERSION}`)
    })
    seedTransaction()
  }
}
