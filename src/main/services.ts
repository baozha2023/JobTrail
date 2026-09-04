import path from 'node:path'
import type Database from 'better-sqlite3'
import type {
  CalendarEvent,
  CalendarRange,
  Company,
  CompanyAlias,
  Industry,
  CreateCompanyAliasInput,
  CreateCalendarEventInput,
  CreateCompanyInput,
  CreateIndustryInput,
  CreateOpportunityInput,
  CreateStatusInput,
  Opportunity,
  OpportunityQuery,
  ResumeImportResult,
  ResumeVersion,
  Status,
  UpdateCompanyAliasInput,
  UpdateIndustryInput,
  UpdateCompanyInput,
  UpdateCalendarEventInput,
  UpdateOpportunityInput,
  UpdateResumeVersionInput,
  UpdateStatusInput,
} from '../shared/types'
import { FileStorageService } from './file-storage'

type SqliteDatabase = InstanceType<typeof Database>

export class AppServiceError extends Error {
  constructor(
    readonly code: 'VALIDATION_ERROR' | 'NOT_FOUND' | 'STATUS_IN_USE' | 'LAST_STATUS' | 'RESUME_IN_USE' | 'COMPANY_IN_USE' | 'INDUSTRY_IN_USE' | 'DATABASE_ERROR' | 'FILE_IMPORT_FAILED',
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
  }
}

const now = () => Date.now()
const nullable = (value: string | null | undefined) => value?.trim() || null

function mapStatus(row: Record<string, unknown>): Status {
  return {
    id: Number(row.id), label: String(row.label), sortOrder: Number(row.sort_order),
    isBuiltin: Boolean(row.is_builtin), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  }
}

function mapCompany(row: Record<string, unknown>): Company {
  const aliases = typeof row.aliases === 'string' && row.aliases.length > 0
    ? row.aliases.split('\u001f')
    : []
  return {
    id: Number(row.id), name: String(row.name), industryId: row.industry_id as number | null,
    industryName: row.industry_name as string | null,
    careerUrl: row.career_url as string | null, aliases, isBuiltin: Boolean(row.is_builtin),
    isFavorite: Boolean(row.is_favorite), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  }
}

function normalizeAliases(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new AppServiceError('VALIDATION_ERROR', '公司别名格式无效')
  }
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))]
}

function mapIndustry(row: Record<string, unknown>): Industry {
  return {
    id: Number(row.id), name: String(row.name), sortOrder: Number(row.sort_order),
    isBuiltin: Boolean(row.is_builtin), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  }
}

function mapResume(row: Record<string, unknown>): ResumeVersion {
  return {
    id: Number(row.id), name: String(row.name), relativePath: String(row.relative_path),
    sizeBytes: row.size_bytes as number | null, sha256: row.sha256 as string | null,
    note: row.note as string | null, isActive: Boolean(row.is_active),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  }
}

function mapOpportunity(row: Record<string, unknown>): Opportunity {
  return {
    id: Number(row.id), companyId: Number(row.company_id), companyName: String(row.company_name),
    title: String(row.title), department: row.department as string | null, location: row.location as string | null,
    source: row.source as string | null, jobUrl: row.job_url as string | null,
    description: row.description as string | null, statusId: Number(row.status_id), statusLabel: String(row.status_label),
    resumeVersionId: row.resume_version_id as number | null, resumeVersionName: row.resume_version_name as string | null,
    discoveredAt: row.discovered_at as number | null, appliedAt: row.applied_at as number | null,
    deadlineAt: row.deadline_at as number | null, notes: row.notes as string | null,
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  }
}

function mapEvent(row: Record<string, unknown>): CalendarEvent {
  return {
    id: Number(row.id), opportunityId: row.opportunity_id as number | null,
    opportunityTitle: row.opportunity_title as string | null, companyName: row.company_name as string | null,
    title: String(row.title), eventType: String(row.event_type), startAt: Number(row.start_at), endAt: Number(row.end_at),
    isAllDay: Boolean(row.is_all_day), timezone: String(row.timezone), location: row.location as string | null,
    description: row.description as string | null, reminderMinutes: row.reminder_minutes as number | null,
    isCompleted: Boolean(row.is_completed), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  }
}

export class StatusService {
  constructor(private readonly db: SqliteDatabase) {}

  list(): Status[] {
    return (this.db.prepare('SELECT * FROM statuses ORDER BY sort_order, id').all() as Record<string, unknown>[]).map(mapStatus)
  }

