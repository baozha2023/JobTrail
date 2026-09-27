import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { encodeTestConfig } from './config-test-helpers.mjs'
const require = createRequire(import.meta.url)
const root = path.resolve(import.meta.dirname, '..')
const staging = fs.mkdtempSync(path.join(root, 'dist', '.startup-error-'))
try {
  for (const [name, contents, token, expected] of [
    ['corrupt', '{invalid', false, '配置文件损坏'],
    ['missing-fields', encodeTestConfig({ configVersion: 1 }), false, '配置文件损坏'],
    [
      'wrong-key',
      encodeTestConfig({ configVersion: 1 }, Buffer.alloc(32, 0x53)),
      false,
      '配置文件损坏',
    ],
    ['version', encodeTestConfig({ configVersion: 999 }), false, '版本不受'],
    ['root-owned', '{invalid', true, undefined],
  ]) {
    const directory = path.join(staging, name)
    fs.mkdirSync(directory)
    fs.writeFileSync(path.join(directory, 'config.json'), contents)
    fs.mkdirSync(path.join(directory, 'data'))
    fs.writeFileSync(path.join(directory, 'data', 'preserve.txt'), 'existing data')
    const entry = path.join(directory, 'entry.cjs')
    // Intercept presentation only; run the real built desktop entry and config
    // loader. The isolated root prevents changes to development personal data.
    fs.writeFileSync(
      entry,
      `const {app,dialog}=require('electron');const fs=require('node:fs');app.setAppPath(__dirname);app.setPath('userData',__dirname);dialog.showErrorBox=(title,message)=>fs.writeFileSync(require('node:path').join(__dirname,'message.json'),JSON.stringify({title,message}));require(${JSON.stringify(path.join(root, 'out/main/desktop.js'))});`,
    )
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_RENDERER_URL
    delete env.JOBTRAIL_LAUNCH_TOKEN
    if (token) env.JOBTRAIL_LAUNCH_TOKEN = '00000000-0000-4000-8000-000000000001'
    const result = spawnSync(require('electron'), [entry], {
      env,
      timeout: 20000,
      windowsHide: true,
    })
    assert.equal(result.status, 78, `${name}: ${String(result.error ?? result.stderr)}`)
    assert.equal(fs.readFileSync(path.join(directory, 'config.json'), 'utf8'), contents)
    assert.equal(
      fs.readFileSync(path.join(directory, 'data', 'preserve.txt'), 'utf8'),
      'existing data',
    )
    const message = path.join(directory, 'message.json')
    if (expected) assert.ok(JSON.parse(fs.readFileSync(message, 'utf8')).message.includes(expected))
    else assert.equal(fs.existsSync(message), false, 'Root launch must own the final error dialog')
  }
  console.log(
    'Desktop startup error smoke passed: corrupt configuration, future version, preserved data and root-owned presentation',
  )
} finally {
  assert.equal(path.dirname(staging), path.join(root, 'dist'))
  fs.rmSync(staging, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
