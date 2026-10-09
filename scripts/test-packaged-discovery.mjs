import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { _electron as electron } from 'playwright'
import { linkPackagedProgram } from './packaged-test-helpers.mjs'

const project = path.resolve(import.meta.dirname, '..')
const staging = fs.mkdtempSync(path.join(project, 'dist', '.discovery-smoke-'))
const root = path.join(staging, 'JobTrail'),
  runtime = path.join(root, '.runtime', 'current')
const qa = path.join(project, 'dist', 'qa')
fs.mkdirSync(qa, { recursive: true })
linkPackagedProgram(path.join(project, 'dist', 'win-unpacked'), runtime)
fs.copyFileSync(
  path.join(project, 'native', 'bootstrap', 'target', 'debug', 'launcher.exe'),
  path.join(root, 'JobTrail.exe'),
)
const env = { ...process.env, APPDATA: staging }
delete env.ELECTRON_RUN_AS_NODE
let application
const errors = []
const report = { at: new Date().toISOString(), run: null, blockers: [], passed: false }
try {
  application = await electron.launch({
    executablePath: path.join(runtime, 'zhiji.exe'),
    args: [`--user-data-dir=${path.join(staging, 'chromium')}`],
    env,
  })
  const page = await application.firstWindow()
  const mainWindow = await application.browserWindow(page)
  page.setDefaultTimeout(20000)
  page.on('pageerror', (e) => errors.push(e.message))
  await page.locator('.sidebar').waitFor()
  await page.locator('.sidebar').getByText('岗位发现', { exact: true }).click()
  await page.getByPlaceholder('关键词', { exact: true }).fill('Java')
  await page.screenshot({ path: path.join(qa, 'discovery-empty.png') })
  await page.getByRole('button', { name: '账号管理', exact: true }).click()
  await page.locator('.discovery-account').first().waitFor()
  assert.equal(await page.locator('.discovery-account').count(), 4)
  await page.screenshot({ path: path.join(qa, 'discovery-accounts.png') })
  await page
    .locator('.discovery-accounts')
    .getByRole('button', { name: '关闭', exact: true })
    .click()
  // This is a service-level anonymous probe. The user-facing search requires login;
  // its selection and cancellation behavior is covered by test-discovery-dialogs.
  const run = await page.evaluate(() =>
    window.zhijiApi.discovery.start({
      requestId: crypto.randomUUID(),
      query: { keyword: 'Java', city: '上海', platforms: ['boss', 'liepin', 'zhilian', 'wuyou'] },
    }),
  )
  console.log('Search started', run.id)
  let result = run
  for (let i = 0; i < 100 && ['running', 'queued'].includes(result.state); i++) {
    await new Promise((r) => setTimeout(r, 1000))
    result = await page.evaluate((id) => window.zhijiApi.discovery.run(id), run.id)
  }
  console.log(
    'Live anonymous result',
    JSON.stringify(
      result.sources.map((s) => ({
        platform: s.platform,
        state: s.state,
        count: s.count,
        batches: s.batches,
        message: s.message,
      })),
    ),
  )
  report.run = result
  report.blockers = result.sources
    .filter((source) => !['partial', 'completed'].includes(source.state))
    .map((source) => `${source.platform}: ${source.state} / ${source.message}`)
  assert.ok(!['running', 'queued'].includes(result.state), 'Search must respect the round budget')
  await page.getByRole('button', { name: '搜索历史', exact: true }).click()
  await page.getByRole('button', { name: '查看', exact: true }).first().click()
  const first = await page.evaluate(async (id) => {
    const list = await window.zhijiApi.discovery.list({
      runId: id,
      page: 1,
      pageSize: 20,
    })
    return list.items[0]?.id
  }, run.id)
  if (!first)
    report.blockers.push('No jobs returned: detail, browser and save interactions not exercised')
  if (first) {
    await page.locator('.discovery-job').first().click()
    await page.getByRole('button', { name: '打开浏览器', exact: true }).click()
    await new Promise((r) => setTimeout(r, 5000))
    const native = await mainWindow.evaluate((win) =>
      win.contentView.children.map((v) => ({
        visible: v.getVisible(),
        bounds: v.getBounds(),
        alive: !!v.webContents && !v.webContents.isDestroyed(),
      })),
    )
    console.log('JOB_BROWSER', JSON.stringify(native))
    assert.ok(
      native.some((v) => v.alive && v.visible && v.bounds.width > 100),
      'Job browser must remain alive and visible',
    )
    await page.getByRole('button', { name: '账号管理', exact: true }).click()
    assert.equal(
      await mainWindow.evaluate((win) => win.contentView.children.some((v) => v.getVisible())),
      false,
    )
    await page
      .locator('.discovery-accounts')
      .getByRole('button', { name: '关闭', exact: true })
      .click()
    await page.getByRole('button', { name: '详情', exact: true }).click()
    await page.locator('.discovery-detail .n-spin').waitFor({ state: 'hidden', timeout: 30000 })
    assert.doesNotMatch(
      await page.locator('.discovery-detail-header h2').innerText(),
      /访问验证|安全验证/,
    )
    const detail = await page.evaluate(
      ({ first, runId }) => window.zhijiApi.discovery.detail({ jobId: first, runId }),
      { first, runId: run.id },
    )
    console.log(
      'DETAIL_EVIDENCE',
      JSON.stringify({
        platform: detail.platform,
        detailRead: detail.detailRead,
        missing: detail.missing,
      }),
    )
    if (!detail.detailRead || detail.missing.jd)
      report.blockers.push(
        `${detail.platform}: complete JD not verified / ${detail.missing.jd ?? 'detail_not_read'}`,
      )
    await page.getByRole('button', { name: '加入求职记录', exact: true }).click()
    await page.getByText('确认新建公司', { exact: true }).click()
    await page.getByRole('button', { name: '确认保存', exact: true }).click()
    await page.locator('.discovery-save-form').waitFor({ state: 'hidden' })
    const saved = await page.evaluate(
      ({ first, runId }) => window.zhijiApi.discovery.detail({ jobId: first, runId }),
      { first, runId: run.id },
    )
    assert.ok(saved.savedOpportunityId, 'UI save must persist the source association')
  }
  await page.screenshot({ path: path.join(qa, 'discovery-search.png') })
  await mainWindow.evaluate((win) => win.setSize(800, 650))
  if (first) {
    await page.locator('.discovery-back-list').waitFor({ state: 'visible' })
    assert.ok(
      (await page
        .locator('.discovery-detail-body')
        .evaluate((e) => e.getBoundingClientRect().height)) > 80,
      'Narrow layout must leave space for JD content',
    )
  }
  await page.screenshot({ path: path.join(qa, 'discovery-narrow.png') })
  assert.deepEqual(errors, [])
  assert.deepEqual(
    report.blockers,
    [],
    'Anonymous platform acceptance incomplete; see discovery-live-anonymous.json',
  )
  report.passed = true
  console.log(
    'Packaged anonymous sources and sampled browser/detail/save interactions passed; logged-in searches and continuation require separate acceptance.',
    staging,
  )
} finally {
  try {
    fs.writeFileSync(
      path.join(qa, 'discovery-live-anonymous.json'),
      JSON.stringify(report, null, 2),
    )
  } finally {
    if (application) await application.close()
  }
}
