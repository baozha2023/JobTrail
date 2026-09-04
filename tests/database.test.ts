import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AppPaths } from '../src/main/config'
import { DatabaseManager } from '../src/main/database'
import { AppServiceError, CalendarEventService, CompanyService, IndustryService, OpportunityService, StatusService } from '../src/main/services'

describe('职迹 database services', () => {
  let root: string
  let paths: AppPaths
  let database: DatabaseManager

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'zhiji-test-'))
    paths = {
      root,
      config: path.join(root, 'config.json'),
      data: path.join(root, 'data'),
      database: path.join(root, 'data', 'zhiji.db'),
      resumes: path.join(root, 'resumes'),
    }
    database = new DatabaseManager(paths)
  })

  afterEach(() => {
    database.close()
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('creates the planned tables without legacy tables', () => {
    const tables = database.db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
    `).all() as Array<{ name: string }>
    const names = tables.map((item) => item.name)
    expect(names).toEqual(expect.arrayContaining([
      'statuses', 'industries', 'companies', 'company_aliases', 'resume_versions', 'opportunities', 'calendar_events',
    ]))
    expect(names).not.toContain('schema_migrations')
    expect(names).not.toContain('app_settings')
    expect(names).not.toContain('opportunity_status_history')
    expect((database.db.prepare('SELECT COUNT(*) AS count FROM industries').get() as { count: number }).count).toBe(43)
    expect((database.db.prepare(`
      SELECT COUNT(*) AS count FROM industries
      WHERE id BETWEEN 1 AND 43 AND sort_order = id - 1 AND is_builtin = 1
    `).get() as { count: number }).count).toBe(43)
    expect((database.db.prepare('SELECT COUNT(*) AS count FROM companies').get() as { count: number }).count).toBe(159)
    expect(database.db.prepare('SELECT id, name, sort_order, is_builtin FROM industries WHERE id = ?').get(1)).toEqual({
      id: 1, name: '互联网', sort_order: 0, is_builtin: 1,
    })
    expect((database.db.prepare('SELECT industry_id FROM companies WHERE name = ?').get('腾讯') as { industry_id: number }).industry_id).toBe(1)
    expect((database.db.prepare(`
      SELECT COUNT(*) AS count FROM companies c
      LEFT JOIN industries i ON i.id = c.industry_id
      WHERE c.is_builtin = 1 AND (i.id IS NULL OR i.is_builtin <> 1)
    `).get() as { count: number }).count).toBe(0)
    expect((database.db.prepare('SELECT COUNT(*) AS count FROM company_aliases').get() as { count: number }).count).toBe(159)
    expect((database.db.prepare('SELECT COUNT(DISTINCT company_id) AS count FROM company_aliases').get() as { count: number }).count).toBe(159)
    expect((database.db.prepare(`
      SELECT COUNT(*) AS count FROM companies c
      LEFT JOIN company_aliases a ON a.company_id = c.id
      WHERE c.is_builtin = 1 AND a.id IS NULL
    `).get() as { count: number }).count).toBe(0)
    expect((database.db.prepare(`
      SELECT COUNT(*) AS count FROM company_aliases a
      LEFT JOIN companies c ON c.id = a.company_id
      WHERE c.id IS NULL
    `).get() as { count: number }).count).toBe(0)
    expect(database.db.prepare('SELECT 1 FROM company_aliases WHERE alias = ?').get('MiniMax')).toBeUndefined()
    expect(database.db.prepare('SELECT 1 FROM company_aliases WHERE alias = ?').get('稀宇科技')).toBeTruthy()
    expect((database.db.prepare(`
      SELECT c.name FROM companies c
      INNER JOIN company_aliases a ON a.company_id = c.id
      WHERE a.alias = ?
    `).get('稀宇科技') as { name: string }).name).toBe('MiniMax')
    expect(database.db.pragma('user_version', { simple: true })).toBe(3)
    for (const table of ['companies', 'company_aliases', 'opportunities', 'calendar_events']) {
      expect(database.db.prepare(`PRAGMA foreign_key_list(${table})`).all()).toHaveLength(0)
    }
  })

  it('syncs new built-in companies and corrected recruitment links for an existing database', () => {
    const miniMax = database.db.prepare('SELECT id FROM companies WHERE name = ?').get('MiniMax') as { id: number }
    database.db.prepare('UPDATE companies SET career_url = ? WHERE id = ?').run('https://www.minimaxi.com/', miniMax.id)
    database.db.prepare('INSERT INTO company_aliases (company_id, alias, created_at) VALUES (?, ?, ?)').run(miniMax.id, 'MiniMax', Date.now())
    const tme = database.db.prepare('SELECT id FROM companies WHERE name = ?').get('腾讯音乐') as { id: number }
    database.db.prepare('DELETE FROM company_aliases WHERE company_id = ?').run(tme.id)
    database.db.prepare('DELETE FROM companies WHERE id = ?').run(tme.id)

    database.close()
    database = new DatabaseManager(paths)

    expect((database.db.prepare('SELECT COUNT(*) AS count FROM companies').get() as { count: number }).count).toBe(159)
    expect((database.db.prepare('SELECT career_url FROM companies WHERE name = ?').get('MiniMax') as { career_url: string }).career_url).toBe('https://www.minimaxi.com/careers')
    expect(database.db.prepare('SELECT 1 FROM companies WHERE name = ?').get('腾讯音乐')).toBeTruthy()
    expect(database.db.prepare('SELECT 1 FROM company_aliases WHERE alias = ?').get('MiniMax')).toBeUndefined()
    expect(database.db.prepare('SELECT 1 FROM company_aliases WHERE alias = ?').get('稀宇科技')).toBeTruthy()
  })

  it('blocks deleting a status that is in use', () => {
    const statuses = new StatusService(database.db)
    const companies = database.db.prepare('SELECT id FROM companies LIMIT 1').get() as { id: number }
    const status = statuses.list()[0]
    database.db.prepare(`
      INSERT INTO opportunities (company_id, title, status_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(companies.id, '测试岗位', status.id, Date.now(), Date.now())

    try {
      statuses.delete(status.id)
      throw new Error('expected deletion to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(AppServiceError)
      expect((error as AppServiceError).code).toBe('STATUS_IN_USE')
    }
  })

  it('supports creating and changing an opportunity status', () => {
    const statuses = new StatusService(database.db)
    const opportunities = new OpportunityService(database.db)
    const company = database.db.prepare('SELECT id FROM companies LIMIT 1').get() as { id: number }
    const status = statuses.list()[0]
    const created = opportunities.create({ companyId: company.id, title: '前端工程师', statusId: status.id })
    expect(created.title).toBe('前端工程师')

    const nextStatus = statuses.create({ label: '复试' })
    const updated = opportunities.changeStatus(created.id, nextStatus.id)
    expect(updated.statusLabel).toBe('复试')
  })

  it('persists the display order of statuses', () => {
    const statuses = new StatusService(database.db)
    const ids = statuses.list().map((status) => status.id)
    const reordered = [ids[1], ids[0], ...ids.slice(2)]
    expect(statuses.reorder(reordered).map((status) => status.id)).toEqual(reordered)
  })

  it('persists the display order of industries', () => {
    const industries = new IndustryService(database.db)
    const ids = industries.list().map((industry) => industry.id)
    const reordered = [ids[1], ids[0], ...ids.slice(2)]
    expect(industries.reorder(reordered).map((industry) => industry.id)).toEqual(reordered)
  })

  it('joins companies with industries and protects used industries', () => {
    const industries = new IndustryService(database.db)
    const companies = new CompanyService(database.db)
    const industry = industries.create({ name: '测试行业' })
    const company = companies.create({ name: '测试公司', industryId: industry.id })
    expect(companies.get(company.id).industryName).toBe('测试行业')

    let caught: unknown
    try {
      industries.delete(industry.id)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(AppServiceError)
    expect((caught as AppServiceError).code).toBe('INDUSTRY_IN_USE')
  })

  it('stores company aliases and searches opportunities by alias', () => {
    const statuses = new StatusService(database.db)
    const companies = new CompanyService(database.db)
    const opportunities = new OpportunityService(database.db)
    const company = companies.create({ name: '别名测试公司', aliases: ['测试简称', 'Test Alias'] })

    expect(company.aliases).toEqual(['Test Alias', '测试简称'])
    expect(companies.search('测试简称').map((item) => item.id)).toContain(company.id)

    const opportunity = opportunities.create({ companyId: company.id, title: '别名岗位', statusId: statuses.list()[0].id })
    expect(opportunities.list({ search: '测试简称' }).map((item) => item.id)).toContain(opportunity.id)

    const updated = companies.update(company.id, { aliases: ['更新简称'] })
    expect(updated.aliases).toEqual(['更新简称'])
    expect(companies.search('测试简称').map((item) => item.id)).not.toContain(company.id)
    expect(companies.search('更新简称').map((item) => item.id)).toContain(company.id)
  })

  it('maintains logical references and cleanup in services', () => {
    const statuses = new StatusService(database.db)
    const companies = new CompanyService(database.db)
    const opportunities = new OpportunityService(database.db)
    const calendar = new CalendarEventService(database.db)
    const company = companies.create({ name: '逻辑关联公司', industryId: null })
    const alias = database.db.prepare('INSERT INTO company_aliases (company_id, alias, created_at) VALUES (?, ?, ?)').run(company.id, '逻辑关联', Date.now())
    const opportunity = opportunities.create({ companyId: company.id, title: '逻辑关联岗位', statusId: statuses.list()[0].id })
    const event = calendar.create({ title: '逻辑关联日程', eventType: 'interview', startAt: Date.now(), endAt: Date.now() + 60_000, opportunityId: opportunity.id })

    let caught: unknown
    try {
      companies.delete(company.id)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(AppServiceError)
    expect((caught as AppServiceError).code).toBe('COMPANY_IN_USE')
    opportunities.delete(opportunity.id)
    expect(calendar.get(event.id).opportunityId).toBeNull()
    companies.delete(company.id)
    expect(database.db.prepare('SELECT id FROM company_aliases WHERE id = ?').get(alias.lastInsertRowid)).toBeUndefined()
  })
})
