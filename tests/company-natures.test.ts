import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CompanyCatalogRepository } from '../src/main/repositories/company-catalog-repository'
import { createServiceContainer } from '../src/main/service-container'
import { parseCompany, parseCompanyQuery } from '../src/main/ipc/validators'
import {
  companySchema,
  createCompanyInputSchema,
  updateCompanyInputSchema,
} from '../src/main/mcp/schemas'
import { MCP_TOOLS } from '../src/main/mcp-contracts'
import {
  BUNDLED_COMPANY_CATALOG,
  parseCompanyCatalog,
  companyCatalogHash,
} from '../src/main/company-catalog'
import { validateDatabaseVersion } from '../src/main/persistence/validation'
import { prepareUserMessage } from '../src/main/agent/message'
import type { CompanyNature } from '../src/shared/types'

describe('company nature dictionary and business operations', () => {
  let root: string
  let c: ReturnType<typeof createServiceContainer>
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'company-nature-'))
    c = createServiceContainer(
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
  })
  afterEach(() => {
    vi.restoreAllMocks()
    c.database.close()
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('exposes six ordered read-only options, seeds catalog natures and defaults custom companies to NULL', () => {
    const dictionary = c.services.companies.listNatures()
    expect(dictionary.map((item) => [item.code, item.name, item.sortOrder])).toEqual([
      ['state_owned', '国有企业', 1],
      ['private', '民营企业', 2],
      ['foreign_invested', '外商投资企业', 3],
      ['public_institution', '事业单位', 4],
      ['social_organization', '社会组织', 5],
      ['other', '其他', 6],
    ])
    expect(
      MCP_TOOLS.filter((tool) => /company_nature/.test(tool.name)).map((tool) => [
        tool.name,
        tool.readOnly,
      ]),
    ).toEqual([['list_company_natures', true]])
    expect(c.services.companies.create({ name: 'Default' }).companyNature).toBeNull()
    expect(
      new Map(
        c.services.companies
          .list()
          .filter((item) => item.isBuiltin)
          .map((item) => [item.name, item.companyNature]),
      ),
    ).toEqual(
      new Map(BUNDLED_COMPANY_CATALOG.companies.map((item) => [item.name, item.companyNature])),
    )
  })

  it('preserves omitted updates, clears explicit null and protects builtin data', () => {
    const s = c.services.companies
    const item = s.create({ name: 'Private', companyNature: 'private' })
    expect(companySchema.parse(item).companyNature).toBe('private')
    expect(s.update(item.id, { isFavorite: true }).companyNature).toBe('private')
    expect(s.update(item.id, { companyNature: null }).companyNature).toBeNull()
    expect(s.update(item.id, { companyNature: 'other' }).companyNature).toBe('other')
    const builtin = s.list().find((entry) => entry.isBuiltin)!
    expect(() => s.update(builtin.id, { companyNature: 'private' })).toThrowError(
      expect.objectContaining({ code: 'BUILTIN_DATA' }),
    )
    expect(s.update(builtin.id, { isFavorite: true })).toMatchObject({
      isFavorite: true,
      companyNature: builtin.companyNature,
    })
  })

  it.each(['', ' ', 'unknown', 1, false, {}, []])(
    'rejects invalid nature %j at every boundary',
    (value) => {
      expect(() => parseCompany({ name: 'Invalid', companyNature: value }, false)).toThrow()
      expect(() => parseCompany({ companyNature: value }, true)).toThrow()
      expect(
        createCompanyInputSchema.safeParse({ name: 'Invalid', companyNature: value }).success,
      ).toBe(false)
      expect(updateCompanyInputSchema.safeParse({ companyNature: value }).success).toBe(false)
      expect(() =>
        c.services.companies.create({ name: 'Invalid', companyNature: value as CompanyNature }),
      ).toThrow()
      const item = c.services.companies.create({ name: 'Valid' })
      expect(() =>
        c.services.companies.update(item.id, { companyNature: value as CompanyNature }),
      ).toThrow()
      expect(() =>
        c.database.db
          .prepare('UPDATE companies SET company_nature=? WHERE id=?')
          .run(value, item.id),
      ).toThrow()
    },
  )

  it('combines nature codes with OR, excludes unfilled values and counts before pagination', () => {
    const s = c.services.companies
    const leaf = c.services.industries.list().find((item) => item.parentId !== null)!
    const a = s.create({
      name: 'Nature A',
      companyNature: 'private',
      locations: ['上海'],
      industryIds: [leaf.id],
    })
    s.create({ name: 'Nature B', locations: ['上海'], industryIds: [leaf.id] })
    const other = s.create({
      name: 'Nature C',
      companyNature: 'other',
      locations: ['上海'],
      industryIds: [leaf.id],
    })
    s.create({
      name: 'Nature D',
      companyNature: 'private',
      locations: ['北京'],
      industryIds: [leaf.id],
    })
    const query = {
      page: 1,
      pageSize: 1,
      keyword: 'Nature',
      industryId: leaf.id,
      locations: ['上海'],
      companyNatures: ['private', 'other'] as CompanyNature[],
    }
    expect(s.search(query)).toMatchObject({ total: 2, items: [{ id: a.id }] })
    expect(s.search({ ...query, page: 2 })).toMatchObject({ total: 2, items: [{ id: other.id }] })
    expect(s.search({ ...query, companyNatures: ['private'] })).toMatchObject({
      total: 1,
      items: [{ id: a.id }],
    })
    expect(s.search({ ...query, companyNatures: [] }).total).toBe(3)
    const { companyNatures: _natures, ...unfiltered } = query
    expect(s.search(unfiltered).total).toBe(3)
    const descriptor = MCP_TOOLS.find((tool) => tool.name === 'search_companies')!
    for (const value of [
      null,
      [null],
      ['private', null],
      'private',
      ['bad'],
      ['private', 'private'],
      Array(7).fill('private'),
    ]) {
      expect(() => parseCompanyQuery({ ...query, companyNatures: value })).toThrow()
      expect(descriptor.inputSchema.safeParse({ ...query, companyNatures: value }).success).toBe(
        false,
      )
      expect(() => s.search({ ...query, companyNatures: value as CompanyNature[] })).toThrow()
    }
  })

  it('syncs explicit nature, clears omitted values, adopts custom companies and preserves withdrawn companies', () => {
    const entry = BUNDLED_COMPANY_CATALOG.companies[0]
    let version = BUNDLED_COMPANY_CATALOG.catalogVersion
    const sync = (companies: unknown[]) => {
      const catalog = parseCompanyCatalog({
        ...BUNDLED_COMPANY_CATALOG,
        catalogVersion: ++version,
        companies,
      })
      return c.services.companyCatalog.synchronize(catalog, companyCatalogHash(catalog))
    }
    const builtin = c.services.companies.list().find((item) => item.name === entry.name)!
    const original = c.services.companies.update(builtin.id, { isFavorite: true })
    sync([{ ...entry, companyNature: 'state_owned' }])
    expect(c.services.companies.get(builtin.id)).toMatchObject({
      id: builtin.id,
      companyNature: 'state_owned',
      isFavorite: true,
      createdAt: original.createdAt,
    })
    expect(sync([{ ...entry, companyNature: 'state_owned' }]).unchanged).toBe(1)
    const { companyNature: _omitted, ...withoutNature } = entry
    sync([withoutNature])
    expect(c.services.companies.get(builtin.id).companyNature).toBeNull()
    sync([{ ...entry, companyNature: 'state_owned' }])
    const custom = c.services.companies.create({ name: 'Adopt nature', companyNature: 'private' })
    const adopted = {
      ...entry,
      builtinKey: 'e8c94349-4683-4a28-a38b-cd9928f808c1',
      name: custom.name,
      companyNature: 'foreign_invested',
    }
    expect(sync([adopted])).toMatchObject({ adopted: 1, convertedToCustom: 1 })
    expect(c.services.companies.get(custom.id)).toMatchObject({
      isBuiltin: true,
      companyNature: 'foreign_invested',
    })
    expect(c.services.companies.get(builtin.id)).toMatchObject({
      isBuiltin: false,
      companyNature: 'state_owned',
    })
    validateDatabaseVersion(c.database.db, 9)
  })

  it('rolls back nature and catalog state together when synchronization fails', () => {
    const before = c.database.db.prepare('SELECT * FROM companies ORDER BY id').all()
    const state = c.services.companyCatalog.status()
    const catalog = parseCompanyCatalog({
      ...BUNDLED_COMPANY_CATALOG,
      catalogVersion: BUNDLED_COMPANY_CATALOG.catalogVersion + 1,
      companies: [{ ...BUNDLED_COMPANY_CATALOG.companies[0], companyNature: 'state_owned' }],
    })
    vi.spyOn(CompanyCatalogRepository.prototype, 'updateState').mockImplementation(() => {
      throw new Error('nature sync failure')
    })
    expect(() =>
      c.services.companyCatalog.synchronize(catalog, companyCatalogHash(catalog)),
    ).toThrow('nature sync failure')
    expect(c.database.db.prepare('SELECT * FROM companies ORDER BY id').all()).toEqual(before)
    expect(c.services.companyCatalog.status()).toEqual(state)
    validateDatabaseVersion(c.database.db, 9)
  })

  it('resolves company references and confirmation previews from saved data', () => {
    const item = c.services.companies.create({ name: 'Reference', companyNature: 'private' })
    const message = prepareUserMessage(
      [{ kind: 'company', id: item.id, name: 'forged' }],
      [],
      c.services,
      true,
    )
    expect(message.message.content).toContain('Reference · 民营企业')
    expect(message.message.content).not.toContain('forged')
    const tool = MCP_TOOLS.find((entry) => entry.name === 'update_company')!
    if (tool.readOnly) throw new Error('Expected mutation')
    expect(tool.preview(c.services, { id: item.id, input: { companyNature: null } })).toMatchObject(
      {
        before: { companyNature: 'private', companyNatureName: '民营企业' },
        after: { companyNature: null, companyNatureName: '未填写' },
      },
    )
  })

  it.each([
    "DELETE FROM company_natures WHERE code='private'",
    "UPDATE company_natures SET name='changed' WHERE code='private'",
    "UPDATE company_natures SET sort_order=10 WHERE code='private'",
    "INSERT INTO company_natures VALUES ('extra','Extra',7)",
  ])('rejects dictionary corruption without repairing rows: %s', (sql) => {
    c.database.db.exec(sql)
    const before = c.database.db.prepare('SELECT * FROM company_natures').all()
    expect(() => validateDatabaseVersion(c.database.db, 9)).toThrow(
      'Invalid company nature dictionary',
    )
    expect(c.database.db.prepare('SELECT * FROM company_natures').all()).toEqual(before)
    if (sql.startsWith('DELETE'))
      expect(() =>
        c.services.companies.create({ name: 'Missing dictionary', companyNature: 'private' }),
      ).toThrow('企业性质不存在')
  })
})
