import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { cleanupReleaseOutput } from './cleanup-release-output.mjs'

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrail-release-cleanup-'))
  t.after(() => {
    assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()))
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 })
  })
  return root
}

function write(root, name, content = name) {
  const file = path.join(root, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

test('removes known build outputs while preserving release assets, unknown files and project data', (t) => {
  const root = workspace(t)
  const generated = [
    'win-unpacked/resources/app.asar',
    'qa/desktop.png',
    'compatibility/report.json',
    '.discovery-dialogs-Ab12cD/JobTrail/data/zhiji.db',
    '.discovery-mcp-aB12cD/JobTrail/config.json',
    '.session-restart-ABC123/JobTrail/browser-sessions/session',
    '.onboarding-Ab12CD/JobTrail/data/zhiji.db',
    'builder-debug.yml',
    'builder-effective-config.yaml',
    'exam-smoke.png',
    'exam-smoke-failure.png',
  ]
  const retained = [
    'dist/velopack/JobTrail-Setup-2.3.0.exe',
    'dist/velopack/releases.win.json',
    'dist/velopack/zhiji-2.3.0-full.nupkg',
    'dist/velopack/zhiji-2.3.0-delta.nupkg',
    'dist/velopack/jobtrail-company-catalog.json',
    'dist/velopack/jobtrail-company-catalog.manifest.json',
    'dist/velopack/SHA256SUMS.txt',
    'dist/notes.txt',
    'dist/manual/archive.zip',
    'dist/.discovery-dialogs-not-temporary/keep.txt',
    'dist/.discovery-mcp-a1B2c3-notes/keep.txt',
    'dist/.session-restart-12345/keep.txt',
    'dist/.onboarding-Ab12CD-notes/keep.txt',
    'dist/.unrelated-Ab12CD/keep.txt',
    'config.json',
    'data/zhiji.db',
  ]
  for (const name of generated) write(root, `dist/${name}`)
  for (const name of retained) write(root, name)

  assert.deepEqual(
    cleanupReleaseOutput(root).sort(),
    generated.map((name) => name.split('/')[0]).sort(),
  )
  for (const name of generated) assert.equal(fs.existsSync(path.join(root, 'dist', name)), false)
  for (const name of retained) assert.equal(fs.readFileSync(path.join(root, name), 'utf8'), name)
  assert.deepEqual(cleanupReleaseOutput(root), [])
})

test('accepts missing outputs and removes only the generated items present', (t) => {
  const root = workspace(t)
  assert.deepEqual(cleanupReleaseOutput(root), [])
  write(root, 'dist/qa/nested/report.json')
  assert.deepEqual(cleanupReleaseOutput(root), ['qa'])
  assert.deepEqual(fs.readdirSync(path.join(root, 'dist')), [])
})

test('refuses a dist junction without deleting its destination', (t) => {
  const root = workspace(t)
  const outside = workspace(t)
  write(outside, 'win-unpacked/keep.txt')
  fs.symlinkSync(outside, path.join(root, 'dist'), 'junction')

  assert.throws(() => cleanupReleaseOutput(root), /dist must be a regular directory/)
  assert.equal(
    fs.readFileSync(path.join(outside, 'win-unpacked/keep.txt'), 'utf8'),
    'win-unpacked/keep.txt',
  )
})

test('refuses linked cleanup targets before deleting any other output', (t) => {
  const root = workspace(t)
  const outside = workspace(t)
  write(root, 'dist/win-unpacked/keep.txt')
  write(outside, 'keep.txt')
  fs.symlinkSync(outside, path.join(root, 'dist/qa'), 'junction')

  assert.throws(() => cleanupReleaseOutput(root), /Invalid release cleanup target: qa/)
  assert.equal(
    fs.readFileSync(path.join(root, 'dist/win-unpacked/keep.txt'), 'utf8'),
    'dist/win-unpacked/keep.txt',
  )
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep.txt')
})

test('refuses an unexpected target type before deleting any output', (t) => {
  const root = workspace(t)
  write(root, 'dist/win-unpacked/keep.txt')
  write(root, 'dist/builder-debug.yml/keep.txt')

  assert.throws(
    () => cleanupReleaseOutput(root),
    /Invalid release cleanup target: builder-debug.yml/,
  )
  assert.equal(fs.existsSync(path.join(root, 'dist/win-unpacked/keep.txt')), true)
  assert.equal(fs.existsSync(path.join(root, 'dist/builder-debug.yml/keep.txt')), true)
})

test('refuses a generated test directory junction before deleting any output', (t) => {
  const root = workspace(t)
  const outside = workspace(t)
  write(root, 'dist/win-unpacked/keep.txt')
  write(outside, 'keep.txt')
  fs.symlinkSync(outside, path.join(root, 'dist/.discovery-mcp-Abc123'), 'junction')

  assert.throws(
    () => cleanupReleaseOutput(root),
    /Invalid release cleanup target: \.discovery-mcp-Abc123/,
  )
  assert.equal(fs.existsSync(path.join(root, 'dist/win-unpacked/keep.txt')), true)
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep.txt')
})

test('removes nested junctions without following them outside the cleanup directory', (t) => {
  const root = workspace(t)
  const outside = workspace(t)
  write(root, 'dist/qa/report.json')
  write(outside, 'keep.txt')
  fs.symlinkSync(outside, path.join(root, 'dist/qa/link'), 'junction')

  assert.deepEqual(cleanupReleaseOutput(root), ['qa'])
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep.txt')
})
