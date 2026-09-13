import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

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
    { name: `jobtrail-packaged-smoke-${name}`, version: '1.0.0' },
    clientOptions,
  )
  try {
    await client.connect(transport)
    const tools = await client.listTools()
    if (tools.tools.length !== 36 || new Set(tools.tools.map((tool) => tool.name)).size !== 36) {
      throw new Error(`${name}: expected 36 unique tools, received ${tools.tools.length}`)
    }
    const disabled = await client.callTool({ name: 'list_statuses', arguments: {} })
    if (!disabled.isError || disabled.structuredContent?.error?.code !== 'MCP_DISABLED') {
      throw new Error(`${name}: default-disabled guard did not return MCP_DISABLED`)
    }
  } catch (error) {
    if (diagnostics.trim()) process.stderr.write(diagnostics)
    throw error
  } finally {
    await client.close()
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
    console.log('Root launcher MCP pipe and lifetime smoke passed')
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const executable = path.resolve(process.argv[2] ?? 'dist/win-unpacked/zhiji.exe')
  if (!fs.existsSync(executable)) throw new Error(`Packaged executable not found: ${executable}`)
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
    console.log(`Packaged MCP smoke passed for ${executable}`)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}
