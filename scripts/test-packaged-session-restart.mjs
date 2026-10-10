import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { _electron as electron } from 'playwright'
import { linkPackagedProgram } from './packaged-test-helpers.mjs'

const project = path.resolve(import.meta.dirname, '..')
fs.mkdirSync(path.join(project, 'dist/qa'), { recursive: true })
const staging = fs.mkdtempSync(path.join(project, 'dist', '.session-restart-'))
const root = path.join(staging, 'JobTrail'),
  runtime = path.join(root, '.runtime/current')
linkPackagedProgram(path.join(project, 'dist/win-unpacked'), runtime)
fs.copyFileSync(
  path.join(project, 'native/bootstrap/target/debug/launcher.exe'),
  path.join(root, 'JobTrail.exe'),
)
const env = { ...process.env, APPDATA: staging }
delete env.ELECTRON_RUN_AS_NODE
const launch = () =>
  electron.launch({
    executablePath: path.join(runtime, 'zhiji.exe'),
    args: [`--user-data-dir=${path.join(staging, 'chromium')}`],
    env,
  })
let app = await launch()
async function quit() {
  const closed = app.waitForEvent('close', { timeout: 30000 })
  await app.evaluate(({ app }) => {
    setTimeout(() => app.quit(), 0)
  })
  await closed
}
const report = {
  at: new Date().toISOString(),
  evidence: 'synthetic fixture; no user accounts or live sign-in',
  restarts: [],
}
try {
  let page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  await page.locator('.sidebar').waitFor()
  await page.waitForLoadState('load')
  await page.waitForFunction(() => !!window.zhijiApi?.discovery)
  const initial = await page.evaluate(() => window.zhijiApi.discovery.status())
  const confirmedAt = Date.now() - 10000
  // Seed only our isolated installation with the state produced by a confirmed
  // QR callback. Synthetic persistence sentinels are never sent to a website.
  await app.evaluate(
    async ({ app, session }, { root, initial, confirmedAt }) => {
      const require = process
        .getBuiltinModule('module')
        .createRequire(app.getAppPath() + '/package.json')
      const Database = require('better-sqlite3'),
        db = new Database(root + '/data/zhiji.db')
      for (const old of initial) {
        const value = {
          ...old,
          state: 'authenticated',
          checkedAt: confirmedAt,
          evidence: 'official_qr_login_confirmed',
          limitations: [],
        }
        db.prepare(
          'INSERT INTO discovery_platforms VALUES(?,?) ON CONFLICT(platform) DO UPDATE SET payload=excluded.payload',
        ).run(old.platform, JSON.stringify(value))
        const s = session.fromPath(root + '/browser-sessions/' + old.platform, { cache: true })
        await s.cookies.set({
          url: 'https://session-test.invalid/',
          name: 'restart-sentinel',
          value: 'synthetic',
          expirationDate: Date.now() / 1000 + 3600,
        })
        await s.cookies.flushStore()
      }
      db.close()
    },
    { root, initial, confirmedAt },
  )
  for (let round = 1; round <= 2; round++) {
    await quit()
    app = await launch()
    page = await app.firstWindow()
    page.setDefaultTimeout(15000)
    await page.locator('.sidebar').waitFor()
    await page.waitForLoadState('load')
    await page.waitForFunction(() => !!window.zhijiApi?.discovery)
    const statuses = await page.evaluate(() => window.zhijiApi.discovery.status())
    for (const item of statuses) {
      assert.equal(item.state, 'authenticated')
      assert.equal(item.checkedAt, confirmedAt)
      assert.equal(item.evidence, 'official_qr_login_confirmed')
      assert.deepEqual(item.limitations, ['session_recheck_required'])
    }
    const sessions = await app.evaluate(
      async ({ session }, { root, platforms }) => {
        const result = []
        for (const p of platforms) {
          const s = session.fromPath(root + '/browser-sessions/' + p, { cache: true })
          result.push({
            platform: p,
            retained:
              (
                await s.cookies.get({
                  url: 'https://session-test.invalid/',
                  name: 'restart-sentinel',
                })
              ).length === 1,
          })
        }
        return result
      },
      { root, platforms: initial.map((s) => s.platform) },
    )
    assert.ok(sessions.every((s) => s.retained))
    await page.locator('.sidebar').getByText('岗位发现', { exact: true }).click()
    await page.getByRole('button', { name: '账号管理', exact: true }).click()
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('.discovery-account .n-tag')].filter(
          (e) => e.textContent.trim() === '已登录',
        ).length === 6,
    )
    assert.equal(
      await page.locator('.discovery-account').getByText('尚未确认', { exact: true }).count(),
      0,
    )
    assert.equal(await page.getByRole('button', { name: '重新检查登录', exact: true }).count(), 0)
    report.restarts.push({
      round,
      states: statuses.map((s) => ({ platform: s.platform, state: s.state })),
      sessions,
    })
    console.log(`Restart ${round}: six confirmed states and six local sessions retained`)
  }
  await page.screenshot({
    path: path.join(project, 'dist/qa/session-restart.png'),
    animations: 'disabled',
  })
  report.passed = true
  console.log(JSON.stringify(report, null, 2))
} finally {
  fs.writeFileSync(
    path.join(project, 'dist/qa/session-restart.json'),
    JSON.stringify(report, null, 2),
  )
  await app.close()
}
