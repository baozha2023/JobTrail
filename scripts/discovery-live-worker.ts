import { cityCode } from '../src/shared/discovery-cities'
/** Manual source-level acceptance with fresh isolated data and anonymous Sessions. */
import { app, type WebContents } from 'electron'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createServiceContainer } from '../src/main/service-container'
import { DiscoveryRuntime } from '../src/main/discovery/runtime'
import { platforms, type JobPlatform, type SearchRun } from '../src/shared/job-discovery'
import { salaryExclusion } from '../src/main/discovery/normalization'
import { searchQuerySchema } from '../src/shared/job-discovery'
import { jobIdentity } from '../src/main/discovery/platforms'
import { bossResponse } from '../src/main/discovery/adapters/boss'
import { liepinResponse } from '../src/main/discovery/adapters/liepin'
import { zhilianResponse, zhilianInitial } from '../src/main/discovery/adapters/zhilian'
import { wuyouResponse } from '../src/main/discovery/adapters/wuyou'
import { wait, bounded } from '../src/main/discovery/async-control'
import { record, rows, text } from '../src/main/discovery/parsing'

const qa = path.join(process.cwd(), 'dist/qa')
fs.mkdirSync(qa, { recursive: true })
const root = fs.mkdtempSync(path.join(qa, 'live-acceptance-'))
app.setName('zhiji')
app.setPath('userData', path.join(root, 'chromium'))
app.on('window-all-closed', () => {})
process.on('uncaughtException', (error) => {
  console.error(error)
  app.exit(1)
})

// Independently observe website responses; use each adapter's admission contract for expected storage.
type Captured = {
  platform: JobPlatform
  page: number
  rawCount: number
  rejectedCount: number
  cityFilteredCount: number
  ids: string[]
  salaries: string[]
}
type Query = { keyword: string; city: string; salaryMin?: number; salaryMax?: number }
const matrix = {
  'city-restored': { keyword: '销售', city: '三沙' },
  'city-common': { keyword: '销售', city: '北京' },
  salary: { keyword: 'Java', city: '北京', salaryMin: 17321, salaryMax: 28456 },
  'salary-min': { keyword: 'Java', city: '北京', salaryMin: 17321 },
  'salary-max': { keyword: 'Java', city: '北京', salaryMax: 28456 },
  agent: { keyword: 'agent', city: '北京' },
  'java-beijing': { keyword: 'Java', city: '北京' },
  'java-shanghai': { keyword: 'Java', city: '上海' },
  'no-city': { keyword: 'Java', city: '' },
  empty: { keyword: 'zzzhj_no_job_7f936c', city: '北京' },
}
const [platformArg = 'all', caseArg = 'all'] = process.argv.slice(2)
assert.ok(
  platformArg === 'all' || platforms.includes(platformArg as JobPlatform),
  'Unknown platform',
)
assert.ok(
  caseArg === 'all' || caseArg === 'cities' || Object.hasOwn(matrix, caseArg),
  'Unknown test case',
)
const selectedPlatforms = platformArg === 'all' ? [...platforms] : [platformArg as JobPlatform]
const queries =
  caseArg === 'all'
    ? Object.values(matrix)
    : caseArg === 'cities'
      ? [matrix['city-restored'], matrix['city-common']]
      : [matrix[caseArg as keyof typeof matrix]]
const reportName =
  platformArg === 'all' && caseArg === 'all'
    ? 'discovery-live-acceptance.json'
    : `discovery-live-${platformArg}-${caseArg}.json`
let active: Query | undefined
const captured = new Map<string, Captured>(),
  bodyTasks = new Set<Promise<void>>(),
  captureErrors: string[] = []