  create(input: CreateStatusInput): Status {
    const label = input.label.trim()
    if (!label) throw new AppServiceError('VALIDATION_ERROR', '状态名称不能为空')
    const current = this.db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS max_order FROM statuses').get() as { max_order: number }
    try {
      const result = this.db.prepare(`
        INSERT INTO statuses (label, sort_order, is_builtin, created_at, updated_at)
        VALUES (?, ?, 0, ?, ?)
      `).run(label, Number(current.max_order) + 1, now(), now())
      return this.get(Number(result.lastInsertRowid))
    } catch (error) {
      if (String(error).includes('UNIQUE')) throw new AppServiceError('VALIDATION_ERROR', '状态名称已存在')
      throw error
    }
  }

  get(id: number): Status {
    const row = this.db.prepare('SELECT * FROM statuses WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!row) throw new AppServiceError('NOT_FOUND', '状态不存在')
    return mapStatus(row)
  }

  update(id: number, input: UpdateStatusInput): Status {
    const current = this.get(id)
    const label = input.label?.trim() ?? current.label
    if (!label) throw new AppServiceError('VALIDATION_ERROR', '状态名称不能为空')
    try {
      this.db.prepare('UPDATE statuses SET label = ?, updated_at = ? WHERE id = ?').run(label, now(), id)
      return this.get(id)
    } catch (error) {
      if (String(error).includes('UNIQUE')) throw new AppServiceError('VALIDATION_ERROR', '状态名称已存在')
      throw error
    }
  }

  delete(id: number): void {
    const transaction = this.db.transaction(() => {
      const used = this.db.prepare('SELECT COUNT(*) AS count FROM opportunities WHERE status_id = ?').get(id) as { count: number }
      if (Number(used.count) > 0) throw new AppServiceError('STATUS_IN_USE', '当前状态正在被使用，不能删除', { count: Number(used.count) })
      const total = this.db.prepare('SELECT COUNT(*) AS count FROM statuses').get() as { count: number }
      if (Number(total.count) <= 1) throw new AppServiceError('LAST_STATUS', '至少需要保留一个状态')
      const result = this.db.prepare('DELETE FROM statuses WHERE id = ?').run(id)
      if (result.changes === 0) throw new AppServiceError('NOT_FOUND', '状态不存在')
    })
    transaction()
  }

  reorder(order: number[]): Status[] {
    const current = this.list().map((status) => status.id)
    if (order.length !== current.length || new Set(order).size !== order.length || order.some((id) => !current.includes(id))) {
      throw new AppServiceError('VALIDATION_ERROR', '状态顺序无效')
    }
    const timestamp = now()
    const update = this.db.prepare('UPDATE statuses SET sort_order = ?, updated_at = ? WHERE id = ?')
    this.db.transaction(() => {
      order.forEach((id, index) => update.run(index, timestamp, id))
    })()
    return this.list()
  }
}

export class IndustryService {
  constructor(private readonly db: SqliteDatabase) {}

  list(): Industry[] {
    return (this.db.prepare('SELECT * FROM industries ORDER BY sort_order, id').all() as Record<string, unknown>[]).map(mapIndustry)
  }

  create(input: CreateIndustryInput): Industry {
    const name = input.name.trim()
    if (!name) throw new AppServiceError('VALIDATION_ERROR', '行业分类名称不能为空')
    const max = this.db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS max_order FROM industries').get() as { max_order: number }
    try {
      const result = this.db.prepare(`
        INSERT INTO industries (name, sort_order, is_builtin, created_at, updated_at)
        VALUES (?, ?, 0, ?, ?)
      `).run(name, Number(max.max_order) + 1, now(), now())
      return this.get(Number(result.lastInsertRowid))
    } catch (error) {
      if (String(error).includes('UNIQUE')) throw new AppServiceError('VALIDATION_ERROR', '行业分类名称已存在')
      throw error
    }
  }

