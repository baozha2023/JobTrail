import fs from 'node:fs'
import assert from 'node:assert/strict'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { chromium } from 'playwright'
import { encodeTestConfig, decodeTestConfig } from './config-test-helpers.mjs'
import { linkPackagedProgram, withoutSystemEdge } from './packaged-test-helpers.mjs'

const packageVersion = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')).version
const inheritedEnvironment = Object.fromEntries(
  Object.entries(process.env).filter((entry) => entry[1] !== undefined),
)

export async function smoke(name, transportOptions, clientOptions = {}) {
  const transport = new StdioClientTransport({
    ...transportOptions,
    stderr: 'pipe',
  })
  let diagnostics = ''
  transport.stderr?.on('data', (chunk) => {
    diagnostics += chunk.toString()
  })
  const client = new Client(
    { name: `jobtrail-packaged-smoke-${name}`, version: packageVersion },
    { versionNegotiation: { mode: 'legacy' }, ...clientOptions },
  )
  try {
    await client.connect(transport)
    const modernVersion = clientOptions.versionNegotiation?.mode?.pin
    assert.equal(client.getProtocolEra(), modernVersion ? 'modern' : 'legacy')
    assert.equal(client.getNegotiatedProtocolVersion(), modernVersion ?? '2025-11-25')
    assert.equal(
      client.getServerVersion()?.version,
      packageVersion,
      'Rebuild the stale packaged MCP server',
    )
    const tools = await client.listTools()
    if (tools.tools.length !== 42 || new Set(tools.tools.map((tool) => tool.name)).size !== 42) {
      throw new Error(`${name}: expected 42 unique tools, received ${tools.tools.length}`)
    }
    const enabled = await client.callTool({ name: 'list_statuses', arguments: {} })
    if (enabled.isError) {
      throw new Error(`${name}: default-enabled MCP did not allow reading statuses`)
    }
    const configRoot = transportOptions.env?.JOBTRAIL_MCP_ROOT ?? transportOptions.cwd
    const configPath = path.join(configRoot, 'config.json')
    const originalConfig = fs.readFileSync(configPath, 'utf8')
    try {
      const config = decodeTestConfig(originalConfig)
      if (config.mcp.enabled !== true || config.mcp.requireWriteConfirmation !== true) {
        throw new Error(`${name}: expected MCP and write confirmation enabled by default`)
      }
      config.mcp.enabled = false
      fs.writeFileSync(configPath, encodeTestConfig(config))
      const disabled = await client.callTool({ name: 'list_statuses', arguments: {} })
      if (!disabled.isError || disabled.structuredContent?.error?.code !== 'MCP_DISABLED') {
        throw new Error(`${name}: disabled guard did not return MCP_DISABLED`)
      }
      config.mcp.enabled = true
      fs.writeFileSync(configPath, encodeTestConfig(config))
      const expired = await client.callTool({
        name: 'read_web_page',
        arguments: {
          url: 'https://example.com/',
          cursor: 'wr_00000000-0000-0000-0000-000000000000',
        },
      })
      if (!expired.isError || expired.structuredContent?.error?.code !== 'WEB_CURSOR_EXPIRED') {
        throw new Error(`${name}: packaged web cursor call did not return WEB_CURSOR_EXPIRED`)
      }
      const dynamic = await client.callTool({
        name: 'read_web_page',
        arguments: { url: 'https://playwright.dev/', render: 'dynamic' },
      })
      assert.notEqual(dynamic.isError, true, `${name}: ${JSON.stringify(dynamic.content)}`)
      assert.match(dynamic.structuredContent.text, /Playwright/)
      assert.equal(dynamic.structuredContent.incompleteReason, null)
      config.mcp.requireWriteConfirmation = false
      fs.writeFileSync(configPath, encodeTestConfig(config))
      const call = async (tool, args) => {
        const result = await client.callTool({ name: tool, arguments: args })
        assert.notEqual(result.isError, true, `${name}: ${tool} failed`)
        return result.structuredContent
      }
      const company = (
        await call('create_company', {
          input: { name: `Location smoke ${name}`, locations: [' 北京 ', '上海', '北京'] },
        })
      ).item
      assert.deepEqual(company.locations, ['上海', '北京'])
      assert.equal(
        (
          await call('search_companies', {
            keyword: company.name,
            locations: ['北京', '上海'],
            page: 1,
            pageSize: 50,
          })
        ).items.filter((item) => item.id === company.id).length,
        1,
      )
      assert.deepEqual(
        (await call('update_company', { id: company.id, input: { locations: [] } })).item.locations,
        [],
      )
      await call('delete_company', { id: company.id })
    } finally {
      fs.writeFileSync(configPath, originalConfig)
    }
    if (diagnostics.trim())
      throw new Error(`${name}: packaged MCP emitted stderr despite an available file sink`)
  } catch (error) {
    if (diagnostics.trim()) process.stderr.write(diagnostics)
    throw error
  } finally {
    await client.close()
  }
}

