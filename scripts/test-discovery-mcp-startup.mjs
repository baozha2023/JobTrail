import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { _electron as electron } from 'playwright'
import { linkPackagedProgram } from './packaged-test-helpers.mjs'

const project = path.resolve(import.meta.dirname, '..')
const staging = fs.mkdtempSync(path.join(project, 'dist', '.discovery-mcp-'))
const root = path.join(staging, 'JobTrail'),
  runtime = path.join(root, '.runtime', 'current')
linkPackagedProgram(path.join(project, 'dist', 'win-unpacked'), runtime)
fs.copyFileSync(
  path.join(project, 'native/bootstrap/target/debug/launcher.exe'),
  path.join(root, 'JobTrail.exe'),
)
fs.writeFileSync(path.join(root, '.jobtrail-root'), 'jobtrail-root-v1\n')
fs.mkdirSync(path.join(runtime, 'resources/bootstrap'), { recursive: true })
fs.copyFileSync(
  path.join(project, 'native/bootstrap/target/release/uninstaller.exe'),
  path.join(runtime, 'resources/bootstrap/JobTrail-Uninstall.exe'),
)
fs.copyFileSync(
  path.join(project, 'native/bootstrap/target/debug/launcher.exe'),
  path.join(runtime, 'resources/bootstrap/JobTrail.exe'),
)
fs.writeFileSync(
  path.join(runtime, 'sq.version'),
  `<package><version>${JSON.parse(fs.readFileSync(path.join(project, 'package.json'))).version}</version></package>`,
)
const descriptor = path.join(root, '.runtime/state/discovery-broker.json')
const clients = []
const existing = process.argv.includes('--existing')
let application, originalWindow, originalPid
async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args })
  assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent))
  return result.structuredContent
}
try {
  if (existing) {
    const env = { ...process.env, APPDATA: staging }
    delete env.ELECTRON_RUN_AS_NODE
    application = await electron.launch({ executablePath: path.join(runtime, 'zhiji.exe'), env })
    const page = await application.firstWindow()
    await page.locator('.sidebar').waitFor()
    originalPid = await application.evaluate(() => process.pid)
    originalWindow = await application.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      return { id: w.id, visible: w.isVisible(), bounds: w.getBounds() }
    })
    assert.equal(originalWindow.visible, true)
  }
  for (let i = 0; i < 2; i++) {
    const client = new Client({ name: 'discovery-startup-test-' + i, version: '1' })
    await client.connect(
      new StdioClientTransport({
        command: path.join(root, 'JobTrail.exe'),
        args: ['--mcp'],
        cwd: root,
        env: { ...process.env, APPDATA: staging },
        stderr: 'pipe',
      }),
    )
    clients.push(client)
  }
  await call(clients[0], 'list_job_search_history', { page: 1 })
  assert.equal(fs.existsSync(descriptor), existing, 'Local history must not start the desktop')
  const request = {
    requestId: crypto.randomUUID(),
    // Valid city admission reaches desktop startup; cancel after checking ownership.
    query: { keyword: 'Java', city: '北京', platforms: ['wuyou'] },
  }
  const results = await Promise.all(clients.map((c) => call(c, 'start_job_search', request)))
  assert.equal(results[0].item.id, results[1].item.id, 'Concurrent retries must share a run')
  const owner = JSON.parse(fs.readFileSync(descriptor, 'utf8'))
  const visibility = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-Command', `(Get-Process -Id ${owner.pid}).MainWindowHandle.ToInt64()`],
    { encoding: 'utf8', windowsHide: true },
  ).trim()
  if (existing) {
    assert.equal(owner.pid, originalPid, 'MCP must reuse the already open desktop')
    assert.notEqual(visibility, '0', 'MCP must preserve the visible desktop')
    assert.deepEqual(
      await application.evaluate(({ BrowserWindow }, id) => {
        const w = BrowserWindow.fromId(id)
        return { id: w.id, visible: w.isVisible(), bounds: w.getBounds() }
      }, originalWindow.id),
      originalWindow,
    )
    assert.equal(
      fs.existsSync(path.join(root, '.runtime/state/discovery-start.lock')),
      false,
      'Existing desktop must not enter the launch path',
    )
  } else assert.equal(visibility, '0', 'MCP must launch the desktop without a visible window')
  await call(clients[1], 'cancel_job_search', { runId: results[0].item.id })
  assert.equal(
    (await call(clients[0], 'get_job_search', { runId: results[0].item.id })).item.state,
    'cancelled',
  )
  assert.equal(JSON.parse(fs.readFileSync(descriptor, 'utf8')).pid, owner.pid)
  console.log(
    `Packaged MCP: ${existing ? 'existing visible client reused without changing its window' : 'offline history and concurrent tray startup'}, request replay and cancellation passed.`,
  )
} finally {
  for (const c of clients) await c.close()
  if (application) await application.close()
  // Only the process identified by this fresh isolated installation is test-owned.
  if (fs.existsSync(descriptor)) {
    const { pid } = JSON.parse(fs.readFileSync(descriptor, 'utf8'))
    const executable = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command', `(Get-Process -Id ${Number(pid)}).Path`],
      { encoding: 'utf8', windowsHide: true },
    ).trim()
    assert.equal(
      path.resolve(executable).toLowerCase(),
      path.join(runtime, 'zhiji.exe').toLowerCase(),
    )
    process.kill(pid)
  }
}