const observed: { platform: JobPlatform; keyword: string; city: string; page: number }[] = []
function observe(contents: WebContents) {
  contents.on('dom-ready', () => {
    const query = active
    if (!query || !/^https:\/\/www.zhaopin.com\/jobs/.test(contents.getURL())) return
    const task = (async () => {
      const signal = AbortSignal.timeout(6000)
      while (active === query && !contents.isDestroyed()) {
        const initial = await bounded(
          contents.executeJavaScript(
            `(()=>{const s=window.__INITIAL_STATE__;return s?{pageMode:s.pageMode,queryParams:s.queryParams,pageIndex:s.pageIndex,loadingStatus:s.loadingStatus,listLoadError:s.listLoadError,hasMore:s.hasMore,positionList:s.positionList?.map(j=>({positionUrl:j.positionUrl,name:j.name,companyName:j.companyName,workCity:j.workCity,salary60:j.salary60,workingExp:j.workingExp,education:j.education,jobSummary:j.jobSummary}))}:null})()`,
          ),
          signal,
        )
        const parsed = zhilianInitial(initial, query, 1)
        if (parsed) {
          captured.set('zhilian:1', {
            platform: 'zhilian',
            page: 1,
            rawCount: parsed.rawCount,
            rejectedCount: parsed.rejectedCount,
            cityFilteredCount: 0,
            ids: parsed.jobs.map((job) => jobIdentity('zhilian', job.url, job.externalId).id),
            salaries: parsed.jobs.map((job) => job.salary),
          })
          return
        }
        await wait(100, signal)
      }
    })().catch(() => {})
    bodyTasks.add(task)
    void task.finally(() => bodyTasks.delete(task))
  })
  const requests = new Map<
      string,
      { platform: JobPlatform; page: number; pageSize: number; key: string }
    >(),
    latest = new Map<string, string>()
  contents.debugger.on('message', (_e, method, value: unknown) => {
    const data = record(value),
      id = text(data.requestId)
    if (method === 'Network.requestWillBeSent' && active) {
      const req = record(data.request),
        url = new URL(text(req.url)),
        body = text(req.postData)
      let p: JobPlatform | undefined,
        keyword = '',
        city = '',
        page = 0
      if (
        url.hostname === 'www.zhipin.com' &&
        url.pathname === '/wapi/zpgeek/search/joblist.json' &&
        req.method === 'POST'
      ) {
        p = 'boss'
        const form = new URLSearchParams(body)
        keyword = form.get('query') ?? ''
        city = form.get('city') ?? ''
        page = Number(form.get('page'))
      } else if (
        url.hostname === 'api-c.liepin.com' &&
        url.pathname === '/api/com.liepin.searchfront4c.pc-search-job' &&
        req.method === 'POST'
      ) {
        p = 'liepin'
        const form = record(record(record(JSON.parse(body)).data).mainSearchPcConditionForm)
        keyword = text(form.key)
        city = text(form.dq)
        page = Number(form.currentPage) + 1
      } else if (
        url.hostname === 'fe-api.zhaopin.com' &&
        url.pathname === '/c/i/search/positions' &&
        req.method === 'POST'
      ) {
        const form = record(JSON.parse(body))
        if (form.eventScenario !== 'pcSearchedSouSearch') return
        p = 'zhilian'
        keyword = text(form.S_SOU_FULL_INDEX)
        city = String(form.S_SOU_WORK_CITY)
        page = Number(form.pageIndex)
      } else if (
        url.hostname === 'we.51job.com' &&
        url.pathname === '/api/job/search-pc' &&
        req.method === 'GET'
      ) {
        p = 'wuyou'
        keyword = url.searchParams.get('keyword') ?? ''
        city = url.searchParams.get('jobArea') ?? ''
        page = Number(url.searchParams.get('pageNum'))
      }
      if (p) observed.push({ platform: p, keyword, city, page })
      if (
        !p ||
        keyword.toLowerCase() !== active.keyword.toLowerCase() ||
        (active.city && city !== cityCode(p, active.city))
      )
        return
      const key = p + ':' + page
      latest.set(key, id)
      requests.set(id, {
        platform: p,
        page,
        pageSize: Number(url.searchParams.get('pageSize')),
        key,
      })
    } else if (method === 'Network.loadingFinished' && requests.has(id)) {
      const req = requests.get(id)!
      requests.delete(id)
      const task = contents.debugger
        .sendCommand('Network.getResponseBody', { requestId: id })
        .then((raw: unknown) => {
          if (latest.get(req.key) !== id) return
          const response = record(raw),
            body = text(response.body),
            value = record(
              JSON.parse(
                response.base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body,
              ),
            )
          const parsed =
            req.platform === 'boss'
              ? bossResponse(value, req.page)
              : req.platform === 'liepin'
                ? liepinResponse(value, req.page, active!.city)
                : req.platform === 'zhilian'
                  ? zhilianResponse(value, req.page)
                  : wuyouResponse(value, req.page, req.pageSize, active!.city)
          captured.set(req.key, {
            platform: req.platform,
            page: req.page,
            rawCount: parsed.rawCount,
            rejectedCount: parsed.rejectedCount,
            cityFilteredCount: parsed.sourceIds.length - parsed.jobs.length,
            ids: parsed.jobs.map((job) => jobIdentity(req.platform, job.url, job.externalId).id),
            salaries: parsed.jobs.map((job) => job.salary),
          })
        })
        .catch((error) => {
          captureErrors.push(String(error))
        })
        .finally(() => bodyTasks.delete(task))
      bodyTasks.add(task)
    }
  })
}
app.on('web-contents-created', (_e, contents) => observe(contents))