export async function smokeBrowser(executable) {
  const resources = path.join(path.dirname(executable), 'resources')
  assert.ok(!fs.existsSync(path.join(resources, 'browser')), 'Remove the stale bundled browser')
  const forbidden =
    /^(?:\.local-browsers|ms-playwright|chrome-headless-shell(?:\.exe|-.*)?|chromium(?:[_-]headless[_-]shell)?-\d+)$/i
  for (const entry of fs.readdirSync(resources, { recursive: true })) {
    assert.ok(!forbidden.test(path.basename(entry)), `Bundled browser cache: ${entry}`)
  }
  // Hermetic Playwright installs can also place browser binaries inside app.asar.
  const archiveCheck = spawnSync(
    executable,
    [
      '-e',
      `
    const fs = require('fs'), path = require('path');
    const archive = process.argv[1], forbidden = new RegExp(process.argv[2], 'i');
    for (const entry of fs.readdirSync(archive, { recursive: true })) {
      if (forbidden.test(path.basename(entry))) throw new Error('Bundled browser cache: ' + entry);
    }
  `,
      path.join(resources, 'app.asar'),
      forbidden.source,
    ],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
    },
  )
  if (archiveCheck.error) throw archiveCheck.error
  assert.equal(archiveCheck.status, 0, archiveCheck.stderr)
  const browser = await chromium.launch({
    channel: 'msedge',
    headless: true,
    chromiumSandbox: true,
    // Chromium exposes its command line only when this diagnostic flag is set.
    args: ['--enable-automation'],
  })
  try {
    const playwrightVersion = JSON.parse(
      fs.readFileSync(new URL('../node_modules/playwright/package.json', import.meta.url), 'utf8'),
    ).version
    console.log(`Browser smoke: Playwright ${playwrightVersion}, Edge ${browser.version()}`)
    const session = await browser.newBrowserCDPSession()
    const { arguments: args } = await session.send('Browser.getBrowserCommandLine')
    assert.ok(!args.includes('--no-sandbox'), 'Packaged browser sandbox must remain enabled')
    assert.ok(args.some((arg) => arg.includes('playwright_chromiumdev_profile-')))
    const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false })
    const requests = []
    await context.routeWebSocket('**/*', (socket) => socket.close())
    await context.route('**/*', async (route) => {
      requests.push(route.request().url())
      if (route.request().url().endsWith('/api'))
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ text: 'JobTrail Edge smoke' }),
        })
      await route.fulfill({
        contentType: 'text/html',
        body: '<main>Loading</main><script>fetch("/api").then(r=>r.json()).then(d=>document.querySelector("main").textContent=d.text)</script>',
      })
    })
    const page = await context.newPage()
    await page.goto('https://edge-smoke.test/', { waitUntil: 'networkidle' })
    assert.equal(await page.locator('main').textContent(), 'JobTrail Edge smoke')
    assert.deepEqual(requests, ['https://edge-smoke.test/', 'https://edge-smoke.test/api'])
  } finally {
    await browser.close()
  }
}

async function smokeWithoutEdge(transportOptions, root) {
  const client = new Client({ name: 'jobtrail-no-edge', version: packageVersion })
  try {
    await client.connect(
      new StdioClientTransport({
        ...transportOptions,
        env: withoutSystemEdge(
          transportOptions.env ?? inheritedEnvironment,
          path.join(root, 'no-edge'),
        ),
        stderr: 'pipe',
      }),
    )
    assert.notEqual((await client.callTool({ name: 'list_statuses', arguments: {} })).isError, true)
    const staticPage = await client.callTool({
      name: 'read_web_page',
      arguments: { url: 'https://playwright.dev/', render: 'static' },
    })
    assert.notEqual(staticPage.isError, true, JSON.stringify(staticPage.content))
    assert.match(staticPage.structuredContent.text, /Playwright/)
    // scroll starts the browser before fetching: this failure must not depend on network access.
    const dynamic = await client.callTool({
      name: 'read_web_page',
      arguments: { url: 'https://example.com/', scroll: true },
    })
    assert.equal(dynamic.isError, true)
    assert.equal(dynamic.structuredContent.error.code, 'WEB_BROWSER_UNAVAILABLE')
    assert.match(dynamic.structuredContent.error.message, /Microsoft Edge/)
    assert.equal(dynamic.structuredContent.error.details.attempts, 1)
    assert.ok(!JSON.stringify(dynamic).includes(root))
    console.log(
      'Packaged MCP: static/local reads work with Edge discovery isolated; dynamic read reports WEB_BROWSER_UNAVAILABLE',
    )
  } finally {
    await client.close()
  }
}

