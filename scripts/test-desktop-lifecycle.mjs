import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { _electron as electron } from 'playwright'

const require = createRequire(import.meta.url)
const executablePath = require('electron')
const project = path.resolve(import.meta.dirname, '..')
const staging = fs.mkdtempSync(path.join(project, 'dist', '.desktop-lifecycle-'))
const entry = path.join(staging, 'entry.cjs')
const descriptor = path.join(staging, '.runtime/state/discovery-broker.json')
const env = { ...process.env, APPDATA: path.join(staging, 'app-data') }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
delete env.JOBTRAIL_LAUNCH_TOKEN
let application

async function until(check, message) {
  const deadline = Date.now() + 10000
  while (!(await check())) {
    assert.ok(Date.now() < deadline, message)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

async function launch(...args) {
  application = await electron.launch({ executablePath, args: [entry, ...args], env })
  const page = await application.firstWindow()
  await page.locator('.sidebar').waitFor()
  const id = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id)
  return { page, id }
}

async function visible(id) {
  return application.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).isVisible(), id)
}

async function secondLaunch(...args) {
  const child = spawn(executablePath, [entry, ...args], { env, windowsHide: true, stdio: 'ignore' })
  const timeout = setTimeout(() => child.kill(), 10000)
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', resolve)
    })
    assert.equal(code, 0, 'The second launch must hand off to the existing process')
  } finally {
    clearTimeout(timeout)
  }
}

async function addBackgroundPage() {
  return application.evaluate(({ BrowserWindow }) => {
    // Search cursors retain hidden BrowserWindows after the main window is closed.
    globalThis.lifecycleBackground = new BrowserWindow({ show: false, skipTaskbar: true })
    return globalThis.lifecycleBackground.id
  })
}

async function closeMainAndExpectExit(id) {
  const closed = application.waitForEvent('close', { timeout: 10000 })
  await application.evaluate(({ BrowserWindow }, id) => {
    setImmediate(() => BrowserWindow.fromId(id).close())
  }, id)
  await closed
  application = undefined
  assert.equal(fs.existsSync(descriptor), false, 'Shutdown must release the discovery broker')
}

try {
  fs.cpSync(path.join(project, 'out'), path.join(staging, 'out'), { recursive: true })
  fs.mkdirSync(path.join(staging, 'resource'))
  fs.copyFileSync(path.join(project, 'resource/icon.ico'), path.join(staging, 'resource/icon.ico'))
  fs.writeFileSync(
    entry,
    `const {app,dialog}=require('electron');
app.setAppPath(__dirname);
app.setPath('userData', require('node:path').join(__dirname,'chromium'));
dialog.showErrorBox=(title,message)=>{console.error(title,message);app.exit(1)};
if(process.argv.includes('--test-early-foreground'))
  app.once('ready',()=>app.emit('second-instance',{},[process.execPath,__filename],__dirname));
require(${JSON.stringify(path.join(project, 'out/main/desktop.js'))});
`,
  )

  let { page, id } = await launch()
  await until(() => visible(id), 'Normal launch must show the main window')
  await addBackgroundPage()
  assert.equal(
    await page.evaluate(() => window.zhijiApi.config.get()).then((c) => c.closeBehavior),
    'quit',
  )
  await closeMainAndExpectExit(id)
  console.log('PASS: closing the main window exits with hidden collection pages still open')
  ;({ page, id } = await launch('--discovery-background'))
  assert.equal(await visible(id), false, 'MCP background launch must not show a window')
  const pid = await application.evaluate(() => process.pid)
  await secondLaunch('--discovery-background')
  assert.equal(await visible(id), false, 'Repeated MCP launch must not show a window')
  await secondLaunch()
  await until(() => visible(id), 'A normal second launch must show the existing main window')
  assert.equal(await application.evaluate(() => process.pid), pid)
  await page.evaluate(() => window.zhijiApi.config.update({ closeBehavior: 'tray' }))
  const backgroundId = await addBackgroundPage()
  await application.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).close(), id)
  assert.equal(await visible(id), false, 'Tray close must only hide the main window')
  assert.equal(fs.existsSync(descriptor), true, 'Tray close must keep the runtime available')
  await secondLaunch('--discovery-background')
  assert.equal(await visible(id), false)
  await secondLaunch()
  await until(() => visible(id), 'Normal second launch must restore a tray window')

  await application.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).destroy(), id)
  await secondLaunch('--discovery-background')
  assert.deepEqual(
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((w) => w.id),
    ),
    [backgroundId],
    'Background launch must not recreate a user window',
  )
  const recreated = application.waitForEvent('window')
  await secondLaunch()
  page = await recreated
  await page.locator('.sidebar').waitFor()
  id = await application.evaluate(({ BrowserWindow }, backgroundId) => {
    return BrowserWindow.getAllWindows().find((w) => w.id !== backgroundId).id
  }, backgroundId)
  await until(() => visible(id), 'Normal launch must recreate a missing main window')
  assert.equal(await application.evaluate(() => process.pid), pid)
  await page.evaluate(() => window.zhijiApi.config.update({ closeBehavior: 'quit' }))
  await closeMainAndExpectExit(id)
  console.log('PASS: background reuse, tray restore, and missing-main-window recovery')
  ;({ id } = await launch('--discovery-background', '--test-early-foreground'))
  await until(() => visible(id), 'A foreground request during startup must not be lost')
  await closeMainAndExpectExit(id)
  console.log('PASS: foreground launch during background initialization')
} finally {
  if (application) await application.close()
  assert.equal(path.dirname(staging), path.join(project, 'dist'))
  fs.rmSync(staging, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
