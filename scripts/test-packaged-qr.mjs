import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { _electron as electron } from 'playwright'
import { linkPackagedProgram, waitFor } from './packaged-test-helpers.mjs'

const project = path.resolve(import.meta.dirname, '..')
fs.mkdirSync(path.join(project, 'dist/qa'), { recursive: true })
const staging = fs.mkdtempSync(path.join(project, 'dist', '.qr-smoke-'))
const root = path.join(staging, 'JobTrail'),
  runtime = path.join(root, '.runtime', 'current')
linkPackagedProgram(path.join(project, 'dist', 'win-unpacked'), runtime)
const env = { ...process.env, APPDATA: staging }
delete env.ELECTRON_RUN_AS_NODE
let app
try {
  app = await electron.launch({
    executablePath: path.join(runtime, 'zhiji.exe'),
    args: [`--user-data-dir=${path.join(staging, 'chromium')}`],
    env,
  })
  const page = await app.firstWindow()
  const mainWindow = await app.browserWindow(page)
  await page.locator('.sidebar').getByText('岗位发现', { exact: true }).click()
  await page.getByRole('button', { name: '账号管理', exact: true }).click()
  const report = []
  const candidates = ['boss', 'liepin', 'zhilian', 'wuyou', 'iguopin', 'shixiseng']
  const selected = process.argv[2]
  assert.ok(!selected || candidates.includes(selected), 'Unknown QR test platform')
  for (const [index, platform] of candidates.entries()) {
    if (selected && selected !== platform) continue
    await app.evaluate(
      async ({ session }, { root, platform }) => {
        const s = session.fromPath(
          process.getBuiltinModule('path').join(root, 'browser-sessions', platform),
          { cache: true },
        )
        const events = []
        // Endpoint paths only: never record query credentials, headers or response bodies.
        s.webRequest.onBeforeRedirect((event) =>
          events.push({
            kind: 'redirect',
            status: event.statusCode,
            path: new URL(event.url).pathname,
            target: new URL(event.redirectURL).origin,
          }),
        )
        s.webRequest.onErrorOccurred((event) =>
          events.push({ kind: 'error', error: event.error, path: new URL(event.url).pathname }),
        )
        s.webRequest.onCompleted((event) =>
          events.push({
            kind: 'completed',
            status: event.statusCode,
            path: new URL(event.url).pathname,
          }),
        )
        s.__qrTestEvents = events
      },
      { root, platform },
    )
    await page
      .locator('.discovery-account')
      .nth(index)
      .getByRole('button', { name: '扫码登录', exact: true })
      .click()
    await page
      .getByText('正在获取二维码…', { exact: true })
      .waitFor({ state: 'hidden', timeout: 65000 })
    const state = await page.evaluate(async (p) => {
      const value = await window.zhijiApi.discovery.qrLogin({ action: 'get', platform: p })
      return value && { state: value.state, reason: value.reason, attemptId: value.attemptId }
    }, platform)
    const decoded =
      state?.state === 'waiting'
        ? await page.locator('.discovery-qr-image').evaluate(async (img) => {
            await img.decode()
            return img.naturalWidth > 0
          })
        : false
    const result = { platform, state: state?.state, reason: state?.reason, imageDecoded: decoded }
    if (state?.state === 'error')
      result.connectionEvents = await app.evaluate(
        ({ session }, { root, platform }) =>
          session.fromPath(
            process.getBuiltinModule('path').join(root, 'browser-sessions', platform),
            { cache: true },
          ).__qrTestEvents,
        { root, platform },
      )
    report.push(result)
    console.log(JSON.stringify(result))
    if (platform === 'shixiseng' && state?.state === 'waiting') {
      // This endpoint long-polls. Verify one real response before refreshing.
      await waitFor(
        () =>
          app.evaluate(
            ({ session }, { root, platform }) =>
              session
                .fromPath(
                  process.getBuiltinModule('path').join(root, 'browser-sessions', platform),
                  { cache: true },
                )
                .__qrTestEvents.some(
                  (event) =>
                    event.kind === 'completed' &&
                    event.status === 200 &&
                    event.path === '/api/account/v2.0/mina/polling',
                ),
            { root, platform },
          ),
        'Shixiseng QR polling response',
        70000,
      )
      result.pollResponse = 'passed'
    }
    if (['liepin', 'shixiseng'].includes(platform) && state?.state === 'waiting') {
      // Unscanned codes must survive acknowledgement and support a fresh attempt.
      await new Promise((resolve) => setTimeout(resolve, 3500))
      result.pollState = await page.evaluate(async (platform) => {
        const value = await window.zhijiApi.discovery.qrLogin({ action: 'get', platform })
        return value?.state
      }, platform)
      assert.equal(result.pollState, 'waiting', 'An unscanned QR must survive acknowledgement')
      await page.getByRole('button', { name: '刷新二维码', exact: true }).click()
      await page
        .getByText('正在获取二维码…', { exact: true })
        .waitFor({ state: 'hidden', timeout: 20000 })
      const refreshed = await page.evaluate(async (platform) => {
        const value = await window.zhijiApi.discovery.qrLogin({ action: 'get', platform })
        return value && { state: value.state, attemptId: value.attemptId }
      }, platform)
      result.refreshState = refreshed?.state
      assert.equal(result.refreshState, 'waiting')
      assert.notEqual(refreshed?.attemptId, state.attemptId)
      await page.locator('.discovery-qr-image').evaluate((img) => img.decode())
    }
    assert.equal(
      await mainWindow.evaluate((win) => win.contentView.children.length),
      0,
      'QR login must not create a native webpage',
    )
  }
  await page
    .locator('.discovery-accounts')
    .getByRole('button', { name: '关闭', exact: true })
    .click()
  assert.equal(
    await page
      .evaluate(
        (platform) => window.zhijiApi.discovery.qrLogin({ action: 'get', platform }),
        selected || 'shixiseng',
      )
      .then((s) => s?.state),
    'cancelled',
  )
  fs.writeFileSync(
    path.join(project, 'dist', 'qa', 'qr-login-live.json'),
    JSON.stringify({ at: new Date().toISOString(), report }, null, 2),
  )
  assert.ok(
    report.every((r) => r.state === 'waiting' && r.imageDecoded),
    'Every selected platform must return a usable QR image',
  )
} finally {
  if (app) await app.close()
}