function smokeInvalidConfig(name, transportOptions, configRoot) {
  const configPath = path.join(configRoot, 'config.json')
  const originalConfig = fs.existsSync(configPath) ? fs.readFileSync(configPath) : null
  const invalidConfig = Buffer.from('{ invalid json')
  try {
    fs.writeFileSync(configPath, invalidConfig)
    const result = spawnSync(transportOptions.command, transportOptions.args, {
      cwd: transportOptions.cwd,
      env: transportOptions.env ?? process.env,
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
    })
    if (result.error) throw result.error
    if (result.status !== 78 || result.stdout.trim() !== '' || result.stderr.trim() !== '')
      throw new Error(
        `${name}: invalid config exit status=${result.status}, stdout bytes=${result.stdout.length}, stderr bytes=${result.stderr.length}`,
      )
    if (!fs.readFileSync(configPath).equals(invalidConfig))
      throw new Error(`${name}: invalid config was modified`)
  } finally {
    if (originalConfig) fs.writeFileSync(configPath, originalConfig)
    else fs.rmSync(configPath, { force: true })
  }
}

async function within(promise, message) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 10_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function observeMcpStartup(child) {
  let running = false
  let pending = ''
  const started = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.stdin.once('error', reject)
    const onData = (chunk) => {
      pending += chunk.toString()
      const newline = pending.indexOf('\n')
      if (newline < 0) return
      child.stdout.off('data', onData)
      try {
        const response = JSON.parse(pending.slice(0, newline))
        if (response.id !== 1 || response.result?.serverInfo?.version !== packageVersion)
          throw new Error('MCP initialize did not return the packaged server version')
        running = true
        child.stdin.write(
          JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
        )
        resolve()
      } catch (error) {
        reject(error)
      }
    }
    child.stdout.on('data', onData)
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2026-07-28',
          capabilities: {},
          clientInfo: { name: 'jobtrail-update-smoke', version: packageVersion },
        },
      }) + '\n',
    )
  })
  // A blocked launch may fail before the test reaches its bounded await.
  started.catch(() => {})
  return { started, isRunning: () => running }
}

async function smokeUpdateFreeze(transportOptions, root) {
  const freeze = path.join(root, '.runtime', 'state', 'update-freeze')
  fs.mkdirSync(path.dirname(freeze), { recursive: true })
  const child = spawn(transportOptions.command, transportOptions.args, {
    cwd: transportOptions.cwd,
    env: transportOptions.env ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => resolve(code))
  })
  const startup = observeMcpStartup(child)
  try {
    await within(startup.started, 'MCP did not start')
    fs.writeFileSync(freeze, '')
    const exitCode = await within(exited, 'MCP did not close for update')
    if (exitCode !== 75) throw new Error(`MCP update freeze exit status=${exitCode}`)
    const leases = path.join(root, '.runtime', 'state', 'mcp-sessions')
    const remaining = fs.readdirSync(leases).filter((name) => name.startsWith(`${child.pid}-`))
    if (remaining.length !== 0) throw new Error('Active MCP lease remained after freeze exit')
  } finally {
    fs.rmSync(freeze, { force: true })
    if (child.exitCode === null) child.kill()
  }
}

async function smokeRootUpdateGate(transportOptions, root) {
  const freeze = path.join(root, '.runtime', 'state', 'update-freeze')
  fs.mkdirSync(path.dirname(freeze), { recursive: true })
  fs.writeFileSync(freeze, '')
  const child = spawn(transportOptions.command, transportOptions.args, {
    cwd: transportOptions.cwd,
    env: transportOptions.env ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })
  const startup = observeMcpStartup(child)
  try {
    await new Promise((resolve) => setTimeout(resolve, 500))
    if (child.exitCode !== null || startup.isRunning())
      throw new Error('Root launcher started MCP while update freeze was active')
    fs.rmSync(freeze)
    await within(startup.started, 'Root MCP did not resume after update')
    child.stdin.end()
    const exitCode = await within(exited, 'Root MCP did not exit after stdin closed')
    if (exitCode !== 0) throw new Error(`Root MCP update gate exit status=${exitCode}`)
  } finally {
    fs.rmSync(freeze, { force: true })
    if (child.exitCode === null) child.kill()
  }
}

