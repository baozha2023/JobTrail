import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import type { AppPaths } from './config'
import { BUILTIN_COMPANIES } from './builtin-companies'

type SqliteDatabase = InstanceType<typeof Database>
export const DB_SCHEMA_VERSION = 8

const DEFAULT_STATUSES = [
  '感兴趣',
  '待投递',
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

const DEFAULT_INDUSTRIES = [
  '互联网',
  '游戏',
  '人工智能',
  '软件',
  '芯片',
  '硬件',
  '通信与硬件',
  '电子与硬件',
  '计算机与IT服务',
  '金融',
  '银行',
  '证券与投资',
  '保险',
  '电商与零售',
  '消费品',
  '食品饮料',
  '医疗健康',
  '生物医药',
  '汽车',
  '新能源',
  '制造业',
  '化工与材料',
  '建筑与房地产',
  '家居与物业',
  '物流与供应链',
  '交通运输',
  '航空航天',
  '能源与矿业',
  '电力与公用事业',
  '教育',
  '旅游与酒店',
  '媒体与内容',
  '广告与营销',
  '文化娱乐',
  '专业服务与咨询',
  '法律服务',
  '人力资源',
  '农业与农牧',
  '政府与公共服务',
  '跨境贸易',
  '生活服务',
  '环保与循环经济',
  '其他服务',
  '林业与木材',
  '渔业与水产',
  '烟草',
  '纺织与服装',
  '化妆品与美容',
  '珠宝与奢侈品',
  '批发贸易',
  '医疗器械',
  '互联网安全',
  '云计算与数据服务',
  '物联网',
  '机器人与智能制造',
  '科研与技术服务',
  '检验检测与认证',
  '会计审计与税务',
  '设计与创意',
  '知识产权服务',
  '安保服务',
  '国防军工',
  '轨道交通',
  '港口航运与海洋',
  '邮政与快递',
  '航空服务与机场',
  '核工业',
  '石油与天然气',
  '水务与水处理',
  '餐饮',
  '体育与健身',
  '养老与社会工作',
  '出版与印刷',
  '影视与演艺',
  '宠物与兽医',
  '租赁服务',
  '维修与保养',
  '国际组织',
  '非营利与社会组织',
  '殡葬与生命服务',
  '地质勘查与测绘',
  '气象与海洋观测',
  '招标采购与工程服务',
]
export class DatabaseManager {
  readonly db: SqliteDatabase

  constructor(paths: AppPaths) {
    fs.mkdirSync(path.dirname(paths.database), { recursive: true })
    this.db = new Database(paths.database)
    try {
      this.db.pragma('journal_mode = WAL')
      this.db.pragma('busy_timeout = 5000')
      this.initialize()
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  close(): void {
    this.db.close()
  }

  private initialize(): void {
    const version = this.db.pragma('user_version', { simple: true }) as number
    if (version !== 0 && version !== DB_SCHEMA_VERSION) {
      throw new Error(`不支持的数据库结构版本：${version}，需要版本 ${DB_SCHEMA_VERSION}`)
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS statuses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        label TEXT NOT NULL UNIQUE,
        sort_order INTEGER NOT NULL,
        is_builtin INTEGER NOT NULL DEFAULT 0 CHECK (is_builtin IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS industries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        sort_order INTEGER NOT NULL,
        is_builtin INTEGER NOT NULL DEFAULT 0 CHECK (is_builtin IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS companies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        career_url TEXT,
        last_read_at INTEGER,
        is_builtin INTEGER NOT NULL DEFAULT 0 CHECK (is_builtin IN (0, 1)),
        is_favorite INTEGER NOT NULL DEFAULT 0 CHECK (is_favorite IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS company_industries (
        company_id INTEGER NOT NULL,
        industry_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (company_id, industry_id)
      );

      CREATE TABLE IF NOT EXISTS company_aliases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER NOT NULL,
        alias TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(company_id, alias)
      );

      CREATE TABLE IF NOT EXISTS resume_versions (
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

      CREATE TABLE IF NOT EXISTS opportunities (
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

      CREATE TABLE IF NOT EXISTS calendar_events (
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
        is_completed INTEGER NOT NULL DEFAULT 0 CHECK (is_completed IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS calendar_event_reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        calendar_event_id INTEGER NOT NULL,
        reminder_at INTEGER NOT NULL,
        sent_at INTEGER NOT NULL,
        UNIQUE(calendar_event_id, reminder_at)
      );

      CREATE INDEX IF NOT EXISTS idx_opportunities_status_id ON opportunities(status_id);
      CREATE INDEX IF NOT EXISTS idx_opportunities_company_id ON opportunities(company_id);
      CREATE INDEX IF NOT EXISTS idx_opportunities_deadline_at ON opportunities(deadline_at);
      CREATE INDEX IF NOT EXISTS idx_opportunities_updated_at ON opportunities(updated_at);
      CREATE INDEX IF NOT EXISTS idx_company_industries_industry_id ON company_industries(industry_id);
      CREATE INDEX IF NOT EXISTS idx_calendar_events_range ON calendar_events(start_at, end_at);
    `)

    if (version === 0) {
      this.seed()
    }
  }

  private seed(): void {
    const now = Date.now()
    const insertCompany = this.db.prepare(`
      INSERT INTO companies (name, career_url, is_builtin, is_favorite, created_at, updated_at)
      VALUES (?, ?, 1, 0, ?, ?)
      ON CONFLICT(name) DO UPDATE SET name = excluded.name
      RETURNING id
    `)
    const addIndustry = this.db.prepare(`
      INSERT OR IGNORE INTO company_industries (company_id, industry_id, created_at)
      VALUES (?, ?, ?)
    `)
    const addAlias = this.db.prepare(`
      INSERT OR IGNORE INTO company_aliases (company_id, alias, created_at)
      VALUES (?, ?, ?)
    `)
    const seedTransaction = this.db.transaction(() => {
      const insertStatus = this.db.prepare(
        'INSERT INTO statuses (id, label, sort_order, is_builtin, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)',
      )
      DEFAULT_STATUSES.forEach((label, index) =>
        insertStatus.run(index + 1, label, index + 1, now, now),
      )
      const insertIndustry = this.db.prepare(
        'INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)',
      )
      DEFAULT_INDUSTRIES.forEach((label, index) =>
        insertIndustry.run(index + 1, label, index, now, now),
      )
      for (const companySeed of BUILTIN_COMPANIES) {
        const company = insertCompany.get(companySeed.name, companySeed.careerUrl, now, now) as {
          id: number
        }
        const companyId = company.id
        for (const industryId of companySeed.industryIds)
          addIndustry.run(companyId, industryId, now)
        for (const alias of companySeed.aliases) addAlias.run(companyId, alias, now)
      }
      // Commit the seed data and its schema marker atomically. Otherwise a
      // process interruption between the two writes leaves a populated v0
      // database that cannot be initialized on the next launch.
      this.db.pragma(`user_version = ${DB_SCHEMA_VERSION}`)
    })
    seedTransaction()
  }
}
