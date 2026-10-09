import { cityCode } from '../src/shared/discovery-cities'
import { observationPayload } from '../src/main/discovery/persistence'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  searchQuerySchema,
  browserActionSchema,
  browserRegionSchema,
  qrLoginSchema,
  sourceVerificationSchema,
  MAX_OBSERVATION_BYTES,
  type RawJob,
} from '../src/shared/job-discovery'
import { normalizeJob, salaryExclusion, parseSalary } from '../src/main/discovery/normalization'

import { canonicalJob, jobIdentity, allowedPage } from '../src/main/discovery/platforms'
import { createServiceContainer } from '../src/main/service-container'
import { validateDatabaseVersion, DATABASE_MIGRATIONS } from '../src/main/persistence-migrations'
import { SCHEMA_V3 } from '../src/main/persistence/schema-v3'
import Database from 'better-sqlite3'
import { MCP_TOOLS } from '../src/main/mcp-contracts'
import { DiscoveryRepository } from '../src/main/discovery/repository'
import { z } from 'zod'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})
const query = (extra: Record<string, unknown> = {}) =>
  searchQuerySchema.parse({ keyword: 'Java', city: '上海', platforms: ['boss'], ...extra })
const job = (extra: Partial<RawJob> = {}): RawJob => ({
  platform: 'boss',
  url: 'https://www.zhipin.com/job_detail/abc.html',
  externalId: 'abc',
  title: 'Java工程师',
  company: '测试公司',
  city: '上海市',
  salary: '12.5-20K·13薪',
  experience: '3-5年',
  education: '本科',
  recruitment: '社招',
  employment: '全职',
  jd: '负责 Java 服务开发',
  detailRead: true,
  ...extra,
})
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrail-discovery-'))
  roots.push(root)
  return createServiceContainer(
    {
      root,
      config: path.join(root, 'config.json'),
      data: path.join(root, 'data'),
      database: path.join(root, 'data', 'zhiji.db'),
      resumes: path.join(root, 'resumes'),
      chatUploads: path.join(root, 'chat-uploads'),
    },
    false,
  )
}

