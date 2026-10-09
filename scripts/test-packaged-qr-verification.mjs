import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { _electron as electron } from 'playwright'
import { linkPackagedProgram } from './packaged-test-helpers.mjs'

const project = path.resolve(import.meta.dirname, '..')
fs.mkdirSync(path.join(project, 'dist/qa'), { recursive: true })
const staging = fs.mkdtempSync(path.join(project, 'dist', '.qr-verification-'))
const root = path.join(staging, 'JobTrail'),
  runtime = path.join(root, '.runtime/current')
linkPackagedProgram(path.join(project, 'dist/win-unpacked'), runtime)
fs.copyFileSync(
  path.join(project, 'native/bootstrap/target/debug/launcher.exe'),
  path.join(root, 'JobTrail.exe'),
)
const env = { ...process.env, APPDATA: staging }
delete env.ELECTRON_RUN_AS_NODE
const application = await electron.launch({
  executablePath: path.join(runtime, 'zhiji.exe'),
  args: [`--user-data-dir=${path.join(staging, 'chromium')}`],
  env,
})
const report = { at: new Date().toISOString() }
try {
  const page = await application.firstWindow()
  await page.locator('.sidebar').waitFor()
  await page.waitForFunction(() => !!window.zhijiApi?.discovery)
  const call = (input) =>
    page.evaluate(async (input) => {
      const value = await window.zhijiApi.discovery.qrLogin(input)
      // Never export or log image bytes, opaque challenge targets, or cookies.
      return value && { ...value, image: !!value.image }
    }, input)
  const windows = () =>
    application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
  const baseline = await windows()
  await application.evaluate(({ app, session }, root) => {
    const path = process.getBuiltinModule('path')
    const s = session.fromPath(path.join(root, 'browser-sessions', 'liepin'), { cache: true })
    let officialTarget
    globalThis.verificationRequests = []
    globalThis.officialTargetUnchanged = false
    s.webRequest.onHeadersReceived({ urls: ['https://api-passport.liepin.com/*'] }, (d, done) => {
      const entry = Object.entries(d.responseHeaders || {}).find(
        ([key]) => key.toLowerCase() === 'td-secintercept-redirect',
      )
      if (entry) officialTarget = entry[1][0]
      done({})
    })
    s.webRequest.onBeforeSendHeaders(
      { urls: ['https://api-passport.liepin.com/*', 'https://safe.liepin.com/*'] },
      (d, done) => {
        const ua =
          Object.entries(d.requestHeaders).find(
            ([key]) => key.toLowerCase() === 'user-agent',
          )?.[1] || ''
        const u = new URL(d.url)
        globalThis.verificationRequests.push({
          location: u.origin + u.pathname,
          branded: /职迹|JobTrail|zhiji/i.test(ua),
        })
        done({})
      },
    )
    globalThis.verificationNavigation = []
    app.on('browser-window-created', (_event, win) => {
      win.webContents.on('did-start-navigation', (_event, value, _inPlace, mainFrame) => {
        if (mainFrame && officialTarget && value === officialTarget)
          globalThis.officialTargetUnchanged = true
      })
      win.webContents.on('did-navigate', (_event, value, status) => {
        const u = new URL(value)
        globalThis.verificationNavigation.push({ location: u.origin + u.pathname, status })
      })
    })
  }, root)
  const initial = await call({ platform: 'liepin', action: 'start' })
  report.initial = {
    state: initial.state,
    reason: initial.reason,
    verification: initial.verification,
    image: initial.image,
  }
  assert.equal(await windows(), baseline, 'QR requests must not open verification automatically')
  if (initial.state === 'waiting') {
    report.verification = 'not-required; manual challenge path not exercised'
  } else {
    assert.equal(initial.state, 'challenge')
    assert.equal(initial.verification.available, true)
    await call({ platform: 'liepin', action: 'verify', attemptId: initial.attemptId })
    let current
    for (let i = 0; i < 35; i++) {
      current = await call({ platform: 'liepin', action: 'get', attemptId: initial.attemptId })
      if (current.verification.window !== 'loading') break
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    report.verification = current.verification
    report.navigation = await application.evaluate(() => globalThis.verificationNavigation)
    report.requests = await application.evaluate(() => globalThis.verificationRequests)
    report.officialTargetUnchanged = await application.evaluate(
      () => globalThis.officialTargetUnchanged,
    )
    assert.equal(
      report.officialTargetUnchanged,
      true,
      'Use the exact official address without app suffixes',
    )
    assert.ok(report.requests.length >= 2)
    assert.ok(
      report.requests.every((r) => !r.branded),
      'Liepin requests and pages must not carry application product names',
    )
    report.errorPageSuppressed =
      current.verification.error === 'site_error' && (await windows()) === baseline
    console.log(JSON.stringify(report))
    assert.equal(
      current.verification.window,
      'ready',
      'Official verification page must actually load',
    )
    assert.equal(await windows(), baseline + 1)
    report.page = await application.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().startsWith('https://safe.liepin.com/'),
      )
      if (!win) throw new Error('Official verification window missing')
      const u = new URL(win.webContents.getURL())
      return {
        location: u.origin + u.pathname,
        visible: win.isVisible(),
        bounds: win.getBounds(),
        branded: /职迹|JobTrail|zhiji/i.test(win.getTitle() + ' ' + win.webContents.getUserAgent()),
        pageEvidence: await win.webContents.executeJavaScript(`({
          notFound: /此页面似乎不存在|我们找遍了所有地方|页面不存在|page\\s+not\\s+found/i.test(document.body?.innerText || ''),
          challenge: /安全验证|人机验证|滑动验证|请.{0,12}验证|拖动.{0,12}滑块|点击.{0,12}验证/.test(document.body?.innerText || '') || /安全中心.*验证码/.test(document.title),
          controls: [...document.querySelectorAll('button,input,canvas,[role="button"],[class*="captcha"],[id*="captcha"],iframe[src*="captcha"],iframe[src*="verify"]')].some(e => { const r=e.getBoundingClientRect();return r.width>0 && r.height>0 })
        })`),
      }
    })
    assert.equal(report.page.visible, true)
    assert.equal(report.page.branded, false)
    assert.deepEqual(report.page.pageEvidence, { notFound: false, challenge: true, controls: true })
    // Closing a window cannot grant authentication. No CAPTCHA is solved by this test.
    await application.evaluate(({ BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows())
        if (win.webContents.getURL().startsWith('https://safe.liepin.com/')) win.close()
    })
    let closed
    for (let i = 0; i < 25; i++) {
      closed = await call({ platform: 'liepin', action: 'get', attemptId: initial.attemptId })
      if (closed.verification.window === 'closed') break
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    assert.equal(closed.state, 'challenge')
    assert.equal(closed.verification.window, 'closed')
    const retry = await call({ platform: 'liepin', action: 'retry', attemptId: initial.attemptId })
    report.retry = {
      state: retry.state,
      reason: retry.reason,
      verification: retry.verification,
      image: retry.image,
    }
    assert.notEqual(retry.attemptId, initial.attemptId)
    assert.notEqual(retry.state, 'authenticated')
    assert.equal(await windows(), baseline)
    await call({ platform: 'liepin', action: 'cancel', attemptId: retry.attemptId })
  }
  report.passed = true
} catch (error) {
  report.passed = false
  throw error
} finally {
  fs.writeFileSync(
    path.join(project, 'dist/qa/qr-verification-live.json'),
    JSON.stringify(report, null, 2),
  )
  await application.close()
}
