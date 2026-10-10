import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { _electron as electron } from 'playwright'
import { linkPackagedProgram, waitFor } from './packaged-test-helpers.mjs'

const project = path.resolve(import.meta.dirname, '..')
fs.mkdirSync(path.join(project, 'dist/qa'), { recursive: true })
const staging = fs.mkdtempSync(path.join(project, 'dist', '.discovery-dialogs-'))
const root = path.join(staging, 'JobTrail'),
  runtime = path.join(root, '.runtime/current')
linkPackagedProgram(path.join(project, 'dist/win-unpacked'), runtime)
fs.copyFileSync(
  path.join(project, 'native/bootstrap/target/debug/launcher.exe'),
  path.join(root, 'JobTrail.exe'),
)
const env = { ...process.env, APPDATA: staging }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({
  executablePath: path.join(runtime, 'zhiji.exe'),
  args: [`--user-data-dir=${path.join(staging, 'chromium')}`],
  env,
})
try {
  const page = await app.firstWindow()
  const mainWindow = await app.browserWindow(page)
  async function resizeWindow(width, height, zoom = 1) {
    let geometry
    async function readWindowState() {
      geometry = await mainWindow.evaluate((win) => ({
        size: win.getContentSize(),
        outer: win.getSize(),
        zoom: win.webContents.getZoomFactor(),
        minimized: win.isMinimized(),
        maximized: win.isMaximized(),
        visible: win.isVisible(),
      }))
      return geometry
    }
    try {
      await mainWindow.evaluate((win) => {
        if (win.isMinimized()) win.restore()
        if (!win.isVisible()) win.showInactive()
      })
      await waitFor(async () => {
        const { minimized, maximized, visible, size } = await readWindowState()
        if (minimized || !visible) return false
        // Restoring a minimized window can return it to its maximized state.
        if (maximized) {
          await mainWindow.evaluate((win) => win.unmaximize())
          return false
        }
        return size[0] > 0 && size[1] > 0
      }, 'visible normal window')
      await mainWindow.evaluate(
        (win, { width, height, zoom }) => {
          win.setSize(width, height)
          win.webContents.setZoomFactor(zoom)
        },
        { width, height, zoom },
      )
      // Native resize and renderer zoom can settle after evaluate returns.
      await waitFor(async () => {
        const {
          size,
          outer,
          zoom: actualZoom,
          minimized,
          maximized,
          visible,
        } = await readWindowState()
        const viewport = await page.evaluate(() => [innerWidth, innerHeight])
        geometry.viewport = viewport
        return (
          !minimized &&
          !maximized &&
          visible &&
          size[0] > 0 &&
          size[1] > 0 &&
          Math.abs(actualZoom - zoom) < 0.000001 &&
          // Non-integer Windows display scaling can round native bounds by two DIP.
          Math.abs(outer[0] - width) <= 2 &&
          Math.abs(outer[1] - height) <= 2 &&
          Math.abs(viewport[0] - size[0] / zoom) < 2 &&
          Math.abs(viewport[1] - size[1] / zoom) < 2
        )
      }, 'resized and zoomed viewport')
    } catch (cause) {
      throw new Error(
        `Viewport mismatch: ${JSON.stringify({ expected: { width, height, zoom }, actual: geometry })}`,
        { cause },
      )
    }
  }
  async function screenshot(name) {
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    )
    await mainWindow.evaluate(
      async (win, file) => {
        const image = await win.webContents.capturePage()
        process.getBuiltinModule('fs').writeFileSync(file, image.toPNG())
      },
      path.join(project, 'dist/qa', name),
    )
  }
  page.setDefaultTimeout(15000)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.locator('.sidebar').getByText('岗位发现', { exact: true }).click()
  const checks = page.locator('.discovery-platforms').getByRole('checkbox')
  assert.equal(await checks.count(), 6)
  for (const check of await checks.all()) {
    assert.equal(await check.isDisabled(), true)
    assert.equal(await check.isChecked(), false)
  }
  const buttons = page.locator('.discovery-search-buttons')
  const newSearch = page
    .locator('.page-header')
    .getByRole('button', { name: '新搜索', exact: true })
  assert.equal(await newSearch.count(), 1)
  const search = buttons.getByRole('button', { name: '搜索岗位', exact: true })
  assert.equal(await search.isDisabled(), true)
  await page.getByPlaceholder('关键词', { exact: true }).fill('Java')
  await page.getByPlaceholder('关键词', { exact: true }).press('Enter')
  assert.equal((await page.evaluate(() => window.zhijiApi.discovery.history(1))).total, 0)
  const initial = await page.evaluate(() => window.zhijiApi.discovery.status())
  async function signIn(platforms) {
    await app.evaluate(
      ({ app }, { root, initial, platforms }) => {
        const require = process
          .getBuiltinModule('module')
          .createRequire(app.getAppPath() + '/package.json')
        const Database = require('better-sqlite3')
        const db = new Database(root + '/data/zhiji.db')
        try {
          db.transaction(() => {
            for (const old of initial) {
              const logged = platforms.includes(old.platform)
              const value = {
                ...old,
                state: logged ? 'authenticated' : 'unknown',
                checkedAt: logged ? Date.now() : null,
                evidence: logged ? 'official_qr_login_confirmed' : '',
                limitations: [],
              }
              db.prepare(
                'INSERT INTO discovery_platforms VALUES(?,?) ON CONFLICT(platform) DO UPDATE SET payload=excluded.payload',
              ).run(old.platform, JSON.stringify(value))
            }
          })()
        } finally {
          db.close()
        }
      },
      { root, initial, platforms },
    )
  }
  async function expectPlatforms(enabled, selected) {
    await page.waitForFunction(
      ({ enabled, selected }) => {
        const controls = [...document.querySelectorAll('.discovery-platforms [role="checkbox"]')]
        return (
          controls.length === 6 &&
          controls.every(
            (control, i) =>
              (control.getAttribute('aria-checked') === 'true') === selected.includes(i) &&
              (control.getAttribute('aria-disabled') === 'true') === !enabled.includes(i),
          )
        )
      },
      { enabled, selected },
    )
  }
  // Synthetic login confirmations only; no account materials or website requests.
  await signIn(['boss', 'zhilian'])
  await expectPlatforms([0, 2], [0, 2])
  await checks.nth(1).dispatchEvent('click')
  assert.equal(await checks.nth(1).isChecked(), false)
  assert.equal(await search.isEnabled(), true)
  await checks.nth(0).uncheck()
  await signIn(['boss', 'liepin', 'zhilian'])
  await expectPlatforms([0, 1, 2], [1, 2])
  await page.evaluate(() =>
    window.zhijiApi.discovery.browser({ action: 'clear', platform: 'zhilian' }),
  )
  await expectPlatforms([0, 1], [1])
  await signIn([])
  await expectPlatforms([], [])
  const location = page.locator('.discovery-search .n-select')
  assert.equal(
    await location.locator('.n-base-selection-placeholder').innerText(),
    '请先选择招聘网站',
  )
  await signIn(['boss'])
  await expectPlatforms([0], [0])
  assert.equal(await location.locator('.n-base-selection-placeholder').innerText(), '地点')
  await location.click()
  await page.locator('.n-base-select-option').filter({ hasText: '上海' }).click()
  assert.ok((await location.innerText()).includes('上海'))
  await page.locator('.sidebar').getByText('设置', { exact: true }).click()
  await page
    .locator('.settings-field')
    .filter({ has: page.getByText('语言', { exact: true }) })
    .locator('.n-select')
    .click()
  await page.locator('.n-base-select-option').filter({ hasText: 'English' }).click()
  await page.locator('.sidebar').getByText('Job discovery', { exact: true }).click()
  await waitFor(async () => (await location.innerText()).includes('Shanghai'), 'English city label')
  await location.click()
  await location.locator('input').fill('北京')
  await page.locator('.n-base-select-option').filter({ hasText: 'Beijing' }).click()
  assert.ok((await location.innerText()).includes('Beijing'))
  await page.locator('.sidebar').getByText('Settings', { exact: true }).click()
  await page
    .locator('.settings-field')
    .filter({ has: page.getByText('Language', { exact: true }) })
    .locator('.n-select')
    .click()
  await page.locator('.n-base-select-option').filter({ hasText: '简体中文' }).click()
  await page.locator('.sidebar').getByText('岗位发现', { exact: true }).click()
  await waitFor(async () => (await location.innerText()).includes('北京'), 'Chinese city label')
  await location.click()
  await location.locator('input').fill('SHANGHAI')
  await page.locator('.n-base-select-option').filter({ hasText: '上海' }).click()
  await signIn(['boss', 'liepin'])
  await expectPlatforms([0, 1], [0, 1])
  assert.equal(await location.locator('.n-base-selection-placeholder').innerText(), '地点')
  await location.click()
  await page.locator('.n-base-select-option').filter({ hasText: '上海' }).click()
  await location.hover()
  await location.locator('.n-base-clear').click()
  await location.locator('.n-base-selection-placeholder').waitFor()
  assert.equal(await location.locator('.n-base-selection-placeholder').innerText(), '地点')
  await location.click()
  assert.equal(await page.locator('.n-base-select-option').filter({ hasText: '全国' }).count(), 0)
  await page.keyboard.press('Escape')
  await signIn([])
  await expectPlatforms([], [])
  assert.equal(
    await page
      .locator('.page-header')
      .getByRole('button', { name: '账号管理', exact: true })
      .count(),
    1,
  )
  assert.equal(
    await page
      .locator('.page-header')
      .getByRole('button', { name: '搜索历史', exact: true })
      .count(),
    1,
  )
  await page.getByRole('button', { name: '薪资筛选', exact: true }).click()
  assert.equal(await page.locator('.discovery-filters input').count(), 2)
  assert.equal(await page.getByPlaceholder('公司关键词', { exact: true }).count(), 0)
  // Only seed this fresh test installation; no requests to recruitment sites are needed.
  await app.evaluate(({ app }, root) => {
    const require = process
      .getBuiltinModule('module')
      .createRequire(app.getAppPath() + '/package.json')
    const Database = require('better-sqlite3'),
      db = new Database(root + '/data/zhiji.db')
    const query = {
      keyword: 'Java',
      city: '上海',
      platforms: ['boss', 'liepin', 'zhilian', 'wuyou'],
    }
    db.transaction(() => {
      for (let i = 0; i < 25; i++) {
        const id = crypto.randomUUID(),
          state = i >= 23 ? 'running' : 'completed',
          requestId = crypto.randomUUID(),
          at = Date.now() + i
        db.prepare('INSERT INTO discovery_runs VALUES(?,?,?,?,?,?)').run(
          id,
          requestId,
          JSON.stringify({ ...query, keyword: '测试岗位 ' + i }),
          state,
          at,
          at,
        )
        db.prepare('INSERT INTO discovery_requests VALUES(?,?)').run(requestId, id)
        for (const platform of query.platforms)
          db.prepare(
            'INSERT INTO discovery_sources VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          ).run(
            id,
            platform,
            state,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            null,
            JSON.stringify({ keyword: '测试岗位 ' + i, city: '', cityCode: '' }),
            '',
            null,
          )
      }
    })()
    db.close()
  }, root)
  await page.getByRole('button', { name: '搜索历史', exact: true }).click()
  await page
    .locator('.discovery-history-row')
    .filter({ hasText: '测试岗位 23' })
    .getByRole('button', { name: '查看', exact: true })
    .click()
  await page.locator('.discovery-history').waitFor({ state: 'hidden' })
  await expectPlatforms([], [0, 1, 2, 3])
  assert.equal(await page.getByPlaceholder('关键词', { exact: true }).isDisabled(), true)
  for (const input of await page.locator('.discovery-filters input').all())
    assert.equal(await input.isDisabled(), true)
  const cancel = buttons.getByRole('button', { name: '取消搜索', exact: true })
  await cancel.waitFor()
  assert.equal(await cancel.isEnabled(), true, 'An active search remains cancellable after logout')
  assert.equal(await page.locator('.discovery-actions').count(), 0)
  assert.equal(await cancel.locator('.n-spin svg circle').count(), 1)
  const animations = await cancel
    .locator('animateTransform')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('repeatCount')))
  assert.ok(animations.length > 0 && animations.every((value) => value === 'indefinite'))
  await waitFor(async () => {
    const icon = await cancel.locator('.n-spin').boundingBox()
    const label = await cancel.locator('.n-button__content').boundingBox()
    return icon && label && icon.x < label.x
  }, 'cancel button icon transition')
  const icon = await cancel.locator('.n-spin').boundingBox()
  const label = await cancel.locator('.n-button__content').boundingBox()
  assert.ok(icon.x < label.x)
  const colors = await cancel.evaluate((button) => ({
    button: getComputedStyle(button).color,
    spin: getComputedStyle(button.querySelector('svg')).color,
  }))
  assert.equal(colors.spin, colors.button)
  await screenshot('search-button-running.png')
  await cancel.click()
  await search.waitFor()
  assert.equal(await buttons.locator('.n-spin').count(), 0)
  const history = await page.evaluate(() => window.zhijiApi.discovery.history(1))
  assert.equal(history.items.find((run) => run.query.keyword === '测试岗位 23').state, 'cancelled')
  assert.equal(await page.getByPlaceholder('关键词', { exact: true }).isDisabled(), true)
  await newSearch.click()
  await page.waitForFunction(() => {
    const input = document.querySelector('.discovery-search input')
    return input && !input.disabled && input.value === ''
  })
  assert.equal(await page.locator('.discovery-filters').count(), 0)
  assert.equal(await page.locator('.discovery-job').count(), 0)
  await expectPlatforms([], [])
  assert.equal(
    (await page.evaluate(() => window.zhijiApi.discovery.history(1))).total,
    history.total,
  )
  async function dimensions(selector) {
    await page.waitForFunction((selector) => {
      const rect = document.querySelector(selector)?.getBoundingClientRect()
      return (
        rect &&
        Math.abs(rect.width / innerWidth - 0.7) < 0.015 &&
        Math.abs(rect.height / innerHeight - 0.8) < 0.015
      )
    }, selector)
    const result = await page.locator(selector).evaluate((e) => ({
      w: e.getBoundingClientRect().width,
      h: e.getBoundingClientRect().height,
      vw: innerWidth,
      vh: innerHeight,
    }))
    assert.ok(Math.abs(result.w / result.vw - 0.7) < 0.015, JSON.stringify(result))
    assert.ok(Math.abs(result.h / result.vh - 0.8) < 0.015, JSON.stringify(result))
  }
  await page.getByRole('button', { name: '账号管理', exact: true }).click()
  await dimensions('.discovery-accounts')
  assert.equal(await page.getByRole('button', { name: '重新检查登录', exact: true }).count(), 0)
  const rects = await page.locator('.discovery-account').evaluateAll((es) =>
    es.map((e) => {
      const r = e.getBoundingClientRect()
      return { x: r.x, y: r.y, right: r.right }
    }),
  )
  assert.equal(rects.length, 6)
  assert.equal(rects[0].y, rects[1].y)
  assert.equal(rects[2].y, rects[3].y)
  assert.equal(rects[4].y, rects[5].y)
  assert.equal(rects[0].x, rects[2].x)
  assert.equal(rects[0].x, rects[4].x)
  assert.ok(
    (await page.locator('.discovery-qr-panel').evaluate((e) => e.getBoundingClientRect().x)) >
      rects[1].right,
  )
  await screenshot('discovery-accounts.png')
  assert.equal(await page.locator('.n-message--error').count(), 0)
  const originalBounds = await mainWindow.evaluate((w) => w.getNormalBounds())
  await resizeWindow(800, 650)
  await dimensions('.discovery-accounts')
  await screenshot('discovery-accounts-narrow.png')
  await mainWindow.evaluate((w, bounds) => w.setBounds(bounds), originalBounds)
  await page
    .locator('.discovery-accounts')
    .getByRole('button', { name: '关闭', exact: true })
    .click()
  await page.getByRole('button', { name: '搜索历史', exact: true }).click()
  await dimensions('.discovery-history')
  assert.ok(
    await page
      .locator('.discovery-history')
      .evaluate(
        (e) =>
          e.querySelector('.discovery-history-footer').getBoundingClientRect().bottom <=
          e.getBoundingClientRect().bottom,
      ),
    'History footer must stay inside its fixed dialog',
  )
  await page.locator('.discovery-history-row').first().waitFor()
  assert.equal(await page.locator('.discovery-history-row').count(), 20)
  assert.deepEqual(
    await page.locator('.discovery-history-heading .n-tag').allTextContents(),
    Array(20).fill('上海'),
  )
  for (const text of await page.locator('.discovery-history-sources').allTextContents()) {
    assert.doesNotMatch(text, /排队中|搜索中|完成|已取消|已中断/)
    for (const name of ['BOSS 直聘', '猎聘', '智联招聘', '前程无忧'])
      assert.ok(text.includes(name + ' · 0'))
  }
  await screenshot('discovery-history.png')
  await page
    .locator('.discovery-history-row')
    .filter({ hasText: '测试岗位 24' })
    .getByRole('button', { name: '取消搜索', exact: true })
    .click()
  await page
    .locator('.discovery-history-row')
    .filter({ hasText: '测试岗位 24' })
    .getByRole('button', { name: '删除', exact: true })
    .waitFor()
  await page
    .locator('.discovery-history-row')
    .first()
    .getByRole('button', { name: '删除', exact: true })
    .click()
  const freeze = path.join(root, '.runtime/state/update-freeze')
  fs.writeFileSync(freeze, '')
  try {
    await page
      .locator('.n-dialog')
      .getByRole('button', { name: '清理所选历史', exact: true })
      .click()
    await page.locator('.n-dialog .n-alert').waitFor({ state: 'visible' })
    assert.equal((await page.evaluate(() => window.zhijiApi.discovery.history(1))).total, 25)
  } finally {
    fs.unlinkSync(freeze)
  }
  await page.locator('.n-dialog').getByRole('button', { name: '清理所选历史', exact: true }).click()
  await waitFor(
    async () => (await page.evaluate(() => window.zhijiApi.discovery.history(1))).total === 24,
    'history deletion',
  )
  await page
    .locator('.discovery-history .n-pagination-item')
    .getByText('2', { exact: true })
    .click()
  await page.waitForFunction(() => document.querySelectorAll('.discovery-history-row').length === 4)
  // Exercise the original bug with the reactive checkbox selection crossing real IPC.
  await page.getByText('选择本页', { exact: true }).click()
  await page.getByRole('button', { name: '清理所选历史', exact: true }).click()
  await page.locator('.n-dialog').getByRole('button', { name: '清理所选历史', exact: true }).click()
  await waitFor(
    async () => (await page.evaluate(() => window.zhijiApi.discovery.history(1))).total === 20,
    'selected history deletion',
  )
  await page.waitForFunction(
    () => document.querySelectorAll('.discovery-history-row').length === 20,
  )
  await page.getByText('选择本页', { exact: true }).click()
  await page.getByRole('button', { name: '清理所选历史', exact: true }).click()
  await page.locator('.n-dialog').getByRole('button', { name: '清理所选历史', exact: true }).click()
  await page.getByText('暂无搜索历史', { exact: true }).waitFor()
  assert.equal((await page.evaluate(() => window.zhijiApi.discovery.history(1))).total, 0)
  await page.locator('.discovery-history .n-card-header__close').click()
  // Isolated official-origin fixtures exercise native window + IPC without contacting a site.
  await signIn(['boss', 'liepin'])
  const verificationRun = await app.evaluate(({ app }, root) => {
    const fixtureSessions = new WeakSet()
    app.on('web-contents-created', (_event, wc) => {
      const session = wc.session
      if (fixtureSessions.has(session)) return
      fixtureSessions.add(session)
      session.protocol.handle('https', (request) => {
        const pathname = new URL(request.url).pathname
        // QR responses use the same session and real IPC/UI path as account management.
        if (pathname.startsWith('/wapi/zppassport/')) {
          const value = pathname.endsWith('/captcha/randkey')
            ? { code: 0, zpData: { shortRandKey: 'dialog-fixture' } }
            : pathname.endsWith('/qrcode/getMpCode')
              ? {
                  code: 0,
                  zpData: {
                    mpCodeUrl:
                      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jrAAAAABJRU5ErkJggg==',
                  },
                }
              : { code: 0, scaned: false }
          return new Response(JSON.stringify(value), {
            headers: { 'content-type': 'application/json' },
          })
        }
        return new Response(
          '<!doctype html><html><head><title>安全验证</title></head><body style="background:#e5f2ff"><h1>安全验证</h1><p>本地合成验证页面</p><div style="position:fixed;left:20px;top:200px;width:160px;height:160px;background:#cf2f4f"></div></body></html>',
          { headers: { 'content-type': 'text/html; charset=utf-8' } },
        )
      })
    })
    const require = process
      .getBuiltinModule('module')
      .createRequire(app.getAppPath() + '/package.json')
    const Database = require('better-sqlite3')
    const db = new Database(root + '/data/zhiji.db')
    const id = crypto.randomUUID(),
      requestId = crypto.randomUUID(),
      at = Date.now()
    const query = { keyword: '验证队列测试', city: '', platforms: ['boss', 'liepin', 'wuyou'] }
    try {
      db.transaction(() => {
        db.prepare('INSERT INTO discovery_runs VALUES(?,?,?,?,?,?)').run(
          id,
          requestId,
          JSON.stringify(query),
          'partial',
          at,
          at,
        )
        db.prepare('INSERT INTO discovery_requests VALUES(?,?)').run(requestId, id)
        for (const p of query.platforms)
          db.prepare(
            'INSERT INTO discovery_sources VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          ).run(
            id,
            p,
            p === 'wuyou' ? 'parse_error' : 'challenge',
            ...Array(13).fill(0),
            null,
            JSON.stringify({ keyword: query.keyword, city: '', cityCode: '' }),
            '',
            null,
          )
      })()
    } finally {
      db.close()
    }
    return id
  }, root)
  await page.getByRole('button', { name: '搜索历史', exact: true }).click()
  const blockedHistory = page.locator('.discovery-history-row').filter({ hasText: '验证队列测试' })
  await blockedHistory.waitFor()
  assert.equal(await blockedHistory.locator('.discovery-history-heading .n-tag').count(), 0)
  assert.match(
    await blockedHistory.locator('.discovery-history-sources').innerText(),
    /BOSS 直聘 · 0 · 需要网站验证/,
  )
  assert.match(
    await blockedHistory.locator('.discovery-history-sources').innerText(),
    /前程无忧 · 0 · 页面解析未完成/,
  )
  await page
    .locator('.discovery-history-row')
    .getByRole('button', { name: '查看', exact: true })
    .click()
  const warning = page.locator('.discovery-search-buttons .discovery-verification')
  await page.locator('.discovery-history').waitFor({ state: 'hidden' })
  await warning.waitFor()
  assert.equal(await warning.innerText(), 'BOSS 直聘 · 需要网站验证')
  assert.equal(await page.locator('.discovery-verification').count(), 1)
  assert.ok(
    (await page.locator('.discovery-source-warnings').innerText()).includes('页面解析未完成'),
  )
  const filterBounds = await buttons
    .getByRole('button', { name: '薪资筛选', exact: true })
    .boundingBox()
  const warningBounds = await warning.boundingBox()
  assert.ok(
    warningBounds.x >= filterBounds.x + filterBounds.width &&
      Math.abs(warningBounds.y - filterBounds.y) < 2,
  )
  await screenshot('verification-queue.png')
  await warning.click()
  await waitFor(
    async () =>
      app.evaluate(({ BrowserWindow, WebContentsView }) =>
        BrowserWindow.getAllWindows().some(
          (win) =>
            win.isVisible() &&
            win.contentView.children.some(
              (v) =>
                v instanceof WebContentsView &&
                v.webContents.getURL() === 'https://www.zhipin.com/',
            ),
        ),
      ),
    'verification window shown',
  )
  const verificationWindow = await app.evaluateHandle(({ BrowserWindow, WebContentsView }) =>
    BrowserWindow.getAllWindows().find(
      (win) =>
        win.isVisible() &&
        win.contentView.children.some(
          (v) =>
            v instanceof WebContentsView && v.webContents.getURL() === 'https://www.zhipin.com/',
        ),
    ),
  )
  const officialContents = await verificationWindow.evaluateHandle(
    (win) =>
      win.contentView.children.find((v) => v.webContents?.getURL() === 'https://www.zhipin.com/')
        .webContents,
  )
  await waitFor(
    async () =>
      officialContents.evaluate((wc) =>
        wc.executeJavaScript('document.body?.innerText.includes("本地合成验证页面")'),
      ),
    'official verification view',
  )
  assert.equal(await officialContents.evaluate((wc) => wc.getURL()), 'https://www.zhipin.com/')
  assert.doesNotMatch(
    await officialContents.evaluate((wc) => wc.getUserAgent()),
    /职迹|JobTrail|zhiji/i,
  )
  const preferences = await officialContents.evaluate((wc) => wc.getLastWebPreferences())
  assert.equal(preferences.nodeIntegration, false)
  assert.equal(preferences.contextIsolation, true)
  assert.equal(preferences.sandbox, true)
  assert.equal(preferences.preload, undefined)
  // Require an attached, visible WebContentsView and actual rendered pixels.
  // BrowserWindow.contentView alone cannot render the official website.
  await waitFor(
    async () =>
      verificationWindow.evaluate(
        async (win, file) => {
          const view = win.contentView.children.find(
            (v) => v.webContents?.getURL() === 'https://www.zhipin.com/',
          )
          if (!win.isVisible() || !view?.getVisible()) return false
          const bounds = view.getBounds(),
            size = win.getContentSize()
          if (bounds.width !== size[0] || bounds.height !== size[1]) return false
          const shot = await view.webContents.capturePage()
          if (shot.isEmpty()) return false
          const pixels = shot.toBitmap()
          let marker = 0
          for (let i = 0; i < pixels.length; i += 4) {
            if (
              Math.abs(pixels[i] - 79) < 8 &&
              Math.abs(pixels[i + 1] - 47) < 8 &&
              Math.abs(pixels[i + 2] - 207) < 8
            )
              marker++
          }
          if (marker < 2000) return false
          process.getBuiltinModule('fs').writeFileSync(file, shot.toPNG())
          return true
        },
        path.join(project, 'dist/qa/verification-native-window.png'),
      ),
    'visible verification pixels',
  )
  console.log('Attached verification view pixels confirmed')
  assert.equal(
    (await page.evaluate(() => window.zhijiApi.discovery.verification({ action: 'get' }))).phase,
    'open',
  )
  await warning.click()
  assert.equal(
    await app.evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().filter((w) =>
          w.contentView.children.some((v) => v.webContents?.getURL() === 'https://www.zhipin.com/'),
        ).length,
    ),
    1,
  )
  // Website scripts may close their page; the native window and warning remain.
  await officialContents.evaluate((wc) => {
    void wc.executeJavaScript('window.close()').catch(() => {})
  })
  await waitFor(
    async () => officialContents.evaluate((wc) => wc.isDestroyed()),
    'website page closure',
  )
  assert.equal(await verificationWindow.evaluate((win) => win.isDestroyed()), false)
  assert.equal(
    (await page.evaluate(() => window.zhijiApi.discovery.verification({ action: 'get' }))).phase,
    'open',
  )
  // Only closing the host triggers a recheck; the synthetic challenge still blocks it.
  await verificationWindow.evaluate((win) => win.close())
  await waitFor(
    async () =>
      !(await page.evaluate(() => window.zhijiApi.discovery.verification({ action: 'get' }))),
    'verification recheck',
    30000,
  )
  assert.equal(
    (await page.evaluate((id) => window.zhijiApi.discovery.run(id), verificationRun)).sources[0]
      .state,
    'challenge',
  )
  assert.equal(await warning.innerText(), 'BOSS 直聘 · 需要网站验证')
  // Queue advancement uses a controlled persisted success fixture; runtime tests verify real batch admission.
  // Main can finish before the renderer's status poll clears the loading button.
  await page.waitForFunction(() => {
    const button = document.querySelector('.discovery-verification')
    return (
      button && !button.classList.contains('n-button--loading') && !button.hasAttribute('disabled')
    )
  })
  await warning.click()
  await waitFor(
    async () =>
      (await page.evaluate(() => window.zhijiApi.discovery.verification({ action: 'get' })))
        ?.phase === 'open',
    'reopened verification window',
  )
  await app.evaluate(
    ({ app }, { root, id }) => {
      const require = process
        .getBuiltinModule('module')
        .createRequire(app.getAppPath() + '/package.json')
      const Database = require('better-sqlite3'),
        db = new Database(root + '/data/zhiji.db')
      try {
        db.prepare(
          "UPDATE discovery_sources SET state='completed' WHERE run_id=? AND platform='boss'",
        ).run(id)
      } finally {
        db.close()
      }
    },
    { root, id: verificationRun },
  )
  await page.evaluate(() => window.zhijiApi.discovery.verification({ action: 'close' }))
  await page.waitForFunction(() =>
    document.querySelector('.discovery-verification')?.textContent.includes('猎聘'),
  )
  // Exercise the real shared QR panel with local protocol responses only.
  for (const [state, label] of [
    ['login_required', '需要登录'],
    ['session_expired', '会话失效'],
  ]) {
    await app.evaluate(
      ({ app }, { root, id, state }) => {
        const require = process
          .getBuiltinModule('module')
          .createRequire(app.getAppPath() + '/package.json')
        const Database = require('better-sqlite3'),
          db = new Database(root + '/data/zhiji.db')
        try {
          db.prepare(
            "UPDATE discovery_sources SET state=CASE WHEN platform='boss' THEN ? ELSE 'completed' END WHERE run_id=?",
          ).run(state, id)
        } finally {
          db.close()
        }
      },
      { root, id: verificationRun, state },
    )
    await page.waitForFunction(
      (label) =>
        document.querySelector('.discovery-verification')?.textContent === 'BOSS 直聘 · ' + label,
      label,
    )
    const nativeCount = await app.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    )
    await warning.click()
    const dialog = page.locator('.discovery-source-login')
    await dialog.waitFor()
    await dialog.locator('.discovery-qr-image').waitFor()
    assert.equal(await dialog.locator('.discovery-qr-title').innerText(), 'BOSS 直聘')
    assert.equal(await dialog.locator('.discovery-account-left').count(), 0)
    assert.equal(
      await dialog.locator('.discovery-qr-image').evaluate(async (img) => {
        await img.decode()
        return img.naturalWidth > 0
      }),
      true,
    )
    assert.equal(
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
      nativeCount,
    )
    await page.waitForFunction(() => {
      const dialog = document.querySelector('.discovery-source-login')
      if (!dialog) return false
      for (let element = dialog; element; element = element.parentElement)
        if (Number(getComputedStyle(element).opacity) < 1) return false
      return true
    })
    await screenshot(`discovery-${state}-qr.png`)
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    assert.equal(await warning.innerText(), 'BOSS 直聘 · ' + label)
    assert.equal(
      await page.evaluate(() => window.zhijiApi.discovery.verification({ action: 'get' })),
      null,
    )
  }
  // Manual native-window closure replaces the QR within the attempt already polled by the UI.
  await signIn([])
  await app.evaluate(async ({ session, BrowserWindow }, root) => {
    const current = session.fromPath(
      process.getBuiltinModule('path').join(root, 'browser-sessions', 'liepin'),
      { cache: true },
    )
    // Register this session with the shared fixture before replacing its responses.
    const probe = new BrowserWindow({
      show: false,
      webPreferences: { session: current, sandbox: true, nodeIntegration: false },
    })
    probe.destroy()
    await current.protocol.unhandle('https')
    let creates = 0
    current.protocol.handle('https', (request) => {
      const url = new URL(request.url)
      if (url.hostname === 'safe.liepin.com')
        return new Response(
          '<!doctype html><title>安全验证</title><p>安全验证</p><button>验证</button>',
          {
            headers: { 'content-type': 'text/html; charset=utf-8' },
          },
        )
      if (url.pathname.endsWith('get-mini-qrcode')) {
        if (++creates === 1)
          return new Response('{"flag":0}', {
            headers: {
              'TD-SecIntercept-Redirect': 'https://safe.liepin.com/intercept/ip/captcha/dispatch',
            },
          })
        return Response.json({
          flag: 1,
          data: {
            key: 'manual-close-fixture',
            qrcode:
              'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jrAAAAABJRU5ErkJggg==',
          },
        })
      }
      return Response.json({ flag: 1, data: { status: '10001' } })
    })
  }, root)
  await page.getByRole('button', { name: '账号管理', exact: true }).click()
  const retryPanel = page.locator('.discovery-accounts')
  await retryPanel.getByRole('button', { name: '猎聘', exact: true }).click()
  await retryPanel.getByRole('button', { name: '打开猎聘验证', exact: true }).waitFor()
  const oldAttempt = await page.evaluate(() =>
    window.zhijiApi.discovery.qrLogin({ action: 'get', platform: 'liepin' }),
  )
  await retryPanel.getByRole('button', { name: '打开猎聘验证', exact: true }).click()
  await waitFor(
    async () =>
      (
        await page.evaluate(() =>
          window.zhijiApi.discovery.qrLogin({ action: 'get', platform: 'liepin' }),
        )
      )?.verification.window === 'ready',
    'QR verification window',
  )
  await app.evaluate(
    ({ BrowserWindow }, mainId) => {
      const verification = BrowserWindow.getAllWindows().find(
        (win) => win.id !== mainId && win.isVisible(),
      )
      if (!verification) throw new Error('Missing visible verification window')
      verification.close()
    },
    await mainWindow.evaluate((win) => win.id),
  )
  await retryPanel.locator('.discovery-qr-image').waitFor()
  const replacement = await page.evaluate(() =>
    window.zhijiApi.discovery.qrLogin({ action: 'get', platform: 'liepin' }),
  )
  assert.equal(replacement.attemptId, oldAttempt.attemptId)
  assert.equal(replacement.method, oldAttempt.method)
  assert.equal(replacement.state, 'waiting')
  assert.equal(replacement.verification.window, 'closed')
  await retryPanel.getByRole('button', { name: '关闭', exact: true }).click()

  // The two-method QR panel must remain fully reachable when its content overflows.
  await app.evaluate(({ session }, root) => {
    const current = session.fromPath(
      process.getBuiltinModule('path').join(root, 'browser-sessions', 'iguopin'),
      { cache: true },
    )
    current.protocol.handle('https', (request) => {
      const data = new URL(request.url).pathname.endsWith('/randKey')
        ? { qcode: 'scroll-layout-fixture' }
        : { is_scan: false }
      return new Response(JSON.stringify({ code: 200, data }), {
        headers: { 'content-type': 'application/json' },
      })
    })
  }, root)
  await page.getByRole('button', { name: '账号管理', exact: true }).click()
  const accounts = page.locator('.discovery-accounts')
  await accounts.getByRole('button', { name: '国聘', exact: true }).click()
  await accounts.locator('.discovery-qr-image').waitFor()
  assert.equal(await accounts.locator('.discovery-qr-methods button').count(), 2)
  for (const [width, height, zoom] of [
    [1280, 900, 1],
    [1280, 600, 1.5],
  ]) {
    await resizeWindow(width, height, zoom)
    await dimensions('.discovery-accounts')
    const positions = await accounts.evaluate((dialog) => {
      const panel = dialog.querySelector('.discovery-qr-panel')
      const left = dialog.querySelector('.discovery-account-left')
      const header = dialog.querySelector('.n-card-header')
      const footer = dialog.querySelector('.discovery-account-footer')
      const bounds = panel.getBoundingClientRect()
      const top = bounds.top + panel.clientTop
      const bottom = top + panel.clientHeight
      left.scrollTop = left.scrollHeight
      const leftTop = left.scrollTop
      const headerTop = header.getBoundingClientRect().top
      const footerTop = footer.getBoundingClientRect().top
      panel.scrollTop = 0
      const title = panel.querySelector('.discovery-qr-title').getBoundingClientRect()
      const image = panel.querySelector('.discovery-qr-image').getBoundingClientRect()
      panel.scrollTop += image.top - top
      const visibleImage = panel.querySelector('.discovery-qr-image').getBoundingClientRect()
      panel.scrollTop = panel.scrollHeight
      const last = panel.lastElementChild.getBoundingClientRect()
      const dialogBounds = dialog.getBoundingClientRect()
      const result = {
        dialogVisible:
          dialogBounds.left >= 0 &&
          dialogBounds.top >= 0 &&
          dialogBounds.right <= innerWidth &&
          dialogBounds.bottom <= innerHeight,
        titleReachable: title.top >= top && title.bottom <= bottom,
        lastReachable: last.top >= top && last.bottom <= bottom,
        imageSquare: Math.abs(image.width - image.height) < 1,
        imageReachable: visibleImage.top >= top - 1 && visibleImage.bottom <= bottom + 1,
        independent:
          left.scrollTop === leftTop &&
          header.getBoundingClientRect().top === headerTop &&
          footer.getBoundingClientRect().top === footerTop,
        overflow: panel.scrollHeight > panel.clientHeight,
      }
      panel.scrollTop = Math.max(0, image.top - top)
      return result
    })
    assert.ok(positions.dialogVisible, 'The complete dialog must remain within the viewport')
    assert.ok(
      positions.titleReachable,
      'QR title must be fully visible at the top of its scroll range',
    )
    assert.ok(positions.lastReachable, 'QR refresh button must be fully visible at the bottom')
    assert.ok(positions.imageSquare, 'Scrolling must not squeeze the QR image')
    assert.ok(positions.imageReachable, 'The entire QR must fit within its scroll viewport')
    assert.ok(
      positions.independent,
      'QR scrolling must not move the account list or dialog header/footer',
    )
    if (zoom > 1) assert.ok(positions.overflow, 'The compact layout must exercise overflow')
    await screenshot(`discovery-qr-scroll-${zoom}.png`)
  }
  await accounts.getByRole('button', { name: '关闭', exact: true }).click()
  await mainWindow.evaluate((win, bounds) => {
    win.webContents.setZoomFactor(1)
    win.setBounds(bounds)
  }, originalBounds)
  assert.deepEqual(errors, [])
  console.log(
    'Login selection, inline cancel, dialogs/history, warning queue, QR warning routing and isolated native verification passed.',
  )
} finally {
  await app.close()
}