  get(id: number): Industry {
    const row = this.db.prepare('SELECT * FROM industries WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!row) throw new AppServiceError('NOT_FOUND', '行业分类不存在')
    return mapIndustry(row)
  }

  update(id: number, input: UpdateIndustryInput): Industry {
    const current = this.get(id)
    const name = input.name?.trim() ?? current.name
    if (!name) throw new AppServiceError('VALIDATION_ERROR', '行业分类名称不能为空')
    try {
      this.db.prepare('UPDATE industries SET name = ?, updated_at = ? WHERE id = ?').run(name, now(), id)
      return this.get(id)
    } catch (error) {
      if (String(error).includes('UNIQUE')) throw new AppServiceError('VALIDATION_ERROR', '行业分类名称已存在')
      throw error
    }
  }

  delete(id: number): void {
    this.get(id)
    const used = this.db.prepare('SELECT COUNT(*) AS count FROM companies WHERE industry_id = ?').get(id) as { count: number }
    if (Number(used.count) > 0) throw new AppServiceError('INDUSTRY_IN_USE', '当前行业分类正在被公司使用，不能删除', { count: Number(used.count) })
    this.db.prepare('DELETE FROM industries WHERE id = ?').run(id)
  }

  reorder(order: number[]): Industry[] {
    const current = this.list().map((industry) => industry.id)
    if (order.length !== current.length || new Set(order).size !== order.length || order.some((id) => !current.includes(id))) {
      throw new AppServiceError('VALIDATION_ERROR', '行业分类顺序无效')
    }
    const timestamp = now()
    const update = this.db.prepare('UPDATE industries SET sort_order = ?, updated_at = ? WHERE id = ?')
    this.db.transaction(() => {
      order.forEach((id, index) => update.run(index, timestamp, id))
    })()
    return this.list()
  }
}

export class CompanyService {
  constructor(private readonly db: SqliteDatabase) {}

  search(keyword: string): Company[] {
    const value = `%${keyword.trim()}%`
    const rows = this.db.prepare(`
      SELECT c.*, i.name AS industry_name, COALESCE(GROUP_CONCAT(a.alias, char(31)), '') AS aliases FROM companies c
      LEFT JOIN industries i ON i.id = c.industry_id
      LEFT JOIN company_aliases a ON a.company_id = c.id
      WHERE ? = '%%' OR c.name LIKE ? OR COALESCE(i.name, '') LIKE ? OR EXISTS (SELECT 1 FROM company_aliases matched WHERE matched.company_id = c.id AND matched.alias LIKE ?)
      GROUP BY c.id
      ORDER BY c.is_favorite DESC, c.updated_at DESC, c.name
    `).all(value, value, value, value) as Record<string, unknown>[]
    return rows.map(mapCompany)
  }

  recent(): Company[] {
    return (this.db.prepare(`
      SELECT c.*, i.name AS industry_name, COALESCE(GROUP_CONCAT(a.alias, char(31)), '') AS aliases
      FROM companies c
      LEFT JOIN industries i ON i.id = c.industry_id
      LEFT JOIN company_aliases a ON a.company_id = c.id
      GROUP BY c.id
      ORDER BY c.updated_at DESC, c.name LIMIT 10
    `).all() as Record<string, unknown>[]).map(mapCompany)
  }

  create(input: CreateCompanyInput): Company {
    const name = input.name.trim()
    if (!name) throw new AppServiceError('VALIDATION_ERROR', '公司名称不能为空')
    this.validateIndustry(input.industryId)
    const aliases = normalizeAliases(input.aliases)
    try {
      return this.db.transaction(() => {
        const result = this.db.prepare(`
          INSERT INTO companies (name, industry_id, career_url, is_builtin, is_favorite, created_at, updated_at)
          VALUES (?, ?, ?, 0, 0, ?, ?)
        `).run(name, input.industryId ?? null, nullable(input.careerUrl), now(), now())
        const id = Number(result.lastInsertRowid)
        this.replaceAliases(id, aliases)
        return this.get(id)
      })()
    } catch (error) {
      if (String(error).includes('UNIQUE')) throw new AppServiceError('VALIDATION_ERROR', '公司名称已存在')
      throw error
    }
  }

  get(id: number): Company {
    const row = this.db.prepare(`
      SELECT c.*, i.name AS industry_name, COALESCE(GROUP_CONCAT(a.alias, char(31)), '') AS aliases
      FROM companies c
      LEFT JOIN industries i ON i.id = c.industry_id
      LEFT JOIN company_aliases a ON a.company_id = c.id
      WHERE c.id = ?
      GROUP BY c.id
    `).get(id) as Record<string, unknown> | undefined
    if (!row) throw new AppServiceError('NOT_FOUND', '公司不存在')
    return mapCompany(row)
  }

