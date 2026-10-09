import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { linkPackagedProgram } from './packaged-test-helpers.mjs'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrail-package-isolation-'))
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()))
    fs.rmSync(root, { recursive: true, force: true })
  })
  const source = path.join(root, 'source'),
    destination = path.join(root, 'destination')
  fs.mkdirSync(source)
  return { root, source, destination }
}

test('isolates installation data and logs while preserving dependency assets with the same names', (t) => {
  const { source, destination } = fixture(t)
  fs.writeFileSync(path.join(source, 'zhiji.exe'), 'synthetic executable')
  fs.writeFileSync(path.join(source, 'config.json'), 'must not be copied')
  for (const name of ['data', 'resumes', 'chat-uploads', 'browser-sessions', '.runtime', 'logs']) {
    fs.mkdirSync(path.join(source, name))
    fs.writeFileSync(path.join(source, name, 'private.txt'), 'must not be copied')
  }
  const asset = 'resources/dependency/data/dictionary.json'
  fs.mkdirSync(path.dirname(path.join(source, asset)), { recursive: true })
  fs.writeFileSync(path.join(source, asset), 'program asset')
  linkPackagedProgram(source, destination)
  assert.deepEqual(fs.readdirSync(destination).sort(), ['resources', 'zhiji.exe'])
  assert.equal(fs.readFileSync(path.join(destination, asset), 'utf8'), 'program asset')
  assert.equal(
    fs.statSync(path.join(destination, 'zhiji.exe')).ino,
    fs.statSync(path.join(source, 'zhiji.exe')).ino,
  )
  // Deleting the isolated copy must leave the build output intact.
  fs.unlinkSync(path.join(destination, 'zhiji.exe'))
  assert.equal(fs.readFileSync(path.join(source, 'zhiji.exe'), 'utf8'), 'synthetic executable')
})

test('rejects directory links instead of traversing outside the packaged program', (t) => {
  const { root, source, destination } = fixture(t)
  const outside = path.join(root, 'outside')
  fs.mkdirSync(outside)
  fs.symlinkSync(
    outside,
    path.join(source, 'dependency'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  assert.throws(() => linkPackagedProgram(source, destination), /must not contain links/)
})
