import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

export function smokeLauncherUpdate(binary) {
  const project = path.resolve(import.meta.dirname, '..')
  const staging = fs.mkdtempSync(path.join(project, 'dist', '.launcher-update-'))
  const root = path.join(staging, 'JobTrail')
  const state = path.join(root, '.runtime', 'state')
  const payload = path.join(root, '.runtime', 'current', 'resources', 'bootstrap')
  const version = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8')).version
  const bytes = fs.readFileSync(binary)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const target = path.join(root, 'JobTrail.exe')
  const worker = path.join(payload, 'JobTrail.exe')
  try {
    fs.mkdirSync(state, { recursive: true })
    fs.mkdirSync(payload, { recursive: true })
    fs.writeFileSync(path.join(root, '.jobtrail-root'), 'jobtrail-root-v1\n')
    fs.writeFileSync(
      path.join(root, '.runtime', 'current', 'sq.version'),
      `<package><version>${version}</version></package>`,
    )
    fs.writeFileSync(
      path.join(state, 'last-good.json'),
      JSON.stringify({ format: 'jobtrail-health', version, processId: process.pid }),
    )
    fs.writeFileSync(worker, bytes)
    const old = Buffer.concat([bytes, Buffer.from('synthetic previous build')])
    fs.writeFileSync(target, old)
    fs.writeFileSync(
      path.join(payload, 'launcher.json'),
      JSON.stringify({ version, sha256: '0'.repeat(64) }),
    )
    let result = spawnSync(worker, ['--refresh-root'], { timeout: 15000, windowsHide: true })
    assert.equal(result.status, 1)
    assert.deepEqual(
      fs.readFileSync(target),
      old,
      'Bad payload hash must preserve the root launcher',
    )
    fs.writeFileSync(path.join(payload, 'launcher.json'), JSON.stringify({ version, sha256 }))
    result = spawnSync(worker, ['--refresh-root'], { timeout: 15000, windowsHide: true })
    assert.equal(result.status, 0, String(result.error ?? result.stderr))
    assert.deepEqual(fs.readFileSync(target), bytes)
    assert.deepEqual(fs.readFileSync(path.join(state, 'launcher.previous.exe')), old)
    assert.ok(!fs.existsSync(path.join(state, 'launcher-update.json')))
    assert.equal(spawnSync(target, ['--bootstrap-check', version], { timeout: 10000 }).status, 0)
    assert.equal(spawnSync(target, ['--bootstrap-check', '999.0.0'], { timeout: 10000 }).status, 1)
    assert.equal(
      spawnSync(target, ['--refresh-root'], { timeout: 10000 }).status,
      1,
      'Worker must reject the root executable location',
    )
    assert.equal(
      spawnSync(worker, ['--refresh-root'], { timeout: 10000 }).status,
      0,
      'Repeated refresh is idempotent',
    )
    console.log(
      'Root launcher update smoke passed: real EXE replacement, hash rejection, backup, probe, fixed-path guard and repeat launch',
    )
  } finally {
    assert.equal(path.dirname(staging), path.join(project, 'dist'))
    fs.rmSync(staging, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  smokeLauncherUpdate(path.resolve(process.argv[2] ?? 'native/bootstrap/target/debug/launcher.exe'))