  update(id: number, input: UpdateCompanyInput): Company {
    const current = this.get(id)
    const name = input.name?.trim() ?? current.name
    if (!name) throw new AppServiceError('VALIDATION_ERROR', '公司名称不能为空')
    this.validateIndustry(input.industryId === undefined ? current.industryId : input.industryId)
    const aliases = input.aliases === undefined ? undefined : normalizeAliases(input.aliases)
    try {
      return this.db.transaction(() => {
        this.db.prepare('UPDATE companies SET name = ?, industry_id = ?, career_url = ?, is_favorite = ?, updated_at = ? WHERE id = ?').run(
          name,
          input.industryId === undefined ? current.industryId : input.industryId,
          input.careerUrl === undefined ? current.careerUrl : nullable(input.careerUrl),
          input.isFavorite === undefined ? (current.isFavorite ? 1 : 0) : (input.isFavorite ? 1 : 0),
          now(),
          id,
        )
        if (aliases !== undefined) this.replaceAliases(id, aliases)
        return this.get(id)
      })()
    } catch (error) {
      if (String(error).includes('UNIQUE')) throw new AppServiceError('VALIDATION_ERROR', '公司名称已存在')
      throw error
    }
  }

  delete(id: number): void {
    this.get(id)
    this.db.transaction(() => {
      const used = this.db.prepare('SELECT COUNT(*) AS count FROM opportunities WHERE company_id = ?').get(id) as { count: number }
      if (Number(used.count) > 0) throw new AppServiceError('COMPANY_IN_USE', '当前公司正在被使用，不能删除', { count: Number(used.count) })
      this.db.prepare('DELETE FROM company_aliases WHERE company_id = ?').run(id)
      const result = this.db.prepare('DELETE FROM companies WHERE id = ?').run(id)
      if (result.changes === 0) throw new AppServiceError('NOT_FOUND', '公司不存在')
    })()
  }

  private validateIndustry(industryId: number | null | undefined): void {
    if (industryId !== null && industryId !== undefined && !this.db.prepare('SELECT id FROM industries WHERE id = ?').get(industryId)) {
      throw new AppServiceError('VALIDATION_ERROR', '行业分类不存在')
    }
  }

  private replaceAliases(companyId: number, aliases: string[]): void {
    this.db.prepare('DELETE FROM company_aliases WHERE company_id = ?').run(companyId)
    const insert = this.db.prepare('INSERT INTO company_aliases (company_id, alias, created_at) VALUES (?, ?, ?)')
    const timestamp = now()
    aliases.forEach((alias) => insert.run(companyId, alias, timestamp))
  }
}

export class CompanyAliasService {
  constructor(private readonly db: SqliteDatabase) {}

  list(companyId: number): CompanyAlias[] {
    const rows = this.db.prepare('SELECT * FROM company_aliases WHERE company_id = ? ORDER BY alias').all(companyId) as Record<string, unknown>[]
    return rows.map((row) => ({ id: Number(row.id), companyId: Number(row.company_id), alias: String(row.alias), createdAt: Number(row.created_at) }))
  }

  create(input: CreateCompanyAliasInput): CompanyAlias {
    const alias = input.alias.trim()
    if (!alias) throw new AppServiceError('VALIDATION_ERROR', '公司别名不能为空')
    if (!this.db.prepare('SELECT id FROM companies WHERE id = ?').get(input.companyId)) throw new AppServiceError('VALIDATION_ERROR', '公司不存在')
    try {
      const result = this.db.prepare('INSERT INTO company_aliases (company_id, alias, created_at) VALUES (?, ?, ?)').run(input.companyId, alias, now())
      return this.get(Number(result.lastInsertRowid))
    } catch (error) {
      if (String(error).includes('UNIQUE')) throw new AppServiceError('VALIDATION_ERROR', '公司别名已存在')
      throw error
    }
  }

  update(id: number, input: UpdateCompanyAliasInput): CompanyAlias {
    const current = this.get(id)
    const alias = input.alias?.trim() ?? current.alias
    if (!alias) throw new AppServiceError('VALIDATION_ERROR', '公司别名不能为空')
    try {
      this.db.prepare('UPDATE company_aliases SET alias = ? WHERE id = ?').run(alias, id)
      return this.get(id)
    } catch (error) {
      if (String(error).includes('UNIQUE')) throw new AppServiceError('VALIDATION_ERROR', '公司别名已存在')
      throw error
    }
  }