app
  .whenReady()
  .then(async () => {
    const container = createServiceContainer(
      {
        root,
        config: path.join(root, 'config.json'),
        data: path.join(root, 'data'),
        database: path.join(root, 'data/zhiji.db'),
        resumes: path.join(root, 'resumes'),
        chatUploads: path.join(root, 'chat-uploads'),
      },
      true,
      false,
    )
    const service = container.services.discovery,
      runtime = new DiscoveryRuntime(root, service, () => undefined)
    service.live = runtime
    const reports: unknown[] = []
    const saveReport = () =>
      fs.writeFileSync(
        path.join(qa, reportName),
        JSON.stringify(
          {
            at: new Date().toISOString(),
            dataRoot: root,
            sessionRoot: path.join(root, 'browser-sessions'),
            reports,
          },
          null,
          2,
        ),
      )
    const settle = async (id: string) => {
      const signal = AbortSignal.timeout(105000)
      while (true) {
        const run = await service.run(id)
        if (!['running', 'queued'].includes(run.state)) return run
        await wait(300, signal)
      }
    }
    const traverse = async (runId: string, viewId: string, size: 10 | 20 | 50) => {
      const first = await service.list({ runId, viewId, pageSize: size })
      const ids = first.items.map((j) => j.id)
      for (let page = 2; page <= Math.ceil(first.total / size); page++)
        ids.push(
          ...(await service.list({ runId, viewId, pageSize: size, page })).items.map((j) => j.id),
        )
      assert.equal(new Set(ids).size, ids.length, 'Display pages contain duplicates')
      return ids
    }
    const reconcile = async (run: SearchRun, failures: string[]) => {
      await Promise.all([...bodyTasks])
      assert.deepEqual(captureErrors, [], 'Raw source capture failed')
      const sourceReports = []
      for (const source of run.sources) {
        try {
          assert.ok(
            ['partial', 'completed'].includes(source.state),
            source.platform + ': ' + source.state + ' / ' + source.message,
          )
          const batches = [...captured.values()].filter(
            (b) => b.platform === source.platform && b.page <= source.sourcePage,
          )
          assert.equal(
            batches.length,
            source.sourcePage,
            source.platform + ': every committed page needs independent response evidence',
          )
          const salaryQuery = searchQuerySchema.parse({
            ...run.query,
            platforms: [source.platform],
          })
          const candidates = new Map(
            batches.flatMap((b) => b.ids.map((id, i) => [id, b.salaries[i]] as const)),
          )
          const expected = [...candidates]
            .filter(([, salary]) => !salaryExclusion(salary, salaryQuery))
            .map(([id]) => id)
            .sort()
          const stored = (
            container.database.db
              .prepare(
                'SELECT r.job_id id FROM discovery_results r JOIN discovery_jobs j ON j.id=r.job_id WHERE r.run_id=? AND j.platform=?',
              )
              .all(run.id, source.platform) as { id: string }[]
          )
            .map((r) => r.id)
            .sort()
          assert.deepEqual(
            stored,
            expected,
            source.platform + ': source and saved identity sets differ',
          )
          sourceReports.push({
            platform: source.platform,
            pages: source.sourcePage,
            raw: batches.reduce((n, b) => n + b.rawCount, 0),
            unique: expected.length,
            duplicates: source.duplicateCount,
            rejected: batches.reduce((n, b) => n + b.rejectedCount, 0),
            cityFiltered: batches.reduce((n, b) => n + b.cityFilteredCount, 0),
            salaryExcluded: source.salaryExcluded,
            end: source.state === 'completed',
            submitted: source.remote,
          })
        } catch (error) {
          failures.push(String(error))
          sourceReports.push({ platform: source.platform, failure: String(error) })
        }
      }
      return sourceReports
    }
    const blocked = new Set<JobPlatform>()
    const needsUser = (run: SearchRun) =>
      run.sources.filter((s) =>
        ['challenge', 'login_required', 'session_expired'].includes(s.state),
      )
    try {
      for (const query of queries) {
        active = query
        captured.clear()
        captureErrors.length = 0
        observed.length = 0
        const available = selectedPlatforms.filter((p) => !blocked.has(p))
        if (!available.length) {
          reports.push({
            query,
            failures: ['Remaining platforms require user verification; no further requests sent'],
          })
          break
        }
        const requestId = randomUUID()
        const run = await service.start({
          query: { ...query, platforms: available },
          requestId,
        })
        assert.equal(
          (await service.start({ query: { ...query, platforms: available }, requestId })).id,
          run.id,
        )
        const first = await settle(run.id)
        const report: {
          query: Query
          runId: string
          sources: unknown
          observed?: unknown
          round1?: unknown
          round2?: unknown
          pagination?: string
          failures: string[]
        } = {
          query,
          runId: run.id,
          sources: first.sources,
          failures: [...blocked].map((p) => p + ': pending user verification; skipped'),
        }
        for (const s of needsUser(first)) blocked.add(s.platform)
        reports.push(report)
        try {
          report.round1 = await reconcile(first, report.failures)
          const view = await service.list({ runId: run.id, pageSize: 10 })
          const before = await traverse(run.id, view.viewId, 10)
          if (first.sources.some((s) => s.state === 'partial')) {
            assert.equal(
              needsUser(first).length,
              0,
              'Continuation paused until user verification; retest unaffected platforms separately',
            )
            await service.continue(run.id)
            const second = await settle(run.id)
            for (const s of needsUser(second)) blocked.add(s.platform)
            report.round2 = await reconcile(second, report.failures)
            for (const source of second.sources)
              if (source.sourcePage < 5 && source.state !== 'completed')
                report.failures.push(
                  source.platform + ': continuation must reach page 5 or prove end',
                )
          }
          const after = await traverse(run.id, view.viewId, 10)
          assert.deepEqual(
            after.slice(0, before.length),
            before,
            'Existing positions moved after continuation',
          )
          assert.deepEqual(await traverse(run.id, view.viewId, 20), after)
          assert.deepEqual(await traverse(run.id, view.viewId, 50), after)
          const stored = (
            container.database.db
              .prepare('SELECT job_id id FROM discovery_results WHERE run_id=?')
              .all(run.id) as { id: string }[]
          )
            .map((r) => r.id)
            .sort()
          assert.deepEqual(
            [...after].sort(),
            stored,
            'SQLite results and all displayed pages differ',
          )
          report.pagination = '10/20/50 sets equal; fixed prefix unchanged'
        } catch (error) {
          report.failures.push(String(error))
        }
        report.observed = [...observed]
        saveReport()
        console.log(JSON.stringify(report))
      }
      assert.ok(
        reports.every((r) => rows(record(r).failures).length === 0),
        'See per-query failures in the live acceptance report',
      )
    } finally {
      active = undefined
      await runtime.suspend()
      container.database.close()
      saveReport()
      app.quit()
    }
  })
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })
