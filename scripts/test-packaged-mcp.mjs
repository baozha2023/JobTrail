import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { chromium } from 'playwright'

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
    clientOptions,
  )
  try {
    await client.connect(transport)
    const tools = await client.listTools()
    if (tools.tools.length !== 37 || new Set(tools.tools.map((tool) => tool.name)).size !== 37) {
      throw new Error(`${name}: expected 37 unique tools, received ${tools.tools.length}`)
    }
    const disabled = await client.callTool({ name: 'list_statuses', arguments: {} })
    if (!disabled.isError || disabled.structuredContent?.error?.code !== 'MCP_DISABLED') {
      throw new Error(`${name}: default-disabled guard did not return MCP_DISABLED`)
    }
    const configRoot = transportOptions.env?.JOBTRAIL_MCP_ROOT ?? transportOptions.cwd
    const configPath = path.join(configRoot, 'config.json')
    const originalConfig = fs.readFileSync(configPath, 'utf8')
    try {
      const config = JSON.parse(originalConfig)
      config.mcp.enabled = true
      fs.writeFileSync(configPath, JSON.stringify(config))
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
    } finally {
      fs.writeFileSync(configPath, originalConfig)
    }
  } catch (error) {
    if (diagnostics.trim()) process.stderr.write(diagnostics)
    throw error
  } finally {
    await client.close()
  }
}

export async function smokeBrowser(executable) {
  const browserPath = path.join(
    path.dirname(executable),
    'resources',
    'browser',
    'chrome-headless-shell.exe',
  )
  if (!fs.existsSync(browserPath)) throw new Error(`Packaged browser not found: ${browserPath}`)
  const browser = await chromium.launch({ executablePath: browserPath, headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent('<h1>JobTrail browser smoke</h1>')
    if ((await page.locator('h1').textContent()) !== 'JobTrail browser smoke')
      throw new Error('Packaged browser did not render HTML')
  } finally {
    await browser.close()
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

async function smokeUpdateFreeze(transportOptions, root) {
  const within = async (promise, message) => {
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
  const freeze = path.join(root, '.runtime', 'state', 'update-freeze')
  fs.mkdirSync(path.dirname(freeze), { recursive: true })
  const child = spawn(transportOptions.command, transportOptions.args, {
    cwd: transportOptions.cwd,
    env: transportOptions.env ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let running = false
  let ready
  const started = new Promise((resolve, reject) => {
    ready = resolve
    child.once('error', reject)
  })
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => resolve(code))
  })
  child.stderr.on('data', (chunk) => {
    if (chunk.toString().includes('running on stdio')) {
      running = true
      ready()
    }
  })
  try {
    await within(started, 'MCP did not start')
    if (!running) throw new Error('MCP did not start')
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
  let diagnostics = ''
  child.stderr.on('data', (chunk) => {
    diagnostics += chunk.toString()
  })
  try {
    await new Promise((resolve) => setTimeout(resolve, 500))
    if (child.exitCode !== null || diagnostics.includes('running on stdio'))
      throw new Error('Root launcher started MCP while update freeze was active')
    fs.rmSync(freeze)
    const exitCode = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Root MCP did not resume after update')),
        10_000,
      )
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      const ready = (chunk) => {
        if (!chunk.toString().includes('running on stdio')) return
        child.stderr.off('data', ready)
        clearTimeout(timer)
        child.stdin.end()
        child.once('exit', resolve)
      }
      child.stderr.on('data', ready)
    })
    if (exitCode !== 0) throw new Error(`Root MCP update gate exit status=${exitCode}`)
  } finally {
    fs.rmSync(freeze, { force: true })
    if (child.exitCode === null) child.kill()
  }
}

function linkTree(source, destination) {
  fs.mkdirSync(destination, { recursive: true })
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name)
    const to = path.join(destination, entry.name)
    if (entry.isDirectory()) linkTree(from, to)
    else fs.linkSync(from, to)
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
    linkTree(path.dirname(executable), runtime)
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
    }
    await smoke('root-launcher-legacy', transportOptions)
    await smoke('root-launcher-modern', transportOptions, {
      versionNegotiation: { mode: { pin: '2026-07-28' } },
    })
    smokeInvalidConfig('root-launcher', transportOptions, root)
    smokeInvalidConfig('root-launcher-desktop', { ...transportOptions, args: [] }, root)
    await smokeRootUpdateGate(transportOptions, root)
    console.log('Root launcher MCP pipe and lifetime smoke passed')
  } finally {
    fs.rmSync(staging, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
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
    },
  }
  try {
    await smoke('legacy', transportOptions)
    await smoke('modern', transportOptions, {
      versionNegotiation: { mode: { pin: '2026-07-28' } },
    })
    smokeInvalidConfig('packaged-mcp', transportOptions, root)
    await smokeUpdateFreeze(transportOptions, root)
    const desktopEnvironment = {
      ...inheritedEnvironment,
      APPDATA: root,
      LOCALAPPDATA: root,
    }
    delete desktopEnvironment.ELECTRON_RUN_AS_NODE
    smokeInvalidConfig(
      'packaged-desktop',
      {
        command: executable,
        args: [],
        cwd: path.dirname(executable),
        env: desktopEnvironment,
      },
      path.dirname(executable),
    )
    console.log(`Packaged MCP smoke passed for ${executable}`)
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}