describe('monthly salary normalization and admission', () => {
  it('keeps the missing reason for a list summary until a complete JD is read', () => {
    const summary = job({ jd: '列表摘要', detailRead: false })
    const initial = normalizeJob(summary, 100)
    expect(initial.missing.jd).toBe('detail_not_read')
    for (const reason of ['parse_error', 'login_required', 'challenge'] as const) {
      const blocked = normalizeJob({ ...summary, missing: { jd: reason } }, 200, initial)
      expect(blocked.jd).toBe('列表摘要')
      expect(blocked.missing.jd).toBe(reason)
      expect(blocked.detailRead).toBe(false)
    }
    const complete = normalizeJob(job(), 300, initial)
    expect(complete.missing.jd).toBeUndefined()
    expect(normalizeJob(summary, 400, complete).jd).toBe(job().jd)
    expect(normalizeJob(summary, 400, complete).missing.jd).toBeUndefined()
  })
  it.each([
    ['12.5-20K·13薪', 12500, 20000, null],
    ['15–25K/月', 15000, 25000, null],
    ['1.2-2万/月', 12000, 20000, null],
    ['24-36万/年', 20000, 30000, null],
    ['24万元/年', 20000, null, null],
    ['5000元/月', 5000, null, null],
    ['15K·14薪', 15000, null, null],
    ['300-500元/天', null, null, 'day'],
    ['80元/小时', null, null, 'hour'],
    ['USD 10-20K/月', null, null, 'foreign'],
    ['港币30万/年', null, null, 'foreign'],
    ['面议', null, null, 'unknown'],
    ['10K以上', null, null, 'unknown'],
    ['20-10K', null, null, 'unknown'],
    ['20-30卢比/月', null, null, 'foreign'],
  ])('normalizes %s without persisting units', (raw, min, max, exclusion) => {
    expect(parseSalary(raw as string)).toEqual({ salaryMin: min, salaryMax: max, exclusion })
  })
  it('applies inclusive intersections and interprets single values as exact amounts', () => {
    expect(salaryExclusion('15-20K', query({ salaryMin: 20000 }))).toBeNull()
    expect(salaryExclusion('15-20K', query({ salaryMax: 15000 }))).toBeNull()
    expect(salaryExclusion('15000元/月', query({ salaryMin: 15001 }))).toBe('out_of_range')
    expect(salaryExclusion('24万/年', query({ salaryMin: 20000, salaryMax: 20000 }))).toBeNull()
    expect(salaryExclusion('15K·14薪', query({ salaryMin: 16000 }))).toBe('out_of_range')
  })
  it.each(['面议', '300元/天', '80元/小时', '5000美元/月'])(
    'keeps %s only when no salary bound is set',
    (salary) => {
      expect(salaryExclusion(salary, query())).toBeNull()
      expect(salaryExclusion(salary, query({ salaryMin: 0 }))).not.toBeNull()
      expect(salaryExclusion(salary, query({ salaryMax: 30000 }))).not.toBeNull()
    },
  )
  it('rejects removed query fields, preserves missing reasons without inventing a login restriction', () => {
    for (const field of [
      'experience',
      'education',
      'recruitment',
      'employment',
      'company',
      'exclude',
      'salaryMode',
    ])
      expect(() => query({ [field]: field === 'exclude' ? [] : '' })).toThrow()
    expect(normalizeJob(job({ salary: '', detailRead: false, jd: '' })).missing.salary).toBe(
      'detail_not_read',
    )
    expect(normalizeJob(job({ salary: '' })).missing.salary).toBe('not_provided')
  })
})
describe('platform identities and scoped evidence', () => {
  it('rejects extra browser and login parameters and requires operation-specific identifiers', () => {
    for (const value of [
      { action: 'open' },
      { action: 'close', jobId: 'unused' },
      { action: 'clear', platform: 'boss', jobId: 'unused' },
      { action: 'open', jobId: 'job', url: 'https://example.com' },
    ])
      expect(browserActionSchema.safeParse(value).success).toBe(false)
    for (const value of [
      { action: 'verify', platform: 'boss' },
      { action: 'retry', platform: 'boss' },
      { action: 'start', platform: 'boss', attemptId: '11111111-1111-4111-8111-111111111111' },
      { action: 'get', platform: 'boss', script: 'document.cookie' },
    ])
      expect(qrLoginSchema.safeParse(value).success).toBe(false)
    for (const value of [
      { action: 'open', platform: 'boss' },
      { action: 'open', runId: 'not-a-uuid', platform: 'boss' },
      {
        action: 'open',
        runId: '11111111-1111-4111-8111-111111111111',
        platform: 'boss',
        url: 'https://example.com',
      },
      { action: 'get', platform: 'boss' },
      { action: 'close', script: 'document.cookie' },
      { action: 'recheck', runId: '11111111-1111-4111-8111-111111111111', platform: 'boss' },
      {
        action: 'recheck',
        runId: '11111111-1111-4111-8111-111111111111',
        platform: 'boss',
        attemptId: 'invalid',
      },
    ])
      expect(sourceVerificationSchema.safeParse(value).success).toBe(false)
    expect(
      browserRegionSchema.safeParse({
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        visible: true,
        extra: true,
      }).success,
    ).toBe(false)
    for (const name of [
      'get_job_platform_status',
      'get_job_search',
      'continue_job_search',
      'cancel_job_search',
      'list_job_search_history',
    ]) {
      const schema = MCP_TOOLS.find((tool) => tool.name === name)!.inputSchema
      expect(
        schema.safeParse({ runId: '11111111-1111-4111-8111-111111111111', extra: true }).success,
      ).toBe(false)
    }
  })
  it('allows an omitted location and removes the nationwide option', () => {
    expect(searchQuerySchema.parse({ keyword: 'Java', platforms: ['boss'] }).city).toBe('')
    expect(query({ city: '' }).city).toBe('')
    expect(() => query({ city: '全国' })).toThrow()
    expect(() => query({ location: '北京' })).toThrow()
    expect(cityCode('boss', '未映射城市')).toBeUndefined()
    expect(cityCode('boss', '上海')).toBe('101020100')
    expect(cityCode('liepin', '杭州')).toBe('070020')
    expect(canonicalJob('liepin', 'https://www.liepin.com/lptjob/85677533?tracking=1')).toEqual({
      url: 'https://www.liepin.com/lptjob/85677533',
      externalId: 'lptjob:85677533',
    })
  })
  it('does not merge same title/company/city jobs, and removes tracking from identity', () => {
    for (const key of ['jobid', 'jobId']) {
      const url = 'http://campus.51job.com/campaign/careers.html?' + key + '=173453770&track=1'
      expect(canonicalJob('wuyou', url)).toEqual({
        url: 'https://campus.51job.com/campaign/careers.html?' + key + '=173453770',
        externalId: '173453770',
      })
      expect(jobIdentity('wuyou', url).id).toBe(
        jobIdentity('wuyou', 'https://jobs.51job.com/beijing/173453770.html').id,
      )
    }
    expect(jobIdentity('boss', job().url).id).not.toBe(
      jobIdentity('boss', 'https://www.zhipin.com/job_detail/def.html').id,
    )
    expect(jobIdentity('boss', job().url).id).toBe(
      jobIdentity('boss', job().url + '?securityId=secret&lid=other').id,
    )
    expect(allowedPage('boss', 'https://www.zhipin.com.evil.test/')).toBe(false)
    expect(allowedPage('boss', 'file:///etc/passwd')).toBe(false)
    expect(canonicalJob('boss', 'https://www.zhipin.com/web/user')).toBeNull()
    expect(
      canonicalJob('boss', 'https://www.zhipin.com/job_detail/35332fd4768ebcea0HB73Nu9FFQ~.html')
        ?.externalId,
    ).toBe('35332fd4768ebcea0HB73Nu9FFQ~')
  })
})
describe('durable discovery and transactional save', () => {
  it.each(['relevance', 'salary', 'discovered'] as const)(
    'reuses a %s view through the shared UI/MCP service when the next page omits sort',
    async (sort) => {
      const c = fixture()
      try {
        const r = c.services.discovery.repository
        const terms = 'ABCDEFGHIJKL'.split('').map((letter) => `Lang${letter}`)
        const run = r.create(query({ keyword: terms.join(' ') }), 'shared-sorted-view')
        for (let i = 0; i < 12; i++)
          r.observe(
            job({
              externalId: `sorted${i}`,
              url: `https://www.zhipin.com/job_detail/sorted${i}.html`,
              title: terms.slice(0, 12 - i).join(' '),
              salary: `${i + 10}-${i + 11}K`,
            }),
            run.id,
            100 + ((i * 5) % 12),
          )
        const expected = {
          relevance: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
          salary: [11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
          discovered: [7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5, 0],
        }[sort].map((i) => `sorted${i}`)
        const view = await c.services.discovery.list({ runId: run.id, sort, pageSize: 10 })
        expect(view.items.map((item) => item.externalId)).toEqual(expected.slice(0, 10))
        const tool = MCP_TOOLS.find((tool) => tool.name === 'list_discovered_jobs')!
        const parsed = tool.inputSchema.parse({
          runId: run.id,
          viewId: view.viewId,
          page: 2,
          pageSize: 10,
        })
        await expect(
          tool.execute(c.services, parsed as Record<string, unknown>, AbortSignal.timeout(1000)),
        ).resolves.toMatchObject({
          viewId: view.viewId,
          page: 2,
          total: 12,
          items: expected.slice(10).map((externalId) => ({ externalId })),
        })
        const mcpFirstPage = tool.inputSchema.parse({ runId: run.id, sort, pageSize: 10 })
        await expect(
          tool.execute(
            c.services,
            mcpFirstPage as Record<string, unknown>,
            AbortSignal.timeout(1000),
          ),
        ).resolves.toMatchObject({ items: view.items })
      } finally {
        c.database.close()
      }
    },
  )

  it('validates one database snapshot while a second connection commits discovery results', () => {
    const c = fixture(),
      db = c.database.db
    const writer = new Database(db.name)
    const repo = c.services.discovery.repository
    const run = repo.create(query(), 'snapshot-check')
    repo.observe(job(), run.id)
    const prepare = db.prepare.bind(db)
    let changed = false
    const spy = vi.spyOn(db, 'prepare').mockImplementation((sql) => {
      if (!changed && sql.startsWith('SELECT COUNT(*) n FROM discovery_results')) {
        changed = true
        new DiscoveryRepository(writer).observe(
          job({ url: 'https://www.zhipin.com/job_detail/second.html', externalId: 'second' }),
          run.id,
        )
      }
      return prepare(sql)
    })
    try {
      expect(() => validateDatabaseVersion(db, 4)).not.toThrow()
      expect(changed).toBe(true)
      expect(repo.sourceCount(run.id, 'boss')).toBe(2)
    } finally {
      spy.mockRestore()
      writer.close()
      c.database.close()
    }
  })
  it('keeps a view stable while new high-ranked jobs and detail updates arrive', () => {
    const c = fixture()
    try {
      const r = c.services.discovery.repository
      const run = c.unitOfWork.run(() => r.create(query(), 'stable'))
      c.unitOfWork.run(() => {
        for (let i = 0; i < 23; i++)
          r.observe(
            job({
              externalId: `stable${i}`,
              url: `https://www.zhipin.com/job_detail/stable${i}.html`,
              salary: `${i + 10}-${i + 11}K`,
            }),
            run.id,
          )
      })
      const first = r.list({ runId: run.id, sort: 'salary', pageSize: 10 })
      const baseline = r
        .list({ runId: run.id, viewId: first.viewId, pageSize: 50 })
        .items.map((j) => j.id)
      c.unitOfWork.run(() => {
        r.observe(
          job({
            externalId: 'new',
            url: 'https://www.zhipin.com/job_detail/new.html',
            salary: '100-200K',
          }),
          run.id,
        )
        r.observe(
          job({
            externalId: 'stable22',
            url: 'https://www.zhipin.com/job_detail/stable22.html',
            jd: '外包岗位',
          }),
          run.id,
        )
      })
      for (const pageSize of [10, 20, 50] as const) {
        const all: string[] = []
        for (let page = 1; page <= Math.ceil(24 / pageSize); page++) {
          const next = r.list({ runId: run.id, viewId: first.viewId, pageSize, page })
          expect(next.total).toBe(24)
          all.push(...next.items.map((j) => j.id))
        }
        expect(all.slice(0, 23)).toEqual(baseline)
        expect(new Set(all).size).toBe(24)
      }
      const refreshed = r.list({ runId: run.id, sort: 'salary' })
      expect(refreshed.viewId).not.toBe(first.viewId)
      expect(refreshed.items[0].externalId).toBe('new')
      expect(refreshed.total).toBe(24)
      expect(() => r.list({ runId: run.id, page: 2 })).toThrow('viewId')
      c.unitOfWork.run(() => {
        r.state(run.id, 'completed')
        r.remove([run.id])
      })
      expect(c.database.db.prepare('SELECT COUNT(*) n FROM discovery_view_items').get()).toEqual({
        n: 0,
      })
      expect(() => r.source(run.id, run.sources[0])).toThrow('Search run not found')
      validateDatabaseVersion(c.database.db, 4)
    } finally {
      c.database.close()
    }
  })
  it('uses SQL pagination with consistent counts and immutable historical observations', () => {
    const c = fixture()
    try {
      const r = c.services.discovery.repository
      const first = c.unitOfWork.run(() => r.create(query(), 'first'))
      c.unitOfWork.run(() => {
        for (let i = 0; i < 25; i++)
          r.observe(
            job({
              url: `https://www.zhipin.com/job_detail/j${i}.html`,
              externalId: 'j' + i,
              jd: '',
              detailRead: false,
            }),
            first.id,
          )
        r.state(first.id, 'completed')
      })
      const viewId = r.list({ runId: first.id }).viewId
      expect(r.list({ runId: first.id, viewId, page: 2, pageSize: 20 })).toMatchObject({
        total: 25,
        items: expect.any(Array),
      })
      expect(r.list({ runId: first.id, viewId, page: 2, pageSize: 20 }).items).toHaveLength(5)
      const second = c.unitOfWork.run(() => r.create(query(), 'second'))
      c.unitOfWork.run(() =>
        r.observe(
          job({ url: 'https://www.zhipin.com/job_detail/j0.html', externalId: 'j0' }),
          second.id,
        ),
      )
      expect(r.list({ runId: second.id }).total).toBe(1)
      expect(r.list({ runId: first.id }).total).toBe(25)
      validateDatabaseVersion(c.database.db, 4)
    } finally {
      c.database.close()
    }
  })
  it('coalesces in-flight queries and binds every requestId to its original query', () => {
    const c = fixture()
    try {
      const r = c.services.discovery.repository
      const a = c.unitOfWork.run(() => r.create(query(), 'a')),
        b = c.unitOfWork.run(() => r.create(query(), 'b'))
      expect(a.id).toBe(b.id)
      expect(() => c.unitOfWork.run(() => r.create(query({ keyword: 'Python' }), 'b'))).toThrow()
      c.unitOfWork.run(() => r.state(a.id, 'completed'))
      expect(c.unitOfWork.run(() => r.create(query(), 'b')).id).toBe(a.id)
    } finally {
      c.database.close()
    }
  })
  it('rolls back new company on invalid status and preserves user edits on repeated saves', () => {
    const c = fixture()
    try {
      const s = c.services.discovery,
        r = s.repository,
        run = c.unitOfWork.run(() => r.create(query(), 'save'))
      c.unitOfWork.run(() => r.observe(job(), run.id))
      const id = r.list({ runId: run.id }).items[0].id
      expect(() =>
        s.saveSync({ jobId: id, newCompanyName: '不得留下的公司', statusId: 99999 }),
      ).toThrow()
      expect(
        c.services.companies.search({ keyword: '不得留下', page: 1, pageSize: 20 }).total,
      ).toBe(0)
      const saved = s.saveSync({
        jobId: id,
        newCompanyName: '确认创建公司',
        statusId: c.services.statuses.list()[0].id,
      })
      const opportunity = c.services.opportunities.get(saved.opportunityId),
        company = c.services.companies.get(opportunity.companyId)
      expect(company.locations).toEqual([])
      expect(company.industryIds).toEqual([])
      c.services.opportunities.update(saved.opportunityId, { title: '用户改过的岗位' })
      expect(
        s.saveSync({ jobId: id, companyId: company.id, statusId: opportunity.statusId }),
      ).toMatchObject({ alreadySaved: true, opportunityId: saved.opportunityId })
      c.unitOfWork.run(() => {
        r.state(run.id, 'completed')
        r.remove([run.id])
      })
      expect(c.services.opportunities.get(saved.opportunityId).title).toBe('用户改过的岗位')
      validateDatabaseVersion(c.database.db, 4)
      c.services.opportunities.delete(saved.opportunityId)
      expect(r.saved(id)).toBeNull()
      validateDatabaseVersion(c.database.db, 4)
    } finally {
      c.database.close()
    }
  })
  it('deletes batched history atomically and rejects late details for a deleted run', async () => {
    const c = fixture()
    try {
      const s = c.services.discovery,
        r = s.repository
      const a = c.unitOfWork.run(() => r.create(query(), 'delete-a'))
      c.unitOfWork.run(() => r.state(a.id, 'completed'))
      const b = c.unitOfWork.run(() => r.create(query(), 'delete-b'))
      await expect(s.removeHistory([a.id, b.id])).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      })
      expect(r.history(1).total).toBe(2)
      c.unitOfWork.run(() => r.state(b.id, 'cancelled'))
      await s.removeHistory([a.id, b.id, a.id])
      expect(r.history(1).total).toBe(0)
      expect(() => c.unitOfWork.run(() => r.observe(job(), a.id))).toThrow()
      expect(c.database.db.prepare('SELECT COUNT(*) n FROM discovery_results').get()).toEqual({
        n: 0,
      })
      validateDatabaseVersion(c.database.db, 4)
    } finally {
      c.database.close()
    }
  })
  it('removes offline jobs from every result, observation and fixed view while preserving saved opportunities', () => {
    const c = fixture()
    try {
      const s = c.services.discovery,
        r = s.repository,
        db = c.database.db
      const a = c.unitOfWork.run(() => r.create(query(), 'offline-a'))
      c.unitOfWork.run(() => r.observe(job(), a.id))
      const id = jobIdentity('boss', job().url).id
      c.unitOfWork.run(() => r.state(a.id, 'completed'))
      const b = c.unitOfWork.run(() => r.create(query(), 'offline-b'))
      c.unitOfWork.run(() => r.observe(job({ jd: '较新的详情' }), b.id))
      c.unitOfWork.run(() =>
        r.observe(
          job({ url: 'https://www.zhipin.com/job_detail/other.html', externalId: 'other' }),
          a.id,
        ),
      )
      const other = jobIdentity('boss', 'https://www.zhipin.com/job_detail/other.html').id
      const views = [r.list({ runId: a.id }), r.list({ runId: b.id })]
      const saved = s.saveSync({
        jobId: id,
        newCompanyName: '需要保留的公司',
        statusId: c.services.statuses.list()[0].id,
      })
      const opportunity = c.services.opportunities.get(saved.opportunityId)
      expect(() =>
        c.unitOfWork.run(() => {
          r.removeOfflineJob(id)
          throw new Error('rollback')
        }),
      ).toThrow('rollback')
      expect(r.get(id).savedOpportunityId).toBe(saved.opportunityId)
      c.unitOfWork.run(() => r.removeOfflineJob(id))
      for (const table of [
        'discovery_observations',
        'discovery_results',
        'discovery_view_items',
        'discovery_saved',
      ])
        expect(db.prepare(`SELECT count(*) n FROM ${table} WHERE job_id=?`).get(id)).toEqual({
          n: 0,
        })
      expect(() => r.get(id)).toThrow('Discovered job not found')
      expect(r.list({ runId: a.id, viewId: views[0].viewId }).items.map((j) => j.id)).toEqual([
        other,
      ])
      expect(r.list({ runId: b.id, viewId: views[1].viewId }).total).toBe(0)
      expect(r.run(a.id).sources[0].count).toBe(1)
      expect(r.run(b.id).sources[0].count).toBe(0)
      expect(c.services.opportunities.get(saved.opportunityId)).toEqual(opportunity)
      expect(c.services.companies.get(opportunity.companyId).name).toBe('需要保留的公司')
      validateDatabaseVersion(db, 4)
    } finally {
      c.database.close()
    }
  })
  it('validates fixed views after removing a middle job and appends without renumbering survivors', () => {
    const c = fixture()
    try {
      const r = c.services.discovery.repository,
        db = c.database.db
      const run = c.unitOfWork.run(() => r.create(query(), 'offline-middle'))
      for (const externalId of ['one', 'two', 'three'])
        c.unitOfWork.run(() =>
          r.observe(
            job({ externalId, url: `https://www.zhipin.com/job_detail/${externalId}.html` }),
            run.id,
          ),
        )
      const view = r.list({ runId: run.id })
      c.unitOfWork.run(() => r.removeOfflineJob(view.items[1].id))
      expect(
        db
          .prepare('SELECT ordinal FROM discovery_view_items WHERE view_id=? ORDER BY ordinal')
          .all(view.viewId),
      ).toEqual([{ ordinal: 1 }, { ordinal: 3 }])
      validateDatabaseVersion(db, 4)
      c.unitOfWork.run(() =>
        r.observe(
          job({ externalId: 'four', url: 'https://www.zhipin.com/job_detail/four.html' }),
          run.id,
        ),
      )
      expect(r.list({ runId: run.id, viewId: view.viewId }).items.map((item) => item.id)).toEqual([
        view.items[0].id,
        view.items[2].id,
        jobIdentity('boss', 'https://www.zhipin.com/job_detail/four.html').id,
      ])
      validateDatabaseVersion(db, 4)
    } finally {
      c.database.close()
    }
  })
  it('interrupts restarted tasks and discards cursors without erasing confirmed local login evidence', () => {
    const c = fixture()
    try {
      const r = c.services.discovery.repository,
        run = c.unitOfWork.run(() => r.create(query(), 'restart'))
      c.unitOfWork.run(() => {
        r.state(run.id, 'running')
        r.source(run.id, { ...run.sources[0], state: 'running', cursor: 'old' })
        r.platform({
          ...r.status()[0],
          state: 'authenticated',
          checkedAt: 1234,
          evidence: 'official_qr_login_confirmed',
          limitations: [],
        })
        r.resetRuntime()
      })
      expect(r.run(run.id)).toMatchObject({
        state: 'interrupted',
        sources: [expect.objectContaining({ state: 'interrupted', cursor: null })],
      })
      expect(r.status()[0]).toMatchObject({
        state: 'authenticated',
        checkedAt: 1234,
        evidence: 'official_qr_login_confirmed',
        generation: 1,
        limitations: ['session_recheck_required'],
      })
    } finally {
      c.database.close()
    }
  })
  it('migrates an exact v3 schema continuously and rejects malformed discovery JSON', () => {
    const db = new Database(':memory:')
    try {
      db.exec(SCHEMA_V3)
      db.pragma('user_version=3')
      validateDatabaseVersion(db, 3)
      DATABASE_MIGRATIONS.find((s) => s.from === 3)!.apply(db)
      db.pragma('user_version=4')
      validateDatabaseVersion(db, 4)
      db.prepare('INSERT INTO discovery_platforms VALUES(?,?)').run('boss', '{}')
      expect(() => validateDatabaseVersion(db, 4)).toThrow()
    } finally {
      db.close()
    }
  })
  it('exports JSON schemas and keeps collection out of parallel local reads and save in confirmation', () => {
    for (const name of [
      'get_job_platform_status',
      'start_job_search',
      'get_job_search',
      'list_discovered_jobs',
      'continue_job_search',
      'cancel_job_search',
      'get_discovered_job',
      'list_job_search_history',
      'save_discovered_job',
    ]) {
      const tool = MCP_TOOLS.find((t) => t.name === name)!
      expect(tool).toBeDefined()
      expect(() => z.toJSONSchema(tool.inputSchema, { io: 'input' })).not.toThrow()
      expect(() => z.toJSONSchema(tool.outputSchema)).not.toThrow()
    }
    expect(MCP_TOOLS.find((t) => t.name === 'start_job_search')!.readOnlyHint).toBe(false)
    expect(MCP_TOOLS.find((t) => t.name === 'save_discovered_job')).toMatchObject({
      readOnly: false,
      idempotent: true,
    })
    expect(MCP_TOOLS.find((t) => t.name === 'save_discovered_job')!.confirmation).toBeUndefined()
  })
})