  delete(id: number): void {
    const result = this.db.prepare('DELETE FROM company_aliases WHERE id = ?').run(id)
    if (result.changes === 0) throw new AppServiceError('NOT_FOUND', '公司别名不存在')
  }

  private get(id: number): CompanyAlias {
    const row = this.db.prepare('SELECT * FROM company_aliases WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!row) throw new AppServiceError('NOT_FOUND', '公司别名不存在')
    return { id: Number(row.id), companyId: Number(row.company_id), alias: String(row.alias), createdAt: Number(row.created_at) }
  }
}

export class ResumeVersionService {
  constructor(private readonly db: SqliteDatabase, private readonly files: FileStorageService) {}

  list(): ResumeVersion[] {
    return (this.db.prepare('SELECT * FROM resume_versions ORDER BY is_active DESC, updated_at DESC').all() as Record<string, unknown>[]).map(mapResume)
  }

  importFromPath(sourcePath: string, name?: string, note?: string): ResumeImportResult {
    const imported = this.files.importResume(sourcePath)
    try {
      const result = this.db.prepare(`
        INSERT INTO resume_versions (name, relative_path, size_bytes, sha256, note, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      `).run(name?.trim() || path.basename(sourcePath, path.extname(sourcePath)), imported.relativePath, imported.sizeBytes, imported.sha256, nullable(note), now(), now())
      const resume = this.get(Number(result.lastInsertRowid))
      return { ...resume, originalExtension: imported.originalExtension }
    } catch (error) {
      this.files.remove(imported.relativePath)
      throw error
    }
  }

  get(id: number): ResumeVersion {
    const row = this.db.prepare('SELECT * FROM resume_versions WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!row) throw new AppServiceError('NOT_FOUND', '简历版本不存在')
    return mapResume(row)
  }

  getPath(id: number): string {
    return this.files.resolve(this.get(id).relativePath)
  }

  update(id: number, input: UpdateResumeVersionInput): ResumeVersion {
    const current = this.get(id)
    const name = input.name?.trim() ?? current.name
    if (!name) throw new AppServiceError('VALIDATION_ERROR', '简历版本名称不能为空')
    this.db.prepare('UPDATE resume_versions SET name = ?, note = ?, is_active = ?, updated_at = ? WHERE id = ?').run(name, input.note === undefined ? current.note : nullable(input.note), input.isActive === undefined ? (current.isActive ? 1 : 0) : (input.isActive ? 1 : 0), now(), id)
    return this.get(id)
  }

  delete(id: number): void {
    const resume = this.get(id)
    const used = this.db.prepare('SELECT COUNT(*) AS count FROM opportunities WHERE resume_version_id = ?').get(id) as { count: number }
    if (Number(used.count) > 0) throw new AppServiceError('RESUME_IN_USE', '当前简历版本正在被使用，不能删除', { count: Number(used.count) })
    this.db.prepare('DELETE FROM resume_versions WHERE id = ?').run(id)
    this.files.remove(resume.relativePath)
  }
}

const OPPORTUNITY_SELECT = `
  SELECT o.*, c.name AS company_name, s.label AS status_label,
         r.name AS resume_version_name
  FROM opportunities o
  JOIN companies c ON c.id = o.company_id
  JOIN statuses s ON s.id = o.status_id
  LEFT JOIN resume_versions r ON r.id = o.resume_version_id
`

export class OpportunityService {
  constructor(private readonly db: SqliteDatabase) {}

  list(query: OpportunityQuery): Opportunity[] {
    const clauses: string[] = []
    const params: (string | number)[] = []
    if (query.search?.trim()) {
      clauses.push('(c.name LIKE ? OR EXISTS (SELECT 1 FROM company_aliases a WHERE a.company_id = c.id AND a.alias LIKE ?) OR o.title LIKE ? OR COALESCE(o.source, \'\') LIKE ? OR COALESCE(o.notes, \'\') LIKE ?)')
      const value = `%${query.search.trim()}%`
      params.push(value, value, value, value, value)
    }
    if (query.statusId) { clauses.push('o.status_id = ?'); params.push(query.statusId) }
    if (query.companyId) { clauses.push('o.company_id = ?'); params.push(query.companyId) }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.db.prepare(`${OPPORTUNITY_SELECT} ${where} ORDER BY COALESCE(o.deadline_at, 9223372036854775807), o.updated_at DESC`).all(...params) as Record<string, unknown>[]
    return rows.map(mapOpportunity)
  }

