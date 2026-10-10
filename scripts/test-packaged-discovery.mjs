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
  assert.equal(await page.locator('.discovery-account').count(), 6)
  await page.screenshot({ path: path.join(qa, 'discovery-accounts.png') })
  await page
    .locator('.discovery-accounts')
    .getByRole('button', { name: '关闭', exact: true })
    .click()
  // Direct IPC must enforce login too, even for sources with public listings.
  const run = await page.evaluate(() =>
    window.zhijiApi.discovery.start({
      requestId: crypto.randomUUID(),
      query: {
        keyword: 'Java',
        city: '上海',
        platforms: ['boss', 'liepin', 'zhilian', 'wuyou', 'iguopin', 'shixiseng'],
      },
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
  assert.equal(result.sources.length, 6)
  for (const source of result.sources) {
    assert.equal(source.state, 'login_required')
    assert.equal(source.count, 0)
    assert.equal(source.batches, 0)
  }
  await page.getByRole('button', { name: '搜索历史', exact: true }).click()
  await page.getByRole('button', { name: '查看', exact: true }).first().click()
  assert.equal(
    (await page.evaluate((id) => window.zhijiApi.discovery.list({ runId: id }), run.id)).total,
    0,
  )
  await page.screenshot({ path: path.join(qa, 'discovery-search.png') })
  await mainWindow.evaluate((win) => win.setSize(800, 650))
  await page.screenshot({ path: path.join(qa, 'discovery-narrow.png') })
  assert.deepEqual(errors, [])
  assert.deepEqual(
    report.blockers,
    [],
    'Login gate acceptance failed; see discovery-login-gate.json',
  )
  report.passed = true
  console.log(
    'All six packaged sources reject anonymous collection. Real signed-in search/detail/save acceptance remains separate.',
    staging,
  )
} finally {
  try {
    fs.writeFileSync(path.join(qa, 'discovery-login-gate.json'), JSON.stringify(report, null, 2))
  } finally {
    if (application) await application.close()
  }
}
