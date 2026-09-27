import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServiceContainer } from '../src/main/service-container'
import {
  BUNDLED_COMPANY_CATALOG,
  companyCatalogHash,
  parseCompanyCatalog,
} from '../src/main/company-catalog'
import { prepareUserMessage } from '../src/main/agent/message'
import { parseIndustry, parseIndustryOrder } from '../src/main/ipc/validators'
import {
  buildIndustryTree,
  industryCascaderOptions,
  industryPath,
} from '../src/renderer/utils/industries'
import { MCP_TOOLS } from '../src/main/mcp-contracts'

describe('two-level industries', () => {
  let root: string
  let container: ReturnType<typeof createServiceContainer>
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrail-industry-'))
    container = createServiceContainer(
      {
        root,
        config: path.join(root, 'config.json'),
        data: path.join(root, 'data'),
        database: path.join(root, 'data/zhiji.db'),
        resumes: path.join(root, 'resumes'),
        chatUploads: path.join(root, 'chat-uploads'),
      },
      true,
    )
  })
  afterEach(() => {
    container.database.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const nextCatalog = () => ({
    ...structuredClone(BUNDLED_COMPANY_CATALOG),
    catalogVersion: BUNDLED_COMPANY_CATALOG.catalogVersion + 1,
  })
  function roots() {
    return container.services.industries.list().filter((item) => item.parentId === null)
  }
  function leaf(code: string) {
    const key = BUNDLED_COMPANY_CATALOG.industries.find((item) => item.code === code)!.builtinKey
    return container.database.db
      .prepare('SELECT id FROM industries WHERE builtin_key=?')
      .get(key) as { id: number }
  }

  it('allows equal names across groups and levels, but rejects siblings, third levels and level conversion', () => {
    const s = container.services.industries
    const [a, b] = roots()
    const child = s.create({ name: a.name, parentId: a.id })
    const other = s.create({ name: a.name, parentId: b.id })
    expect(() => s.create({ name: a.name, parentId: a.id })).toThrow()
    expect(() => s.create({ name: 'third', parentId: child.id })).toThrow()
    expect(() => s.update(a.id, { parentId: b.id })).toThrow()
    expect(() => s.update(child.id, { parentId: child.id })).toThrow()
    expect(() => s.update(child.id, { parentId: b.id })).toThrow()
    expect(s.get(child.id).parentId).toBe(a.id)
    s.delete(other.id)
    const before = s.list().filter((x) => x.parentId === b.id)
    expect(s.update(child.id, { parentId: b.id }).sortOrder).toBe(before.length)
    expect(
      s
        .list()
        .filter((x) => x.parentId === a.id)
        .map((x) => x.sortOrder),
    ).toEqual([0, 1, 2, 3, 4])
    expect(() => s.delete(b.id)).toThrow()
    const company = container.services.companies.create({
      name: 'used leaf',
      industryIds: [child.id],
    })
    expect(() => s.delete(child.id)).toThrow()
    container.services.companies.delete(company.id)
    s.delete(child.id)
  })

  it('deletes builtin leaves and empty roots in development only after all references are removed', () => {
    const s = container.services
    const division = s.industries.get(leaf('97').id)
    const parentId = division.parentId!
    const company = s.companies.create({ name: 'reference protection', industryIds: [division.id] })
    expect(() => s.industries.delete(parentId)).toThrowError(
      expect.objectContaining({ code: 'INDUSTRY_IN_USE' }),
    )
    expect(() => s.industries.delete(division.id)).toThrowError(
      expect.objectContaining({ code: 'INDUSTRY_IN_USE' }),
    )
    s.companies.update(company.id, { industryIds: [] })
    s.industries.delete(division.id)
    s.industries.delete(parentId)
    expect(() => s.industries.get(parentId)).toThrowError(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    )
  })

  it('reorders complete sibling groups and never mixes levels or groups', () => {
    const s = container.services.industries
    const [a, b] = roots()
    const group = s.list().filter((x) => x.parentId === a.id)
    const order = group.map((x) => x.id).reverse()
    s.reorder({ parentId: a.id, order })
    expect(
      s
        .list()
        .filter((x) => x.parentId === a.id)
        .map((x) => x.id),
    ).toEqual(order)
    for (const bad of [order.slice(1), [...order.slice(1), order[1]], [b.id, ...order.slice(1)]])
      expect(() => s.reorder({ parentId: a.id, order: bad })).toThrow()
    const rootOrder = roots()
      .map((x) => x.id)
      .reverse()
    s.reorder({ parentId: null, order: rootOrder })
    expect(roots().map((x) => x.id)).toEqual(rootOrder)
  })

  it('aggregates parent filtering without duplicate rows, preserves pagination, and rejects root associations', () => {
    const s = container.services
    const parent = roots()[0]
    const a = s.industries.create({ name: 'filter-a', parentId: parent.id })
    const b = s.industries.create({ name: 'filter-b', parentId: parent.id })
    const company = s.companies.create({ name: 'tree-filter-one', industryIds: [a.id, b.id] })
    s.companies.create({ name: 'tree-filter-two', industryIds: [b.id] })
    const query = { keyword: 'tree-filter', industryId: parent.id, pageSize: 1 }
    const first = s.companies.search({ ...query, page: 1 })
    const second = s.companies.search({ ...query, page: 2 })
    expect(first.total).toBe(2)
    expect(second.total).toBe(2)
    expect(first.items[0].id).not.toBe(second.items[0].id)
    expect(s.companies.search({ ...query, page: 1, industryId: a.id }).items[0].id).toBe(company.id)
    expect(() => s.companies.update(company.id, { industryIds: [parent.id] })).toThrow()
    expect(() => s.companies.create({ name: 'root-company', industryIds: [parent.id] })).toThrow()
    expect(() => s.companies.update(1, { industryIds: [] })).toThrow()
  })

  it('keeps local IDs and user ordering independent from catalog keys and appends new nodes', () => {
    const s = container.services
    const parent = roots()[0]
    const child = s.industries.create({ name: 'custom', parentId: parent.id })
    const order = s.industries
      .list()
      .filter((x) => x.parentId === parent.id)
      .map((x) => x.id)
      .reverse()
    s.industries.reorder({ parentId: parent.id, order })
    const catalog = nextCatalog()
    const key = randomUUID()
    const parentKey = catalog.industries.find((x) => x.parentKey === null)!.builtinKey
    catalog.industries.push({ builtinKey: key, parentKey, code: '00', name: 'new built-in' })
    catalog.companies[0].industryKeys = [key]
    s.companyCatalog.synchronize(parseCompanyCatalog(catalog), companyCatalogHash(catalog))
    const added = s.industries.list().find((x) => x.name === 'new built-in')!
    expect(added.id).toBeGreaterThan(child.id)
    expect(added.sortOrder).toBe(order.length)
    expect(s.companies.get(1).industryIds).toEqual([added.id])
    expect(s.industries.get(child.id).isBuiltin).toBe(false)
    expect(
      s.industries
        .list()
        .filter((x) => x.parentId === parent.id)
        .map((x) => x.id),
    ).toEqual([...order, added.id])
  })

  it('rolls back industry, company and catalog changes on a custom sibling name conflict', () => {
    const s = container.services
    const parent = roots()[0]
    const custom = s.industries.create({ name: 'collision', parentId: parent.id })
    const before = s.industries.list()
    const company = s.companies.get(1)
    const catalog = nextCatalog()
    catalog.industries[0].name = 'must roll back'
    catalog.industries.push({
      builtinKey: randomUUID(),
      parentKey: catalog.industries[0].builtinKey,
      code: '00',
      name: custom.name,
    })
    catalog.companies[0].name = 'must also roll back'
    expect(() => s.companyCatalog.synchronize(catalog, companyCatalogHash(catalog))).toThrowError(
      expect.objectContaining({ code: 'CATALOG_CONFLICT' }),
    )
    expect(s.industries.list()).toEqual(before)
    expect(s.companies.get(1)).toEqual(company)
    expect(s.companyCatalog.status().catalogVersion).toBe(BUNDLED_COMPANY_CATALOG.catalogVersion)
  })

  it('applies the installed policy to both builtin levels, while custom children remain editable', () => {
    const installed = createServiceContainer(
      {
        root,
        config: path.join(root, 'config.json'),
        data: path.join(root, 'data'),
        database: path.join(root, 'data/zhiji.db'),
        resumes: path.join(root, 'resumes'),
        chatUploads: path.join(root, 'chat-uploads'),
      },
      false,
    )
    try {
      const s = installed.services.industries
      for (const id of [roots()[0].id, leaf('01').id]) {
        expect(() => s.update(id, { name: 'blocked' })).toThrowError(
          expect.objectContaining({ code: 'BUILTIN_DATA' }),
        )
        expect(() => s.delete(id)).toThrowError(expect.objectContaining({ code: 'BUILTIN_DATA' }))
      }
      const child = s.create({ name: 'editable', parentId: roots()[0].id })
      s.update(child.id, { name: 'edited', parentId: roots()[1].id })
      s.delete(child.id)
      s.reorder({
        parentId: null,
        order: roots()
          .map((x) => x.id)
          .reverse(),
      })
    } finally {
      installed.database.close()
    }
  })

  it('uses child labels for cascader options, full paths for agent references and blocks empty roots from company selection', () => {
    const s = container.services
    const all = s.industries.list()
    const tree = buildIndustryTree(all)
    expect(tree).toHaveLength(20)
    expect(tree.flatMap((x) => x.children!)).toHaveLength(97)
    const options = industryCascaderOptions(all, true)
    expect(options.every((x) => !x.disabled)).toBe(true)
    expect(options[0].children![0]).toEqual({
      value: tree[0].children![0].id,
      label: tree[0].children![0].name,
    })
    const empty = { ...roots()[0], id: 10000 }
    expect(industryCascaderOptions([empty], true)[0].disabled).toBe(true)
    expect(industryCascaderOptions([empty])[0].disabled).toBe(false)
    const id = leaf('65').id
    const input = [{ kind: 'industry' as const, id, name: 'untrusted' }]
    expect(prepareUserMessage(input, [], s, true).message.content).toContain(
      industryPath(s.industries.get(id), all),
    )
    expect(() =>
      prepareUserMessage([{ kind: 'industry', id: roots()[0].id, name: 'fake' }], [], s, true),
    ).toThrow()
  })

  it('requires current IPC/MCP parent and sibling-order contracts and previews the parent name', () => {
    const parent = roots()[0]
    expect(() => parseIndustry({ name: 'missing parent' }, false)).toThrow()
    expect(() => parseIndustryOrder([1, 2])).toThrow()
    expect(
      parseIndustryOrder({ parentId: null, order: roots().map((x) => x.id) }).parentId,
    ).toBeNull()
    const create = MCP_TOOLS.find((x) => x.name === 'create_industry')!
    expect(create.inputSchema.safeParse({ input: { name: 'missing' } }).success).toBe(false)
    if (create.readOnly) throw new Error('write tool expected')
    expect(
      create.preview(container.services, { input: { name: 'child', parentId: parent.id } }).after,
    ).toMatchObject({ parentName: parent.name })
    const reorder = MCP_TOOLS.find((x) => x.name === 'reorder_industries')!
    expect(reorder.inputSchema.safeParse({ order: [] }).success).toBe(false)
  })
})
