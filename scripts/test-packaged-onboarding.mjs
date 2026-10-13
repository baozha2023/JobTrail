import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { _electron as electron } from 'playwright'
import { linkPackagedProgram, waitFor } from './packaged-test-helpers.mjs'

const project = path.resolve(import.meta.dirname, '..')
const staging = fs.mkdtempSync(path.join(project, 'dist', '.onboarding-'))
const root = path.join(staging, 'JobTrail')
const runtime = path.join(root, '.runtime/current')
const output = path.join(project, 'dist/qa')
fs.mkdirSync(output, { recursive: true })
linkPackagedProgram(path.join(project, 'dist/win-unpacked'), runtime)
fs.copyFileSync(
  path.join(project, 'native/bootstrap/target/debug/launcher.exe'),
  path.join(root, 'JobTrail.exe'),
)
const env = { ...process.env, APPDATA: staging, LOCALAPPDATA: staging }
delete env.ELECTRON_RUN_AS_NODE
let app
let page
const errors = []
async function screenshot(name) {
  const win = await app.browserWindow(page)
  await win.evaluate(
    async (win, file) => {
      const capture = await win.webContents.capturePage()
      process.getBuiltinModule('fs').writeFileSync(file, capture.toPNG())
    },
    path.join(output, name),
  )
}
async function launch() {
  app = await electron.launch({
    executablePath: path.join(runtime, 'zhiji.exe'),
    args: [`--user-data-dir=${path.join(staging, 'chromium')}`],
    env,
  })
  page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  page.on('pageerror', (error) => errors.push(error.message))
  await page.locator('.sidebar').waitFor()
  await page.waitForFunction(() => !document.querySelector('.n-spin-body'))
  assert.equal(await page.locator('.n-message--error').count(), 0)
}
const popover = () => page.locator('.jobtrail-tour')
async function at(target, count) {
  await page.locator(`[data-tour="${target}"].driver-active-element`).waitFor()
  await waitFor(
    () => popover().locator('.driver-popover-next-btn').isEnabled(),
    'tour transition saved',
  )
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  )
  assert.equal(await popover().locator('.driver-popover-progress-text').innerText(), count)
  const box = await popover().boundingBox()
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  assert.ok(
    box &&
      box.x >= 0 &&
      box.y >= 0 &&
      box.x + box.width <= viewport.width + 1 &&
      box.y + box.height <= viewport.height + 1,
    `Popover fits at ${target}`,
  )
  assert.equal(
    await popover().evaluate((element) => {
      const style = getComputedStyle(element)
      return (
        ['auto', 'scroll'].includes(style.overflowX) && element.scrollWidth > element.clientWidth
      )
    }),
    false,
    'No horizontal card scrollbar',
  )
  assert.equal(await page.locator('.n-message--error').count(), 0, `No error at ${target}`)
}
async function next() {
  await popover().locator('.driver-popover-next-btn').click()
}
async function skip() {
  await popover().locator('.driver-popover-close-btn').click()
  await popover().waitFor({ state: 'hidden' })
}
async function verifyNativePage() {
  const win = await app.browserWindow(page)
  await win.evaluate((win) => {
    win.setSize(1280, 900)
    win.webContents.setZoomFactor(1)
  })
  await page.evaluate(() => window.zhijiApi.config.update({ locale: 'zh-CN', themeMode: 'light' }))
  await page.reload()
  const platform = (await page.evaluate(() => window.zhijiApi.discovery.status())).find(
    (item) => item.platform === 'boss',
  )
  // Synthetic data and an isolated HTTPS protocol handler exercise the actual native view.
  // The production tour never creates jobs or accesses recruitment websites.
  const jobUrl = await app.evaluate(
    ({ app }, { root, platform }) => {
      const module = process
        .getBuiltinModule('module')
        .createRequire(app.getAppPath() + '/package.json')
      const Database = module('better-sqlite3')
      const crypto = process.getBuiltinModule('crypto')
      const db = new Database(root + '/data/zhiji.db')
      const now = Date.now(),
        runId = crypto.randomUUID(),
        requestId = crypto.randomUUID()
      const externalId = 'onboarding-fixture'
      const jobId = crypto
        .createHash('sha256')
        .update('boss:' + externalId)
        .digest('hex')
      const url = 'https://www.zhipin.com/job_detail/' + externalId + '.html'
      const observation = {
        platform: 'boss',
        externalId,
        url,
        title: '本地引导验收岗位',
        company: '合成公司',
        city: '上海',
        salary: '10-20K',
        salaryMin: 10000,
        salaryMax: 20000,
        experience: '',
        education: '',
        recruitment: '',
        employment: '',
        jd: '本地原生网页展示验收',
        detailRead: true,
        readAt: now,
        detailReadAt: now,
        missing: {},
      }
      try {
        db.transaction(() => {
          db.prepare('UPDATE discovery_platforms SET payload=? WHERE platform=?').run(
            JSON.stringify({
              ...platform,
              state: 'authenticated',
              checkedAt: now,
              evidence: 'official_qr_login_confirmed',
              limitations: [],
            }),
            'boss',
          )
          db.prepare('INSERT INTO discovery_runs VALUES(?,?,?,?,?,?)').run(
            runId,
            requestId,
            JSON.stringify({ keyword: '本地引导验收岗位', city: '', platforms: ['boss'] }),
            'completed',
            now,
            now,
          )
          db.prepare('INSERT INTO discovery_requests VALUES(?,?)').run(requestId, runId)
          db.prepare(
            'INSERT INTO discovery_sources VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          ).run(
            runId,
            'boss',
            'completed',
            1,
            1,
            1,
            1,
            1,
            ...Array(8).fill(0),
            null,
            JSON.stringify({ keyword: '本地引导验收岗位', city: '', cityCode: '' }),
            '',
            null,
          )
          const observationId = db
            .prepare('INSERT INTO discovery_observations(job_id,payload,observed_at) VALUES(?,?,?)')
            .run(jobId, JSON.stringify(observation), now).lastInsertRowid
          db.prepare('INSERT INTO discovery_jobs VALUES(?,?,?,?,?,?,?)').run(
            jobId,
            'boss',
            externalId,
            url,
            now,
            observationId,
            null,
          )
          db.prepare('INSERT INTO discovery_results VALUES(?,?,?,?)').run(
            runId,
            jobId,
            observationId,
            0,
          )
        })()
      } finally {
        db.close()
      }
      const sessions = new WeakSet()
      app.on('web-contents-created', (_event, wc) => {
        if (sessions.has(wc.session)) return
        sessions.add(wc.session)
        wc.session.protocol.handle(
          'https',
          () =>
            new Response(
              '<!doctype html><html><body style="background:#dff1ff"><a href="/web/geek/chat">本地合成账号</a><h1>本地原生岗位网页</h1><p>此页面没有访问招聘网站。</p></body></html>',
              { headers: { 'content-type': 'text/html; charset=utf-8' } },
            ),
        )
      })
      return url
    },
    { root, platform },
  )
  await page.locator('.sidebar').getByText('岗位发现', { exact: true }).click()
  await page.getByRole('button', { name: '搜索历史', exact: true }).click()
  await page.getByRole('button', { name: '查看', exact: true }).click()
  await page.locator('.discovery-job').click()
  await page.locator('.discovery-detail-actions button').first().click()
  const nativeState = () =>
    win.evaluate((win, url) => {
      const view = win.contentView.children.find((child) => child.webContents?.getURL() === url)
      return view ? { visible: view.getVisible(), id: view.webContents.id } : null
    }, jobUrl)
  await waitFor(async () => (await nativeState())?.visible, 'visible native job page')
  const original = await nativeState()
  await page.locator('.sidebar').getByText('设置', { exact: true }).click()
  await page.getByRole('button', { name: '重新开始岗位发现引导', exact: true }).click()
  await at('discovery-accounts', '1 / 12')
  assert.deepEqual(await nativeState(), { id: original.id, visible: false })
  for (const [index, step] of [
    'account-list',
    'qr-panel',
    'platforms',
    'keyword',
    'city',
    'salary',
    'search',
    'results',
    'details',
  ].entries()) {
    await next()
    await at(`discovery-${step}`, `${index + 2} / 12`)
    assert.deepEqual(await nativeState(), { id: original.id, visible: false })
  }
  await screenshot('onboarding-native-hidden.png')
  await skip()
  await waitFor(async () => (await nativeState())?.visible, 'native job page restored')
  assert.deepEqual(await nativeState(), original)
  assert.equal((await page.evaluate(() => window.zhijiApi.discovery.history(1))).total, 1)
}
try {
  await launch()
  await at('app-opportunities', '1 / 9')
  assert.equal(await popover().locator('.driver-popover-prev-btn').isDisabled(), true)
  await screenshot('onboarding-app-light.png')
  await next()
  await at('app-calendar', '2 / 9')
  assert.equal(await page.locator('.page-header h1').innerText(), '求职记录')
  await app.close()
  await launch()
  await at('app-calendar', '2 / 9')
  await skip()
  await page.locator('.sidebar').getByText('岗位发现', { exact: true }).click()
  await at('discovery-accounts', '1 / 12')
  await next()
  await at('discovery-account-list', '2 / 12')
  await next()
  await at('discovery-qr-panel', '3 / 12')
  assert.equal(await page.locator('.discovery-qr-image').count(), 0)
  assert.equal(await page.locator('.discovery-login-success').count(), 0)
  await screenshot('onboarding-accounts-light.png')
  await app.close()
  await launch()
  assert.equal(await page.locator('.page-header h1').innerText(), '求职记录')
  assert.equal(await popover().count(), 0)
  await page.locator('.sidebar').getByText('岗位发现', { exact: true }).click()
  await at('discovery-qr-panel', '3 / 12')
  await popover().locator('.driver-popover-prev-btn').click()
  await at('discovery-account-list', '2 / 12')
  await next()
  await at('discovery-qr-panel', '3 / 12')
  for (const [index, step] of [
    'platforms',
    'keyword',
    'city',
    'salary',
    'search',
    'results',
    'details',
    'new-search',
    'history',
  ].entries()) {
    await next()
    await at(`discovery-${step}`, `${index + 4} / 12`)
    if (step === 'details') {
      const win = await app.browserWindow(page)
      await win.evaluate((win) => {
        win.setSize(1050, 800)
        win.webContents.setZoomFactor(1.25)
      })
      await waitFor(async () => {
        const { size, zoom } = await win.evaluate((win) => ({
          size: win.getContentSize(),
          zoom: win.webContents.getZoomFactor(),
        }))
        const viewport = await page.evaluate(() => [innerWidth, innerHeight])
        return (
          Math.abs(zoom - 1.25) < 0.000001 &&
          Math.abs(viewport[0] - size[0] / zoom) < 2 &&
          Math.abs(viewport[1] - size[1] / zoom) < 2
        )
      }, 'narrow viewport and zoom settled')
      await at('discovery-details', '10 / 12')
      await screenshot('onboarding-details-zoom.png')
    }
  }
  await next()
  await popover().waitFor({ state: 'hidden' })
  assert.deepEqual((await page.evaluate(() => window.zhijiApi.config.get())).onboarding, {
    app: { status: 'skipped', stepId: null },
    discovery: { status: 'completed', stepId: null },
  })
  assert.equal(await page.locator('.discovery-filters').count(), 0)
  assert.equal(await page.locator('.discovery-job').count(), 0)
  assert.equal((await page.evaluate(() => window.zhijiApi.discovery.history(1))).total, 0)
  await page.evaluate(() => window.zhijiApi.config.update({ themeMode: 'dark', locale: 'en-US' }))
  await page.reload()
  await page.locator('.sidebar').getByText('Settings', { exact: true }).click()
  await page.getByRole('button', { name: 'Restart the app tour', exact: true }).click()
  await at('app-opportunities', '1 / 9')
  assert.equal(await popover().evaluate((node) => node.classList.contains('is-dark')), true)
  assert.equal(await popover().locator('.driver-popover-close-btn').innerText(), 'Skip')
  await screenshot('onboarding-app-dark-en.png')
  await page.keyboard.press('Tab')
  assert.equal(await page.evaluate(() => !!document.activeElement.closest('.jobtrail-tour')), true)
  await page.keyboard.press('Escape')
  await popover().waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: 'Restart the discovery tour', exact: true }).click()
  await at('discovery-accounts', '1 / 12')
  await next()
  await at('discovery-account-list', '2 / 12')
  await screenshot('onboarding-accounts-dark-en.png')
  await skip()
  await verifyNativePage()
  assert.deepEqual(errors, [])
  assert.equal(await page.locator('.n-message--error').count(), 0)
  console.log(
    'PASS: packaged tours, resume, independent progress, modal navigation, empty/offline discovery, theme, language, zoom, focus, restart and native page hide/restore',
  )
} catch (error) {
  await screenshot('onboarding-failure.png').catch(() => {})
  throw error
} finally {
  await app?.close()
}
