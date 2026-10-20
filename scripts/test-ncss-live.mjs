import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { _electron as electron } from 'playwright'
import { linkPackagedProgram, skipToursForTest, waitFor } from './packaged-test-helpers.mjs'

// Human-in-the-loop acceptance. Keep authentication inside the disposable
// platform profile; evidence includes only job query parameters and counts.
const project = path.resolve(import.meta.dirname, '..')
const staging = fs.mkdtempSync(path.join(project, 'dist', '.ncss-live-'))
const root = path.join(staging, 'JobTrail'),
  runtime = path.join(root, '.runtime/current')
linkPackagedProgram(path.join(project, 'dist/win-unpacked'), runtime)
const env = { ...process.env, APPDATA: staging }
delete env.ELECTRON_RUN_AS_NODE
let app, page
const report = {
  at: new Date().toISOString(),
  kind: 'packaged_ncss_live',
  queries: [],
  requests: [],
  passed: false,
}
const evidence = path.join(staging, 'report.json')
async function launch() {
  app = await electron.launch({
    executablePath: path.join(runtime, 'zhiji.exe'),
    args: [`--user-data-dir=${path.join(staging, 'chromium')}`],
    env,
  })
  page = await app.firstWindow()
  await skipToursForTest(page)
}
async function settle(id) {
  await waitFor(
    async () =>
      !['running', 'queued'].includes(
        (await page.evaluate((id) => window.zhijiApi.discovery.run(id), id)).state,
      ),
    'NCSS search batch',
    180000,
  )
  return page.evaluate((id) => window.zhijiApi.discovery.run(id), id)
}
async function showQr() {
  await page.locator('.sidebar').getByText('岗位发现', { exact: true }).click()
  await page.getByRole('button', { name: '账号管理', exact: true }).click()
  await page
    .locator('.discovery-account')
    .filter({ hasText: '国家大学生就业服务平台' })
    .getByRole('button', { name: '扫码登录', exact: true })
    .click()
  await page.locator('.discovery-qr-image').waitFor({ timeout: 65000 })
  await page.locator('.discovery-qr-image').evaluate((img) => img.decode())
  await (
    await app.browserWindow(page)
  ).evaluate((win) => {
    win.show()
    win.focus()
  })
  console.log('NCSS_QR_READY', staging)
  await waitFor(
    async () => {
      const state = await page.evaluate(() =>
        window.zhijiApi.discovery.qrLogin({ action: 'get', platform: 'ncss' }),
      )
      if (state?.state === 'error') throw new Error(`QR ${state.reason}`)
      return state?.state === 'authenticated'
    },
    'human WeChat scan and positive student account confirmation',
    1200000,
  )
  await page
    .locator('.discovery-accounts')
    .getByRole('button', { name: '关闭', exact: true })
    .click()
  console.log('NCSS_AUTHENTICATED')
}
try {
  await launch()
  const anonymous = await page.evaluate(() =>
    window.zhijiApi.discovery.start({
      requestId: crypto.randomUUID(),
      query: { keyword: 'Java', platforms: ['ncss'] },
    }),
  )
  assert.equal((await settle(anonymous.id)).sources[0].state, 'login_required')
  report.loginGate = true
  await app.evaluate(({ session }, root) => {
    const current = session.fromPath(
      process.getBuiltinModule('path').join(root, 'browser-sessions/ncss'),
    )
    globalThis.ncssQueryEvidence = []
    current.webRequest.onCompleted((event) => {
      const u = new URL(event.url)
      if (u.origin === 'https://job.ncss.cn' && u.pathname === '/student/jobs/jobslist/ajax/')
        globalThis.ncssQueryEvidence.push({
          status: event.statusCode,
          query: Object.fromEntries([...u.searchParams].filter(([key]) => key !== '_')),
        })
    })
  }, root)
  await showQr()
  let saved
  for (const keyword of ['Java', '销售'])
    for (const city of ['北京', '上海', '']) {
      const query = { keyword, city, platforms: ['ncss'] }
      const run = await page.evaluate(
        (query) => window.zhijiApi.discovery.start({ requestId: crypto.randomUUID(), query }),
        query,
      )
      let result = await settle(run.id)
      const firstPage = result.sources[0].sourcePage
      if (result.sources[0].state === 'partial') {
        await page.evaluate((id) => window.zhijiApi.discovery.continue(id), run.id)
        result = await settle(run.id)
      }
      const list = await page.evaluate(
        (id) => window.zhijiApi.discovery.list({ runId: id }),
        run.id,
      )
      const item = {
        keyword,
        city,
        runId: run.id,
        firstPage,
        source: result.sources[0],
        total: list.total,
      }
      if (list.items.length) {
        const job = await page.evaluate(
          ({ jobId, runId }) => window.zhijiApi.discovery.detail({ jobId, runId, mode: 'ensure' }),
          { jobId: list.items[0].id, runId: run.id },
        )
        item.detail = { complete: job.detailRead, jdLength: job.jd.length, missing: job.missing }
        assert.ok(job.detailRead && job.jd.length)
        if (!saved) {
          const statuses = await page.evaluate(() => window.zhijiApi.statuses.list())
          saved = await page.evaluate(
            ({ job, statusId }) =>
              window.zhijiApi.discovery.save({
                jobId: job.id,
                observationId: job.observationId,
                newCompanyName: job.company,
                statusId,
              }),
            { job, statusId: statuses[0].id },
          )
          item.saved = true
        }
      }
      report.queries.push(item)
      fs.writeFileSync(evidence, JSON.stringify(report, null, 2))
      console.log('NCSS_QUERY', JSON.stringify(item))
      assert.ok(['completed', 'partial'].includes(result.sources[0].state))
    }
  report.requests = await app.evaluate(() => globalThis.ncssQueryEvidence)
  const finalRequests = report.requests.filter(
    (r) => r.query.sourcesName === '0' && r.query.recruitType === '0',
  )
  assert.ok(finalRequests.length >= 6)
  for (const { query: q } of finalRequests) {
    assert.equal(q.sourcesType, '')
    assert.equal(q.jobType, '')
    assert.equal(q.limit, '10')
  }
  for (const item of report.queries) {
    const areaCode = item.city === '北京' ? '11' : item.city === '上海' ? '31' : ''
    assert.ok(
      finalRequests.some(
        ({ query: q }) =>
          q.jobName === item.keyword &&
          q.areaCode === areaCode &&
          q.offset === '1' &&
          [
            'monthPay',
            'industrySectors',
            'property',
            'categoryCode',
            'memberLevel',
            'keyUnits',
            'degreeCode',
          ].every((key) => q[key] === ''),
      ),
      'Each user query must have a captured request with the complete fixed scope',
    )
  }
  report.saved = !!saved
  await page.evaluate(() =>
    window.zhijiApi.discovery.browser({ action: 'clear', platform: 'ncss' }),
  )
  report.logout = (await page.evaluate(() => window.zhijiApi.discovery.status())).find(
    (s) => s.platform === 'ncss',
  ).state
  assert.notEqual(report.logout, 'authenticated')
  console.log('NCSS_LOGOUT_VERIFIED')
  // A second user scan verifies clean logout followed by a new official login.
  await showQr()
  report.relogin = true
  await app.evaluate(({ app }) => app.quit())
  await app.close().catch(() => {})
  await launch()
  const history = await page.evaluate(() => window.zhijiApi.discovery.history(1))
  report.restart = {
    historyCount: history.total,
    savedOpportunityPresent: !!(
      saved &&
      (await page.evaluate((id) => window.zhijiApi.opportunities.get(id), saved.opportunityId))
    ),
  }
  const probe = await page.evaluate(() =>
    window.zhijiApi.discovery.start({
      requestId: crypto.randomUUID(),
      query: { keyword: 'Java', city: '北京', platforms: ['ncss'] },
    }),
  )
  report.restart.source = (await settle(probe.id)).sources[0]
  assert.ok(
    ['completed', 'partial', 'session_expired', 'login_required'].includes(
      report.restart.source.state,
    ),
    'Restart must either confirm the live session or explicitly require another login',
  )
  if (['session_expired', 'login_required'].includes(report.restart.source.state)) {
    assert.equal(report.restart.source.count, 0)
    assert.equal(report.restart.source.batches, 0)
  }
  assert.ok(report.restart.historyCount >= 7 && report.restart.savedOpportunityPresent)
  report.passed = true
  console.log('NCSS_LIVE_COMPLETE', evidence)
} finally {
  fs.writeFileSync(evidence, JSON.stringify(report, null, 2))
  await app?.close().catch(() => {})
}
