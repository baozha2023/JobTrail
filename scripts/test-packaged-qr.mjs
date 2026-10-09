import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { _electron as electron } from 'playwright'
import { linkPackagedProgram } from './packaged-test-helpers.mjs'

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
  for (const [index, platform] of ['boss', 'liepin', 'zhilian', 'wuyou'].entries()) {
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
    report.push(result)
    console.log(JSON.stringify(result))
    if (platform === 'liepin' && state?.state === 'waiting') {
      // Creation and acknowledgement both pass through Liepin's client-ID validation.
      await new Promise((resolve) => setTimeout(resolve, 3500))
      result.pollState = await page.evaluate(async () => {
        const value = await window.zhijiApi.discovery.qrLogin({ action: 'get', platform: 'liepin' })
        return value?.state
      })
      assert.equal(result.pollState, 'waiting', 'An unscanned QR must survive acknowledgement')
      await page.getByRole('button', { name: '刷新二维码', exact: true }).click()
      await page
        .getByText('正在获取二维码…', { exact: true })
        .waitFor({ state: 'hidden', timeout: 20000 })
      const refreshed = await page.evaluate(async () => {
        const value = await window.zhijiApi.discovery.qrLogin({ action: 'get', platform: 'liepin' })
        return value && { state: value.state, attemptId: value.attemptId }
      })
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
      .evaluate(() => window.zhijiApi.discovery.qrLogin({ action: 'get', platform: 'wuyou' }))
      .then((s) => s?.state),
    'cancelled',
  )
  fs.writeFileSync(
    path.join(project, 'dist', 'qa', 'qr-login-live.json'),
    JSON.stringify({ at: new Date().toISOString(), report }, null, 2),
  )
  assert.ok(
    report.every((r) => r.state === 'waiting' && r.imageDecoded),
    'All four platforms must return a usable QR image',
  )
} finally {
  if (app) await app.close()
}