describe('final v4 observation integrity', () => {
  it.each([
    ['missing city', { keyword: 'Java', platforms: ['boss'] }],
    ['untrimmed keyword', { keyword: ' Java ', city: '上海', platforms: ['boss'] }],
    ['untrimmed city', { keyword: 'Java', city: ' 上海 ', platforms: ['boss'] }],
  ])(
    'rejects persisted query with %s instead of applying input normalization',
    (_name, invalid) => {
      const c = fixture(),
        db = c.database.db
      try {
        c.services.discovery.repository.create(query(), 'stored-query')
        const payload = JSON.stringify(invalid)
        db.prepare('UPDATE discovery_runs SET query=?').run(payload)
        expect(() => validateDatabaseVersion(db, 4)).toThrow('Invalid persisted discovery query')
        expect(db.prepare('SELECT query FROM discovery_runs').get()).toEqual({ query: payload })
      } finally {
        c.database.close()
      }
    },
  )

  it('rejects a view identifier that cannot be used by the public list contract', () => {
    const c = fixture(),
      r = c.services.discovery.repository,
      db = c.database.db
    try {
      const run = r.create(query(), 'invalid-view')
      r.observe(job(), run.id)
      r.list({ runId: run.id })
      db.exec(
        "UPDATE discovery_views SET id='legacy-view'; UPDATE discovery_view_items SET view_id='legacy-view'",
      )
      expect(() => validateDatabaseVersion(db, 4)).toThrow()
    } finally {
      c.database.close()
    }
  })

  it('filters before any rows are created and leaves other searches untouched', () => {
    const c = fixture(),
      r = c.services.discovery.repository
    try {
      const a = r.create(query({ salaryMin: 15000, salaryMax: 20000 }), 'salary')
      for (const salary of ['100元/天', '80元/小时', '20K美元/月', '面议', '5000元/月'])
        expect(r.observe(job({ salary }), a.id)).toBeNull()
      expect(c.database.db.prepare('SELECT COUNT(*) n FROM discovery_jobs').get()).toEqual({ n: 0 })
      expect(c.database.db.prepare('SELECT COUNT(*) n FROM discovery_observations').get()).toEqual({
        n: 0,
      })
      r.state(a.id, 'completed')
      const b = r.create(query(), 'all')
      r.observe(job({ salary: '100元/天' }), b.id)
      expect(r.list({ runId: b.id }).items[0]).toMatchObject({
        salary: '100元/天',
        salaryMin: null,
        salaryMax: null,
      })
      expect(r.observe(job({ salary: '100元/天' }), a.id)).toBeNull()
      expect(r.list({ runId: b.id }).total).toBe(1)
      validateDatabaseVersion(c.database.db, 4)
    } finally {
      c.database.close()
    }
  })
  it('preserves full JD and its age when list fields change; old views remain immutable', () => {
    const c = fixture(),
      r = c.services.discovery.repository
    try {
      const run = r.create(query(), 'detail-age')
      r.observe(job(), run.id, 100)
      const first = r.list({ runId: run.id }),
        id = first.items[0].id
      r.observe(job({ jd: '列表摘要', detailRead: false, salary: '30-40K' }), run.id, 200)
      expect(r.get(id)).toMatchObject({
        jd: '负责 Java 服务开发',
        detailReadAt: 100,
        readAt: 200,
        salaryMin: 30000,
      })
      expect(r.list({ runId: run.id, viewId: first.viewId }).items[0]).toMatchObject({
        readAt: 100,
        salaryMin: 12500,
      })
      expect(r.list({ runId: run.id }).items[0]).toMatchObject({ readAt: 200, salaryMin: 30000 })
      validateDatabaseVersion(c.database.db, 4)
    } finally {
      c.database.close()
    }
  })
  it('does not regress the current head when replaying an older cached list', () => {
    const c = fixture(),
      r = c.services.discovery.repository
    try {
      const a = r.create(query(), 'fresh')
      r.observe(job(), a.id, 200)
      r.state(a.id, 'completed')
      const b = r.create(query(), 'cached')
      r.observe(job({ jd: '', detailRead: false }), b.id, 100)
      const id = jobIdentity('boss', job().url).id
      expect(r.get(id)).toMatchObject({ detailReadAt: 200, readAt: 200 })
      expect(r.get(id, b.id)).toMatchObject({ detailReadAt: null, readAt: 100 })
      validateDatabaseVersion(c.database.db, 4)
    } finally {
      c.database.close()
    }
  })
  it('removes changed salary from refreshed results without breaking old views or saving', () => {
    const c = fixture(),
      r = c.services.discovery.repository
    try {
      const run = r.create(query({ salaryMin: 15000, salaryMax: 20000 }), 'changed')
      r.observe(job(), run.id, 100)
      const old = r.list({ runId: run.id }),
        id = old.items[0].id
      r.observe(job({ salary: '300元/天' }), run.id, 200, 'detail')
      expect(r.list({ runId: run.id }).total).toBe(0)
      const snapshot = r.get(id, run.id, old.items[0].observationId, old.viewId)
      expect(snapshot).toMatchObject({ removedFromCurrentSearch: true, salary: '12.5-20K·13薪' })
      expect(r.list({ runId: run.id, viewId: old.viewId }).total).toBe(1)
      const saved = c.services.discovery.saveSync({
        jobId: id,
        observationId: snapshot.observationId,
        newCompanyName: '历史公司',
        statusId: c.services.statuses.list()[0].id,
      })
      expect(saved.alreadySaved).toBe(false)
      validateDatabaseVersion(c.database.db, 4)
    } finally {
      c.database.close()
    }
  })
  it('reclaims obsolete observations but retains current heads, frozen views and saved references', () => {
    const c = fixture(),
      r = c.services.discovery.repository,
      db = c.database.db
    try {
      const a = r.create(query(), 'gc-a')
      for (let i = 0; i < 5; i++) r.observe(job(), a.id, 100 + i)
      r.state(a.id, 'completed')
      const b = r.create(query(), 'gc-b')
      r.observe(job(), b.id, 110)
      const old = r.list({ runId: b.id })
      r.observe(job(), b.id, 120)
      r.remove([a.id])
      expect(db.prepare('SELECT COUNT(*) n FROM discovery_observations').get()).toEqual({ n: 2 })
      expect(r.get(old.items[0].id, b.id, old.items[0].observationId, old.viewId).readAt).toBe(110)
      r.state(b.id, 'completed')
      r.remove([b.id])
      expect(db.prepare('SELECT COUNT(*) n FROM discovery_jobs').get()).toEqual({ n: 0 })
      expect(db.prepare('SELECT COUNT(*) n FROM discovery_observations').get()).toEqual({ n: 0 })
      validateDatabaseVersion(db, 4)
    } finally {
      c.database.close()
    }
  })
  it('uses the same UTF-8 byte limit at write, CHECK and restore boundaries', () => {
    const c = fixture(),
      r = c.services.discovery.repository,
      db = c.database.db
    try {
      const run = r.create(query(), 'bytes')
      const base = normalizeJob(job({ jd: 'x' }), 100)
      // Determine the exact JSON byte overhead, retaining a complete non-empty JD.
      const overhead = Buffer.byteLength(observationPayload(base)) - 1
      const jd =
        '中'.repeat(Math.floor((MAX_OBSERVATION_BYTES - overhead) / 3)) +
        'x'.repeat((MAX_OBSERVATION_BYTES - overhead) % 3)
      const id = r.observe(job({ jd }), run.id, 100)!
      expect(
        Buffer.byteLength(
          (
            db.prepare('SELECT payload FROM discovery_observations WHERE id=?').get(id) as {
              payload: string
            }
          ).payload,
        ),
      ).toBe(MAX_OBSERVATION_BYTES)
      validateDatabaseVersion(db, 4)
      expect(() => r.observe(job({ jd: jd + '中' }), run.id, 101)).toThrow('Oversized')
      const old = db.prepare('SELECT payload FROM discovery_observations WHERE id=?').get(id) as {
        payload: string
      }
      expect(() =>
        db
          .prepare('UPDATE discovery_observations SET payload=? WHERE id=?')
          .run(JSON.stringify({ ...JSON.parse(old.payload), jd: jd + '中' }), id),
      ).toThrow()
      expect(db.prepare('SELECT COUNT(*) n FROM discovery_observations').get()).toEqual({ n: 1 })
    } finally {
      c.database.close()
    }
  })
  it('rejects invalid constraints, identity and missing idempotency bindings', () => {
    const c = fixture(),
      r = c.services.discovery.repository,
      db = c.database.db
    try {
      const run = r.create(query(), 'integrity')
      r.observe(job(), run.id)
      expect(() => db.exec('UPDATE discovery_jobs SET id=NULL')).toThrow()
      expect(() => db.exec("UPDATE discovery_sources SET state='fake'")).toThrow()
      expect(() => db.exec('UPDATE discovery_sources SET generation=-1')).toThrow()
      expect(() => db.exec('UPDATE discovery_jobs SET current_observation_id=1.5')).toThrow()
      expect(() => db.exec('UPDATE discovery_results SET relevance=0.5')).toThrow()
      r.list({ runId: run.id })
      expect(() => db.exec('UPDATE discovery_view_items SET ordinal=1.5')).toThrow()
      expect(() => db.exec('UPDATE discovery_view_items SET observation_id=0')).toThrow()
      db.exec("UPDATE discovery_jobs SET identity='wrong'")
      expect(() => validateDatabaseVersion(db, 4)).toThrow('identity')
      db.prepare('UPDATE discovery_jobs SET identity=?').run(
        jobIdentity('boss', job().url, job().externalId).identity,
      )
      db.prepare('DELETE FROM discovery_requests WHERE request_id=?').run('integrity')
      expect(() => validateDatabaseVersion(db, 4)).toThrow('binding')
    } finally {
      c.database.close()
    }
  })
  it('uses the fingerprint index with ten thousand historical jobs', () => {
    const c = fixture(),
      r = c.services.discovery.repository,
      db = c.database.db
    try {
      const run = r.create(query({ platforms: ['boss', 'liepin'] }), 'scale')
      db.transaction(() => {
        for (let i = 0; i < 10000; i++)
          r.observe(
            job({
              platform: 'liepin',
              url: 'https://www.liepin.com/job/' + (10000000 + i) + '.shtml',
              externalId: String(10000000 + i),
              company: '公司' + i,
            }),
            run.id,
          )
      })()
      r.state(run.id, 'completed')
      const current = r.create(query(), 'scale-current')
      db.transaction(() => {
        for (let i = 0; i < 50; i++)
          r.observe(
            job({
              url: 'https://www.zhipin.com/job_detail/scale' + i + '.html',
              externalId: 'scale' + i,
              company: '公司' + i,
            }),
            current.id,
          )
      })()
      const plan = db
        .prepare(
          'EXPLAIN QUERY PLAN SELECT EXISTS(SELECT 1 FROM discovery_jobs j2 WHERE j2.duplicate_fingerprint=j.duplicate_fingerprint AND j2.platform<>j.platform) FROM discovery_jobs j LIMIT 50',
        )
        .all() as { detail: string }[]
      expect(plan.some((p) => p.detail.includes('idx_discovery_job_duplicate'))).toBe(true)
      expect(plan.some((p) => p.detail.includes('SCAN j2'))).toBe(false)
      const start = performance.now(),
        page = r.list({ runId: current.id, pageSize: 50 })
      expect(page.total).toBe(50)
      expect(page.items.every((j) => j.possibleDuplicate || j.company !== '公司0')).toBe(true)
      const firstMs = performance.now() - start
      const samples = Array.from({ length: 10 }, () => {
        const at = performance.now()
        expect(r.list({ runId: current.id, viewId: page.viewId, pageSize: 50 }).total).toBe(50)
        return performance.now() - at
      }).sort((a, b) => a - b)
      console.log(
        'discovery 10000 historical + 50 current rows first/repeated median ms:',
        firstMs.toFixed(2),
        samples[5].toFixed(2),
      )
    } finally {
      c.database.close()
    }
  })
})
