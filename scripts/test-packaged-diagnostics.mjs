import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const project = path.resolve(import.meta.dirname, '..')
const executable = path.join(project, 'dist', 'win-unpacked', 'zhiji.exe')
const version = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8')).version
assert.ok(fs.existsSync(executable), 'Run pnpm package:win before packaged diagnostics smoke')

const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrail-diagnostics-smoke-'))
const app = path.join(path.dirname(executable), 'resources', 'app.asar', 'out', 'main')
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => value !== undefined),
)

function run(entry, extraEnvironment) {
  const result = spawnSync(executable, [path.join(app, entry)], {
    cwd: staging,
    env: { ...environment, ELECTRON_RUN_AS_NODE: '1', ...extraEnvironment },
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
  })
  if (result.error) throw result.error
  assert.equal(result.stdout, '', `${entry} wrote protocol stdout`)
  assert.equal(result.stderr, '', `${entry} leaked raw stderr`)
  return result.status
}

function record(prefix, operation) {
  const files = fs
    .readdirSync(path.join(staging, 'logs'))
    .filter((name) =>
      new RegExp(`^${prefix}-[0-9]+-[0-9a-f-]{36}-[0-9]+\\.(active|closed)\\.jsonl$`).test(name),
    )
  assert.ok(files.length > 0, `${prefix} log missing`)
  const lines = files.flatMap((name) =>
    fs
      .readFileSync(path.join(staging, 'logs', name), 'utf8')
      .trim()
      .split('\n'),
  )
  const entry = lines.map((line) => JSON.parse(line)).find((item) => item.operation === operation)
  assert.ok(entry, `${operation} fault missing`)
  assert.equal(entry.process, prefix)
  assert.equal(entry.appVersion, version)
  for (const line of lines) {
    assert.ok(!line.includes('secret'), 'raw error content leaked into diagnostics')
    assert.ok(!line.includes(staging), 'absolute data path leaked into diagnostics')
  }
}

try {
  fs.writeFileSync(path.join(staging, '.jobtrail-root'), 'jobtrail-root-v1\n')
  fs.writeFileSync(path.join(staging, 'config.json'), '{ invalid json secret')
  assert.equal(
    run('mcp-node.js', {
      JOBTRAIL_MCP_ROOT: staging,
      JOBTRAIL_MCP_VERSION: version,
    }),
    78,
  )
  record('mcp', 'mcp.initialize')
  const firstRun = fs
    .readdirSync(path.join(staging, 'logs'))
    .filter((name) => /^mcp-\d+-[0-9a-f-]{36}-\d+\.(active|closed)\.jsonl$/.test(name))
    .reduce(
      (count, name) =>
        count +
        fs
          .readFileSync(path.join(staging, 'logs', name), 'utf8')
          .trim()
          .split('\n').length,
      0,
    )
  assert.equal(
    run('mcp-node.js', {
      JOBTRAIL_MCP_ROOT: staging,
      JOBTRAIL_MCP_VERSION: version,
    }),
    78,
  )
  const secondRun = fs
    .readdirSync(path.join(staging, 'logs'))
    .filter((name) => /^mcp-\d+-[0-9a-f-]{36}-\d+\.(active|closed)\.jsonl$/.test(name))
    .reduce(
      (count, name) =>
        count +
        fs
          .readFileSync(path.join(staging, 'logs', name), 'utf8')
          .trim()
          .split('\n').length,
      0,
    )
  assert.equal(secondRun, firstRun * 2, 'MCP process instances did not persist across restarts')

  assert.equal(
    run('agent-worker.js', {
      JOBTRAIL_LOG_ROOT: staging,
      JOBTRAIL_LOG_VERSION: version,
      JOBTRAIL_LOG_PACKAGED: '1',
    }),
    1,
  )
  record('agent', 'agent.bootstrap')
  console.log('Packaged MCP and agent diagnostic smoke passed')
} finally {
  const tempRoot = fs.realpathSync(os.tmpdir())
  const target = fs.realpathSync(staging)
  assert.ok(
    target.startsWith(`${tempRoot}${path.sep}`),
    'Unexpected diagnostics smoke cleanup path',
  )
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
