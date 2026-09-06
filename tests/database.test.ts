import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AppPaths } from '../src/main/config'
import { BUILTIN_COMPANIES } from '../src/main/builtin-companies'
import { DatabaseManager } from '../src/main/database'
import { FileStorageService } from '../src/main/file-storage'
import { createServices, type Services } from '../src/main/service-container'
import { AppServiceError } from '../src/main/services/errors'

describe('职迹最终数据库结构和业务服务', () => {
  let root: string
  let paths: AppPaths
  let database: DatabaseManager | undefined
  let services: Services
  let files: FileStorageService

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'zhiji-test-'))
    paths = { root, config: path.join(root, 'config.json'), data: path.join(root, 'data'), database: path.join(root, 'data', 'zhiji.db'), resumes: path.join(root, 'resumes') }
    database = new DatabaseManager(paths)
    files = new FileStorageService(paths)
    services = createServices(database, files, false)
  })

  afterEach(() => {
    database?.close()
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('creates the final schema before seeding and has no migration or physical foreign key', () => {
    const names = (database!.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((item) => item.name)
    expect(names).toEqual(expect.arrayContaining(['statuses', 'industries', 'companies', 'company_industries', 'company_aliases', 'resume_versions', 'opportunities', 'calendar_events', 'calendar_event_reminders']))
    expect(names).not.toEqual(expect.arrayContaining(['schema_migrations', 'app_settings', 'opportunity_status_history']))
    expect((database!.db.prepare('SELECT COUNT(*) AS count FROM industries').get() as { count: number }).count).toBe(83)
    expect(services.industries.list().map((industry) => industry.id)).toEqual(Array.from({ length: 83 }, (_, index) => index + 1))
    expect(new Set(services.industries.list().map((industry) => industry.name)).size).toBe(83)
    expect(services.statuses.list().map((status) => ({ id: status.id, label: status.label, sortOrder: status.sortOrder }))).toEqual([
      { id: 1, label: '感兴趣', sortOrder: 1 }, { id: 2, label: '待投递', sortOrder: 2 }, { id: 3, label: '初筛', sortOrder: 3 },
      { id: 4, label: '笔试', sortOrder: 4 }, { id: 5, label: 'AI面试', sortOrder: 5 }, { id: 6, label: '一面', sortOrder: 6 },
      { id: 7, label: '二面', sortOrder: 7 }, { id: 8, label: '三面', sortOrder: 8 }, { id: 9, label: 'HR面', sortOrder: 9 },
      { id: 10, label: 'Offer', sortOrder: 10 }, { id: 11, label: '淘汰', sortOrder: 11 }, { id: 12, label: '主动放弃', sortOrder: 12 },
    ])
    expect((database!.db.prepare('SELECT COUNT(*) AS count FROM companies').get() as { count: number }).count).toBe(BUILTIN_COMPANIES.length)
    expect((database!.db.prepare('SELECT COUNT(*) AS count FROM companies c WHERE NOT EXISTS (SELECT 1 FROM company_industries ci WHERE ci.company_id = c.id)').get() as { count: number }).count).toBe(0)
    expect(database!.db.pragma('user_version', { simple: true })).toBe(8)
    const resumeColumns = (database!.db.prepare('PRAGMA table_info(resume_versions)').all() as Array<{ name: string }>).map((column) => column.name)
    expect(resumeColumns).toEqual(expect.arrayContaining(['sort_order']))
    expect(resumeColumns).not.toContain('is_active')
    const companyColumns = (database!.db.prepare('PRAGMA table_info(companies)').all() as Array<{ name: string }>).map((column) => column.name)
    expect(companyColumns).toContain('last_read_at')
    expect(companyColumns).not.toContain('industry_id')
    for (const table of ['companies', 'company_industries', 'company_aliases', 'opportunities', 'calendar_events', 'calendar_event_reminders']) expect(database!.db.prepare(`PRAGMA foreign_key_list(${table})`).all()).toHaveLength(0)
    expect(database!.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_company_industries_industry_id'").get()).toBeDefined()
    expect(database!.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_calendar_event_reminders_event_id'").get()).toBeUndefined()
  })

  it('fails before executing schema SQL for an unsupported database version', () => {
    const unsupportedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zhiji-version-'))
    const unsupportedDatabasePath = path.join(unsupportedRoot, 'data', 'zhiji.db')
    fs.mkdirSync(path.dirname(unsupportedDatabasePath), { recursive: true })
    const rawDatabase = new Database(unsupportedDatabasePath)
    rawDatabase.pragma('user_version = 4')
    rawDatabase.close()
    const unsupportedPaths: AppPaths = {
      root: unsupportedRoot,
      config: path.join(unsupportedRoot, 'config.json'),
      data: path.join(unsupportedRoot, 'data'),
      database: unsupportedDatabasePath,
      resumes: path.join(unsupportedRoot, 'resumes'),
    }

    try {
      expect(() => new DatabaseManager(unsupportedPaths)).toThrow('不支持的数据库结构版本')
      const inspection = new Database(unsupportedDatabasePath, { readonly: true })
      expect(inspection.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toHaveLength(0)
      inspection.close()
    } finally {
      fs.rmSync(unsupportedRoot, { recursive: true, force: true })
    }
  })

  it('protects built-in data and logical references', () => {
    const status = services.statuses.list()[0]
    const industry = services.industries.list()[0]
    const company = services.companies.search('')[0]
    for (const action of [
      () => services.statuses.update(status.id, { label: '禁止' }),
      () => services.statuses.delete(status.id),
      () => services.industries.update(industry.id, { name: '禁止' }),
      () => services.industries.delete(industry.id),
      () => services.companies.update(company.id, { name: '禁止' }),
      () => services.companies.delete(company.id),
    ]) {
      expect(action).toThrowError(AppServiceError)
      try { action() } catch (error) { expect((error as AppServiceError).code).toBe('BUILTIN_DATA'); expect((error as AppServiceError).message).toBe('该数据为内置，无法删除/修改') }
    }
    expect(services.companies.update(company.id, { isFavorite: !company.isFavorite }).isFavorite).toBe(!company.isFavorite)

    const customIndustry = services.industries.create({ name: '测试行业' })
    const customCompany = services.companies.create({ name: '测试公司', industryIds: [customIndustry.id], aliases: ['简称'] })
    expect(() => services.industries.delete(customIndustry.id)).toThrowError(AppServiceError)
    const opportunity = services.opportunities.create({ companyId: customCompany.id, title: '测试岗位', statusId: status.id })
    expect(() => services.companies.delete(customCompany.id)).toThrowError(AppServiceError)
    services.opportunities.delete(opportunity.id)
    services.companies.delete(customCompany.id)
    services.industries.delete(customIndustry.id)
  })

  it('supports status and industry CRUD and ordering', () => {
    const status = services.statuses.create({ label: '复试' })
    expect(services.statuses.get(status.id).label).toBe('复试')
    expect(services.statuses.update(status.id, { label: '复试更新' }).label).toBe('复试更新')
    const statusOrder = services.statuses.list().map((item) => item.id)
    expect(services.statuses.reorder([status.id, ...statusOrder.filter((id) => id !== status.id)])[0].id).toBe(status.id)
    services.statuses.delete(status.id)
    expect(() => services.statuses.get(status.id)).toThrowError(AppServiceError)

    const industry = services.industries.create({ name: '其他行业' })
    expect(services.industries.update(industry.id, { name: '其他行业更新' }).name).toBe('其他行业更新')
    services.industries.delete(industry.id)
    expect(() => services.industries.delete(industry.id)).toThrowError(AppServiceError)
  })

  it('allows full built-in CRUD under the development policy while keeping reference protection', () => {
    const developmentServices = createServices(database!, files, true)
    const status = developmentServices.statuses.list()[0]
    const industries = developmentServices.industries.list()
    const companies = developmentServices.companies.list()
    const industry = industries.find((item) => companies.every((company) => !company.industryIds.includes(item.id)))
    const company = developmentServices.companies.list()[0]

    expect(developmentServices.statuses.update(status.id, { label: '开发状态' }).label).toBe('开发状态')
    expect(industry).toBeDefined()
    expect(developmentServices.industries.update(industry!.id, { name: '开发行业' }).name).toBe('开发行业')
    expect(developmentServices.companies.update(company.id, { careerUrl: 'https://dev.example.com' }).careerUrl).toBe('https://dev.example.com')

    developmentServices.statuses.delete(status.id)
    developmentServices.industries.delete(industry!.id)
    developmentServices.companies.delete(company.id)
  })

  it('manages company aliases internally and searches by alias', () => {
    const company = services.companies.create({ name: '别名公司', aliases: ['Alias One', '简称'] })
    expect(services.companies.list().map((item) => item.id)).toContain(company.id)
    expect(services.companies.search('简称').map((item) => item.id)).toContain(company.id)
    expect(services.companies.search('Alias One').map((item) => item.id)).toContain(company.id)
    expect(services.companies.update(company.id, { aliases: ['新简称'] }).aliases).toEqual(['新简称'])
    expect(services.companies.search('Alias One').map((item) => item.id)).not.toContain(company.id)
    services.companies.delete(company.id)
  })

  it('manages company industries through a many-to-many relation', () => {
    const firstIndustry = services.industries.create({ name: '多行业一' })
    const secondIndustry = services.industries.create({ name: '多行业二' })
    const company = services.companies.create({ name: '多行业公司', industryIds: [secondIndustry.id, firstIndustry.id] })

    expect(company.industryIds).toEqual([firstIndustry.id, secondIndustry.id])
    expect(company.industryName).toBe('多行业一, 多行业二')
    expect(services.companies.search('多行业一').map((item) => item.id)).toContain(company.id)
    expect(services.companies.search('多行业二').map((item) => item.id)).toContain(company.id)
    expect((database!.db.prepare('SELECT COUNT(*) AS count FROM company_industries WHERE company_id = ?').get(company.id) as { count: number }).count).toBe(2)

    const updated = services.companies.update(company.id, { industryIds: [secondIndustry.id] })
    expect(updated.industryIds).toEqual([secondIndustry.id])
    expect(() => services.industries.delete(secondIndustry.id)).toThrowError(AppServiceError)

    services.companies.update(company.id, { industryIds: [] })
    expect(services.companies.get(company.id).industryIds).toEqual([])
    services.industries.delete(firstIndustry.id)
    services.industries.delete(secondIndustry.id)
    services.companies.delete(company.id)
    expect((database!.db.prepare('SELECT COUNT(*) AS count FROM company_industries WHERE company_id = ?').get(company.id) as { count: number }).count).toBe(0)
  })

  it('records the last company career-site read time', () => {
    const company = services.companies.list()[0]
    expect(company.lastReadAt).toBeNull()
    const updated = services.companies.markRead(company.id)
    expect(updated.lastReadAt).toEqual(expect.any(Number))
  })

  it('sorts companies by favorite first and then by name', () => {
    const first = services.companies.create({ name: '排序A' })
    const second = services.companies.create({ name: '排序B' })
    services.companies.update(second.id, { isFavorite: true })

    const customCompanies = () => services.companies.list().filter((company) => company.id === first.id || company.id === second.id)
    expect(customCompanies().map((company) => company.name)).toEqual(['排序B', '排序A'])

    services.companies.update(second.id, { isFavorite: false })
    expect(customCompanies().map((company) => company.name)).toEqual(['排序A', '排序B'])
    services.companies.delete(first.id)
    services.companies.delete(second.id)
  })

  it('imports UUID-named resumes and protects referenced files', () => {
    const source = path.join(root, 'candidate.pdf')
    fs.writeFileSync(source, 'resume-content')
    const resume = services.resumes.importFromPath(source, '技术简历')
    const secondSource = path.join(root, 'candidate-second.pdf')
    fs.writeFileSync(secondSource, 'second-resume-content')
    const secondResume = services.resumes.importFromPath(secondSource, '产品简历')
    expect(resume.relativePath).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.pdf$/i)
    expect(resume.sortOrder).toBe(0)
    expect(secondResume.sortOrder).toBe(1)
    expect(services.resumes.reorder([secondResume.id, resume.id])[0].id).toBe(secondResume.id)
    expect(fs.readFileSync(services.resumes.getPath(resume.id), 'utf8')).toBe('resume-content')
    const company = services.companies.create({ name: '简历公司' })
    const opportunity = services.opportunities.create({ companyId: company.id, title: '岗位', statusId: services.statuses.list()[0].id, resumeVersionId: resume.id })
    expect(() => services.resumes.delete(resume.id)).toThrowError(AppServiceError)
    services.opportunities.delete(opportunity.id)
    services.resumes.delete(resume.id)
    services.resumes.delete(secondResume.id)
    expect(() => services.resumes.get(resume.id)).toThrowError(AppServiceError)
  })

  it('supports opportunity, calendar, and reminder CRUD', () => {
    const company = services.companies.create({ name: '链路公司', aliases: ['链路'] })
    const status = services.statuses.list()[0]
    const opportunity = services.opportunities.create({ companyId: company.id, title: '后端工程师', statusId: status.id, location: '上海' })
    expect(services.opportunities.list({ search: '链路' }).map((item) => item.id)).toContain(opportunity.id)
    expect(services.opportunities.update(opportunity.id, { title: '前端工程师' }).title).toBe('前端工程师')
    const startAt = Date.now() - 10 * 60 * 1000
    const event = services.calendar.create({ opportunityId: opportunity.id, title: '面试', eventType: 'interview', startAt, endAt: startAt + 60 * 60 * 1000, timezone: 'Asia/Shanghai', reminderMinutes: 5 })
    expect(services.calendar.get(event.id).companyName).toBe('链路公司')
    expect(services.calendar.list({ startAt: startAt - 1, endAt: startAt + 60 * 60 * 1000 + 1 }).map((item) => item.id)).toContain(event.id)
    expect(services.calendar.complete(event.id, true).isCompleted).toBe(true)
    services.calendar.complete(event.id, false)
    const due = services.reminders.listDue(Date.now())
    expect(due.map((item) => item.eventId)).toContain(event.id)
    services.reminders.markSent(event.id, due.find((item) => item.eventId === event.id)!.reminderAt)
    expect(services.reminders.listDue(Date.now()).map((item) => item.eventId)).not.toContain(event.id)
    services.calendar.delete(event.id)
    services.opportunities.delete(opportunity.id)
    services.companies.delete(company.id)
  })
})
