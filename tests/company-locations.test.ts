import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServiceContainer } from '../src/main/service-container'
import {
  BUNDLED_COMPANY_CATALOG,
  companyCatalogHash,
  parseCompanyCatalog,
} from '../src/main/company-catalog'
import { CompanyCatalogRepository } from '../src/main/repositories/company-catalog-repository'
import {
  parseCompany,
  parseCompanyQuery,
  parseCompanyLocationQuery,
} from '../src/main/ipc/validators'
import {
  createCompanyInputSchema,
  updateCompanyInputSchema,
  companySchema,
} from '../src/main/mcp/schemas'
import { MCP_TOOLS } from '../src/main/mcp-contracts'
import { validateDatabaseVersion } from '../src/main/persistence/validation'

describe('company office locations', () => {
  let root: string
  let container: ReturnType<typeof createServiceContainer>
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrail-locations-'))
    container = createServiceContainer(
      {
        root,
        data: path.join(root, 'data'),
        database: path.join(root, 'data/zhiji.db'),
        config: path.join(root, 'config.json'),
        resumes: path.join(root, 'resumes'),
        chatUploads: path.join(root, 'chat-uploads'),
      },
      false,
    )
    // Dictionary lifecycle tests need a controlled starting set, regardless of
    // how many locations the real release catalog contains. Use the normal
    // catalog transaction so companies and industries remain valid fixtures.
    const source = catalog()
    container.services.companyCatalog.synchronize(source, companyCatalogHash(source))
  })
  afterEach(() => {
    vi.restoreAllMocks()
    container.database.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const page = { page: 1, pageSize: 50 }
  const catalog = () =>
    parseCompanyCatalog({
      ...structuredClone(BUNDLED_COMPANY_CATALOG),
      companies: BUNDLED_COMPANY_CATALOG.companies.map((company) => ({
        ...structuredClone(company),
        locations: [],
      })),
      catalogVersion: container.services.companyCatalog.status().catalogVersion + 1,
    })

  it('shares normalized labels, preserves partial updates, and cleans only the final reference', () => {
    const service = container.services.companies
    const a = service.create({ name: 'A', locations: [' 上海 ', '上海', '北京'] })
    const b = service.create({ name: 'B', locations: ['上海'] })
    expect(a.locations).toEqual(['上海', '北京'])
    expect(service.searchLocations(page).items).toEqual(['上海', '北京'])
    expect(service.update(a.id, { isFavorite: true }).locations).toEqual(a.locations)
    expect(service.markRead(a.id).locations).toEqual(a.locations)
    service.update(a.id, { locations: ['上海市'] })
    expect(service.get(b.id).locations).toEqual(['上海'])
    expect(service.searchLocations(page).items).toEqual(['上海', '上海市'])
    service.delete(b.id)
    expect(service.searchLocations(page).items).toEqual(['上海市'])
    service.update(a.id, { locations: [] })
    expect(service.searchLocations(page)).toMatchObject({ items: [], total: 0 })
    validateDatabaseVersion(container.database.db, 3)
  })

  it('uses OR within locations and AND with names, aliases and industry, without duplicate rows', () => {
    const service = container.services.companies
    const leaf = container.services.industries.list().find((item) => item.parentId !== null)!
    const a = service.create({
      name: 'LocationFixture A',
      locations: ['上海'],
      industryIds: [leaf.id],
    })
    const b = service.create({
      name: 'LocationFixture B',
      locations: ['北京'],
      industryIds: [leaf.id],
    })
    const c = service.create({
      name: 'LocationFixture C',
      locations: ['上海', '北京'],
      aliases: ['Target'],
    })
    service.create({ name: 'LocationFixture D', locations: ['深圳'] })
    service.create({ name: 'LocationFixture empty' })
    const query = { page: 1, pageSize: 2, locations: ['北京', '上海'] }
    expect(service.search(query)).toMatchObject({ total: 3, items: [a, b] })
    expect(service.search({ ...query, page: 2 }).items).toEqual([c])
    expect(service.search({ ...query, keyword: 'Target' }).items).toEqual([c])
    expect(service.search({ ...query, industryId: leaf.parentId }).total).toBe(2)
    expect(service.search({ ...query, locations: ['不存在'] }).total).toBe(0)
    expect(service.search({ ...query, locations: [], keyword: 'LocationFixture' }).total).toBe(5)
  })

  it('paginates prefix suggestions and escapes wildcard characters without changing exact identity', () => {
    const service = container.services.companies
    service.create({
      name: 'Prefix',
      locations: [
        '上海',
        '上海市',
        '海口',
        'New York',
        'new york',
        '%_\\office',
        '%other',
        ...Array.from({ length: 55 }, (_, i) => `Office ${String(i).padStart(2, '0')}`),
      ],
    })
    expect(service.searchLocations({ ...page, prefix: ' 上 ' }).items).toEqual(['上海', '上海市'])
    expect(service.searchLocations({ ...page, prefix: '海' }).items).toEqual(['海口'])
    expect(service.searchLocations({ ...page, prefix: 'NEW' }).items).toEqual([
      'New York',
      'new york',
    ])
    expect(service.searchLocations({ ...page, prefix: '%_\\' }).items).toEqual(['%_\\office'])
    expect(service.searchLocations({ ...page, prefix: 'Office ' })).toMatchObject({
      total: 55,
      items: expect.any(Array),
    })
    expect(service.searchLocations({ ...page, prefix: 'Office', page: 2 }).items).toHaveLength(5)
  })

  it('never queries or returns locations for company summaries', () => {
    const service = container.services.companies
    const a = service.create({ name: 'Summary', locations: ['上海'] })
    const spy = vi.spyOn(container.database.db, 'prepare')
    const summaries = service.list()
    expect(summaries.find((item) => item.id === a.id)).not.toHaveProperty('locations')
    expect(spy.mock.calls.some(([sql]) => /\blocations\b|\bcompany_locations\b/.test(sql))).toBe(
      false,
    )
    spy.mockClear()
    expect(service.search({ ...page, keyword: 'Summary' }).items[0].locations).toEqual(['上海'])
    expect(spy.mock.calls.filter(([sql]) => sql.includes('JOIN locations')).length).toBe(1)
  })

  it('rejects invalid labels at IPC, MCP and service boundaries while accepting clear operations', () => {
    const service = container.services.companies
    for (const locations of [
      null,
      '上海',
      [1],
      [' '],
      ['x'.repeat(201)],
      Array(101).fill('上海'),
    ]) {
      expect(() => parseCompany({ name: 'Invalid', locations }, false)).toThrow()
      expect(() => parseCompanyQuery({ ...page, locations })).toThrow()
      expect(createCompanyInputSchema.safeParse({ name: 'Invalid', locations }).success).toBe(false)
      expect(updateCompanyInputSchema.safeParse({ locations }).success).toBe(false)
      expect(() => service.create({ name: 'Invalid', locations: locations as string[] })).toThrow()
    }
    expect(updateCompanyInputSchema.safeParse({ locations: [] }).success).toBe(true)
    expect(() => parseCompanyLocationQuery({ ...page, prefix: null })).toThrow()
    expect(() => service.searchLocations({ ...page, pageSize: 101 })).toThrow()
    const company = service.create({ name: 'Contract', locations: ['上海'] })
    expect(companySchema.safeParse(company).success).toBe(true)
    const search = MCP_TOOLS.find((tool) => tool.name === 'search_companies')!
    expect(search.inputSchema.safeParse({ ...page, locations: ['上海', '北京'] }).success).toBe(
      true,
    )
    expect(service.searchLocations(page).items).toEqual(['上海'])
  })

  it('protects built-ins and referenced companies and rolls back dictionary and relationship writes', () => {
    const service = container.services.companies
    expect(() => service.update(1, { locations: ['上海'] })).toThrowError(
      expect.objectContaining({ code: 'BUILTIN_DATA' }),
    )
    const a = service.create({ name: 'Used', locations: ['上海'] })
    container.services.opportunities.create({
      companyId: a.id,
      title: 'Role',
      statusId: container.services.statuses.list()[0].id,
    })
    expect(() => service.delete(a.id)).toThrowError(
      expect.objectContaining({ code: 'COMPANY_IN_USE' }),
    )
    expect(() =>
      container.unitOfWork.run(() => {
        service.update(a.id, { locations: ['北京'] })
        throw new Error('injected')
      }),
    ).toThrow('injected')
    expect(service.get(a.id).locations).toEqual(['上海'])
    expect(service.searchLocations(page).items).toEqual(['上海'])
  })

  it('synchronizes catalogs in one transaction, reuses moved labels, and preserves converted company locations', () => {
    const source = catalog()
    source.companies[0].locations = ['Shared', '上海']
    container.services.companyCatalog.synchronize(source, companyCatalogHash(source))
    const id = (
      container.database.db.prepare('SELECT id FROM locations WHERE name = ?').get('Shared') as {
        id: number
      }
    ).id
    const next = structuredClone(source)
    next.catalogVersion++
    next.companies[0].locations = ['上海', '苏州']
    next.companies[1].locations = ['Shared']
    container.services.companyCatalog.synchronize(next, companyCatalogHash(next))
    expect(
      container.database.db.prepare('SELECT id FROM locations WHERE name = ?').get('Shared'),
    ).toEqual({ id })
    const reordered = structuredClone(next)
    reordered.catalogVersion++
    reordered.companies[0].locations = [...next.companies[0].locations].reverse()
    const before = container.services.companies.get(2)
    expect(
      container.services.companyCatalog.synchronize(reordered, companyCatalogHash(reordered))
        .updated,
    ).toBe(0)
    expect(container.services.companies.get(2)).toEqual(before)
    const omitted = structuredClone(reordered)
    omitted.catalogVersion++
    omitted.companies.splice(1, 1)
    container.services.companyCatalog.synchronize(omitted, companyCatalogHash(omitted))
    expect(container.services.companies.get(2)).toMatchObject({
      isBuiltin: false,
      locations: ['Shared'],
    })
    validateDatabaseVersion(container.database.db, 3)
  })

  it('adopts the catalog location set and rolls back catalog failures including orphan cleanup', () => {
    const a = container.services.companies.create({ name: 'Adopt', locations: ['Old'] })
    const source = catalog()
    source.companies.push({
      ...source.companies[0],
      builtinKey: '00000000-0000-4000-8000-000000000001',
      name: a.name,
      locations: [],
    })
    vi.spyOn(CompanyCatalogRepository.prototype, 'updateState').mockImplementationOnce(() => {
      throw new Error('injected')
    })
    expect(() =>
      container.services.companyCatalog.synchronize(source, companyCatalogHash(source)),
    ).toThrow('injected')
    expect(container.services.companies.get(a.id)).toEqual(a)
    expect(container.services.companies.searchLocations(page).items).toEqual(['Old'])
    container.services.companyCatalog.synchronize(source, companyCatalogHash(source))
    expect(container.services.companies.get(a.id)).toMatchObject({ isBuiltin: true, locations: [] })
    expect(container.services.companies.searchLocations(page).items).toEqual([])
  })

  it('rejects corrupt v3 location data on persistence validation', () => {
    const db = container.database.db
    const a = container.services.companies.create({ name: 'Validate', locations: ['上海'] })
    db.prepare('DELETE FROM company_locations WHERE company_id = ?').run(a.id)
    expect(() => validateDatabaseVersion(db, 3)).toThrow('Invalid company location references')
    db.prepare('UPDATE locations SET name = ?').run(' ')
    expect(() => validateDatabaseVersion(db, 3)).toThrow('Invalid company location')
  })

  it('uses indexed bounded reads with 10,000 companies and 200,000 location links', () => {
    const db = container.database.db
    const insertLocation = db.prepare('INSERT INTO locations (id,name,created_at) VALUES (?,?,1)')
    const insertCompany = db.prepare(
      'INSERT INTO companies (id,name,created_at,updated_at) VALUES (?,?,1,1)',
    )
    const insertLink = db.prepare(
      'INSERT INTO company_locations (company_id,location_id,created_at) VALUES (?,?,1)',
    )
    db.transaction(() => {
      for (let id = 1; id <= 5000; id++)
        insertLocation.run(id, `Office ${String(id).padStart(5, '0')}`)
      for (let id = 100000; id < 110000; id++) {
        insertCompany.run(id, `Scale ${id}`)
        for (let k = 0; k < 20; k++) insertLink.run(id, ((id * 19 + k) % 5000) + 1)
      }
    }).immediate()
    const started = performance.now()
    const suggestions = container.services.companies.searchLocations({
      ...page,
      prefix: 'Office 000',
    })
    const suggestionMs = performance.now() - started
    const searchStarted = performance.now()
    const companies = container.services.companies.search({
      ...page,
      locations: ['Office 00001', 'Office 00002'],
    })
    const companyMs = performance.now() - searchStarted
    expect(suggestions.items).toHaveLength(50)
    expect(companies.total).toBeGreaterThan(0)
    expect(companies.items.length).toBeLessThanOrEqual(50)
    const prefixPlan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT name FROM locations WHERE name LIKE ? ESCAPE '\\' ORDER BY name COLLATE NOCASE, id LIMIT ? OFFSET ?",
      )
      .all('Office 000%', 50, 0)
    expect(JSON.stringify(prefixPlan)).toContain(
      'SEARCH locations USING COVERING INDEX idx_locations_search',
    )
    const cleanupPlan = db
      .prepare(
        'EXPLAIN QUERY PLAN DELETE FROM locations WHERE id = ? AND NOT EXISTS (SELECT 1 FROM company_locations WHERE location_id = locations.id)',
      )
      .all(1)
    expect(JSON.stringify(cleanupPlan)).toContain('idx_company_locations_location')
    const searchPlan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT COUNT(*) FROM companies c WHERE EXISTS (SELECT 1 FROM company_locations cl WHERE cl.company_id=c.id AND cl.location_id IN (SELECT id FROM locations WHERE name IN (SELECT value FROM json_each(?))))`,
      )
      .all(JSON.stringify(['Office 00001', 'Office 00002']))
    expect(JSON.stringify(searchPlan)).toMatch(/SEARCH cl (?:EXISTS )?USING COVERING INDEX/)
    expect(JSON.stringify(searchPlan)).toContain('company_id=? AND location_id=?')
    expect(JSON.stringify(searchPlan)).toContain('sqlite_autoindex_locations_1 (name=?)')
    const report = {
      companies: 10000,
      links: 200000,
      distinctLocations: 5000,
      suggestionMs,
      companyMs,
      suggestionBytes: Buffer.byteLength(JSON.stringify(suggestions)),
      resultBytes: Buffer.byteLength(JSON.stringify(companies)),
      prefixPlan,
      searchPlan,
      cleanupPlan,
    }
    if (process.env.JOBTRAIL_LOCATION_PERF_REPORT) {
      fs.mkdirSync(path.dirname(process.env.JOBTRAIL_LOCATION_PERF_REPORT), { recursive: true })
      fs.writeFileSync(
        process.env.JOBTRAIL_LOCATION_PERF_REPORT,
        JSON.stringify(report, null, 2) + '\n',
      )
    }
  })
})