async function smokeRootConfigDialog(transportOptions, root) {
  const configPath = path.join(root, 'config.json')
  const original = fs.readFileSync(configPath)
  const invalid = Buffer.from('{ invalid json')
  let child
  try {
    fs.writeFileSync(configPath, invalid)
    child = spawn(transportOptions.command, [], {
      cwd: root,
      windowsHide: true,
      stdio: 'ignore',
    })
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', resolve)
    })
    const check = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.resolve('scripts/assert-root-error-dialog.ps1'),
        '-TargetProcessId',
        String(child.pid),
      ],
      { encoding: 'utf8', timeout: 25000, windowsHide: true },
    )
    if (check.error || check.status !== 0)
      throw new Error(`Native recovery dialog check failed: ${check.error ?? check.stderr}`)
    if ((await exited) !== 78) throw new Error('Root recovery dialog must exit with code 78')
    if (!fs.readFileSync(configPath).equals(invalid))
      throw new Error('Recovery dialog changed configuration')
    console.log('Native root recovery dialog verified; original configuration preserved')
  } finally {
    if (child && child.exitCode === null)
      await new Promise((resolve) => {
        child.once('exit', resolve)
        child.kill()
      })
    fs.writeFileSync(configPath, original)
  }
}

export async function smokeLauncher(executable, launcherSource) {
  if (!fs.existsSync(executable)) throw new Error(`Packaged executable not found: ${executable}`)
  if (!fs.existsSync(launcherSource)) throw new Error(`Root launcher not found: ${launcherSource}`)
  await smokeBrowser(executable)
  const staging = fs.mkdtempSync(path.resolve('dist/.mcp-launcher-smoke-'))
  const root = path.join(staging, 'JobTrail')
  const runtime = path.join(root, '.runtime/current')
  try {
    linkPackagedProgram(path.dirname(executable), runtime)
    fs.copyFileSync(launcherSource, path.join(root, 'JobTrail.exe'))
    fs.writeFileSync(path.join(root, '.jobtrail-root'), 'jobtrail-root-v1\n')
    fs.writeFileSync(
      path.join(runtime, 'sq.version'),
      `<package><version>${packageVersion}</version></package>`,
    )
    const transportOptions = {
      command: path.join(root, 'JobTrail.exe'),
      args: ['--mcp'],
      cwd: root,
      env: {
        ...inheritedEnvironment,
        PLAYWRIGHT_BROWSERS_PATH: path.join(staging, 'empty-browser-cache'),
      },
    }
    await smoke('root-launcher-legacy', transportOptions)
    await smoke('root-launcher-modern', transportOptions, {
      versionNegotiation: { mode: { pin: '2026-07-28' } },
    })
    smokeInvalidConfig('root-launcher', transportOptions, root)
    await smokeRootConfigDialog(transportOptions, root)
    await smokeRootUpdateGate(transportOptions, root)
    console.log('Root launcher MCP pipe and lifetime smoke passed')
  } finally {
    await fs.promises.rm(staging, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const executable = path.resolve(process.argv[2] ?? 'dist/win-unpacked/zhiji.exe')
  if (!fs.existsSync(executable)) throw new Error(`Packaged executable not found: ${executable}`)
  await smokeBrowser(executable)
  const root = fs.mkdtempSync(path.resolve('dist/.mcp-node-smoke-'))
  const transportOptions = {
    command: executable,
    args: [
      path.join(path.dirname(executable), 'resources', 'app.asar', 'out', 'main', 'mcp-node.js'),
    ],
    cwd: path.dirname(executable),
    env: {
      ...inheritedEnvironment,
      ELECTRON_RUN_AS_NODE: '1',
      JOBTRAIL_MCP_ROOT: root,
      JOBTRAIL_MCP_VERSION: packageVersion,
      PLAYWRIGHT_BROWSERS_PATH: path.join(root, 'empty-browser-cache'),
    },
  }
  try {
    await smoke('legacy', transportOptions)
    await smoke('modern', transportOptions, {
      versionNegotiation: { mode: { pin: '2026-07-28' } },
    })
    await smokeWithoutEdge(transportOptions, root)
    smokeInvalidConfig('packaged-mcp', transportOptions, root)
    await smokeUpdateFreeze(transportOptions, root)
    const desktopEnvironment = {
      ...inheritedEnvironment,
      APPDATA: root,
      LOCALAPPDATA: root,
      // Root-supervised startup reports the final error after rollback. Direct
      // desktop presentation is exercised by test-startup-errors.mjs.
      JOBTRAIL_LAUNCH_TOKEN: '00000000-0000-4000-8000-000000000001',
    }
    delete desktopEnvironment.ELECTRON_RUN_AS_NODE
    const desktopRoot = path.join(root, 'desktop')
    linkPackagedProgram(path.dirname(executable), desktopRoot)
    smokeInvalidConfig(
      'packaged-desktop-root-supervised',
      {
        command: path.join(desktopRoot, 'zhiji.exe'),
        args: [`--user-data-dir=${path.join(root, 'desktop-user-data')}`],
        cwd: desktopRoot,
        env: desktopEnvironment,
      },
      desktopRoot,
    )
    console.log(`Packaged MCP smoke passed for ${executable}`)
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}