  create(input: CreateOpportunityInput): Opportunity {
    this.validateInput(input)
    const timestamp = now()
    const result = this.db.prepare(`
      INSERT INTO opportunities (
        company_id, title, department, location, source, job_url, description, status_id,
        resume_version_id, discovered_at, applied_at, deadline_at, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.companyId, input.title.trim(), nullable(input.department), nullable(input.location), nullable(input.source), nullable(input.jobUrl), nullable(input.description), input.statusId, input.resumeVersionId ?? null, input.discoveredAt ?? null, input.appliedAt ?? null, input.deadlineAt ?? null, nullable(input.notes), timestamp, timestamp)
    return this.get(Number(result.lastInsertRowid))
  }

  update(id: number, input: UpdateOpportunityInput): Opportunity {
    this.get(id)
    const existing = this.db.prepare('SELECT * FROM opportunities WHERE id = ?').get(id) as Record<string, unknown>
    const next = {
      companyId: input.companyId ?? Number(existing.company_id), title: input.title ?? String(existing.title),
      department: input.department === undefined ? existing.department as string | null : input.department,
      location: input.location === undefined ? existing.location as string | null : input.location,
      source: input.source === undefined ? existing.source as string | null : input.source,
      jobUrl: input.jobUrl === undefined ? existing.job_url as string | null : input.jobUrl,
      description: input.description === undefined ? existing.description as string | null : input.description,
      statusId: input.statusId ?? Number(existing.status_id), resumeVersionId: input.resumeVersionId === undefined ? existing.resume_version_id as number | null : input.resumeVersionId,
      discoveredAt: input.discoveredAt === undefined ? existing.discovered_at as number | null : input.discoveredAt,
      appliedAt: input.appliedAt === undefined ? existing.applied_at as number | null : input.appliedAt,
      deadlineAt: input.deadlineAt === undefined ? existing.deadline_at as number | null : input.deadlineAt,
      notes: input.notes === undefined ? existing.notes as string | null : input.notes,
    }
    this.validateInput(next)
    this.db.prepare(`
      UPDATE opportunities SET company_id = ?, title = ?, department = ?, location = ?, source = ?, job_url = ?,
      description = ?, status_id = ?, resume_version_id = ?, discovered_at = ?, applied_at = ?, deadline_at = ?, notes = ?, updated_at = ?
      WHERE id = ?
    `).run(next.companyId, next.title.trim(), nullable(next.department), nullable(next.location), nullable(next.source), nullable(next.jobUrl), nullable(next.description), next.statusId, next.resumeVersionId ?? null, next.discoveredAt ?? null, next.appliedAt ?? null, next.deadlineAt ?? null, nullable(next.notes), now(), id)
    return this.get(id)
  }

  changeStatus(id: number, statusId: number): Opportunity {
    this.get(id)
    this.requireStatus(statusId)
    this.db.prepare('UPDATE opportunities SET status_id = ?, updated_at = ? WHERE id = ?').run(statusId, now(), id)
    return this.get(id)
  }

  delete(id: number): void {
    this.db.transaction(() => {
      const result = this.db.prepare('DELETE FROM opportunities WHERE id = ?').run(id)
      if (result.changes === 0) throw new AppServiceError('NOT_FOUND', '求职记录不存在')
      this.db.prepare('UPDATE calendar_events SET opportunity_id = NULL, updated_at = ? WHERE opportunity_id = ?').run(now(), id)
    })()
  }

  get(id: number): Opportunity {
    const row = this.db.prepare(`${OPPORTUNITY_SELECT} WHERE o.id = ?`).get(id) as Record<string, unknown> | undefined
    if (!row) throw new AppServiceError('NOT_FOUND', '求职记录不存在')
    return mapOpportunity(row)
  }

  private requireStatus(id: number): void {
    const row = this.db.prepare('SELECT id FROM statuses WHERE id = ?').get(id)
    if (!row) throw new AppServiceError('VALIDATION_ERROR', '状态不存在')
  }

  private validateInput(input: { companyId: number; title: string; statusId: number; resumeVersionId?: number | null }): void {
    if (!input.title?.trim()) throw new AppServiceError('VALIDATION_ERROR', '岗位名称不能为空')
    if (!this.db.prepare('SELECT id FROM companies WHERE id = ?').get(input.companyId)) throw new AppServiceError('VALIDATION_ERROR', '公司不存在')
    this.requireStatus(input.statusId)
    if (input.resumeVersionId != null && !this.db.prepare('SELECT id FROM resume_versions WHERE id = ?').get(input.resumeVersionId)) throw new AppServiceError('VALIDATION_ERROR', '简历版本不存在')
  }
}

export class CalendarEventService {
  constructor(private readonly db: SqliteDatabase) {}

  list(range: CalendarRange): CalendarEvent[] {
    const rows = this.db.prepare(`
      SELECT e.*, o.title AS opportunity_title, c.name AS company_name
      FROM calendar_events e
      LEFT JOIN opportunities o ON o.id = e.opportunity_id
      LEFT JOIN companies c ON c.id = o.company_id
      WHERE e.start_at < ? AND e.end_at > ?
      ORDER BY e.start_at, e.id
    `).all(range.endAt, range.startAt) as Record<string, unknown>[]
    return rows.map(mapEvent)
  }

  create(input: CreateCalendarEventInput): CalendarEvent {
    this.validate(input)
    const timestamp = now()
    const result = this.db.prepare(`
      INSERT INTO calendar_events (
        opportunity_id, title, event_type, start_at, end_at, is_all_day, timezone,
        location, description, reminder_minutes, is_completed, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(input.opportunityId ?? null, input.title.trim(), input.eventType.trim(), input.startAt, input.endAt, input.isAllDay ? 1 : 0, input.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, nullable(input.location), nullable(input.description), input.reminderMinutes ?? null, timestamp, timestamp)
    return this.get(Number(result.lastInsertRowid))
  }

  update(id: number, input: UpdateCalendarEventInput): CalendarEvent {
    const existing = this.get(id)
    const next = { ...existing, ...input, title: input.title ?? existing.title, eventType: input.eventType ?? existing.eventType, startAt: input.startAt ?? existing.startAt, endAt: input.endAt ?? existing.endAt, isAllDay: input.isAllDay ?? existing.isAllDay, timezone: input.timezone ?? existing.timezone }
    this.validate({ ...next, opportunityId: next.opportunityId })
    this.db.prepare(`
      UPDATE calendar_events SET opportunity_id = ?, title = ?, event_type = ?, start_at = ?, end_at = ?, is_all_day = ?, timezone = ?, location = ?, description = ?, reminder_minutes = ?, updated_at = ? WHERE id = ?
    `).run(next.opportunityId ?? null, next.title.trim(), next.eventType.trim(), next.startAt, next.endAt, next.isAllDay ? 1 : 0, next.timezone, nullable(next.location), nullable(next.description), next.reminderMinutes ?? null, now(), id)
    return this.get(id)
  }

  complete(id: number, completed: boolean): CalendarEvent {
    this.get(id)
    this.db.prepare('UPDATE calendar_events SET is_completed = ?, updated_at = ? WHERE id = ?').run(completed ? 1 : 0, now(), id)
    return this.get(id)
  }

  delete(id: number): void {
    const result = this.db.prepare('DELETE FROM calendar_events WHERE id = ?').run(id)
    if (result.changes === 0) throw new AppServiceError('NOT_FOUND', '日程不存在')
  }

  get(id: number): CalendarEvent {
    const row = this.db.prepare(`
      SELECT e.*, o.title AS opportunity_title, c.name AS company_name
      FROM calendar_events e
      LEFT JOIN opportunities o ON o.id = e.opportunity_id
      LEFT JOIN companies c ON c.id = o.company_id
      WHERE e.id = ?
    `).get(id) as Record<string, unknown> | undefined
    if (!row) throw new AppServiceError('NOT_FOUND', '日程不存在')
    return mapEvent(row)
  }

  private validate(input: { title: string; eventType: string; startAt: number; endAt: number; opportunityId?: number | null }): void {
    if (!input.title?.trim() || !input.eventType?.trim()) throw new AppServiceError('VALIDATION_ERROR', '日程标题和类型不能为空')
    if (input.endAt < input.startAt) throw new AppServiceError('VALIDATION_ERROR', '日程结束时间不能早于开始时间')
    if (input.opportunityId != null && !this.db.prepare('SELECT id FROM opportunities WHERE id = ?').get(input.opportunityId)) throw new AppServiceError('VALIDATION_ERROR', '关联的求职记录不存在')
  }
}

export interface Services {
  statuses: StatusService
  industries: IndustryService
  companies: CompanyService
  companyAliases: CompanyAliasService
  resumes: ResumeVersionService
  opportunities: OpportunityService
  calendar: CalendarEventService
}
