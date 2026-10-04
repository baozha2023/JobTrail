import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import * as yauzl from 'yauzl'
import { afterEach, expect, it, vi } from 'vitest'
import { Diagnostics } from '../src/main/diagnostics'
import { createErrorInput } from '../src/shared/diagnostics'
import { exportDiagnosticBundle } from '../src/main/diagnostics/export'
import { version as currentVersion } from '../package.json'
import { TARGET_CONFIG_VERSION, TARGET_DATABASE_VERSION } from '../src/main/persistence/versions'
const roots: string[] = []
const runtimes: Diagnostics[] = []
const environment = {
  appVersion: currentVersion,
  electronVersion: process.versions.electron,
  nodeVersion: process.versions.node,
  databaseVersion: TARGET_DATABASE_VERSION,
  configVersion: TARGET_CONFIG_VERSION,
}
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrail-export-diagnostics-'))
  roots.push(root)
  const runtime = new Diagnostics('main', currentVersion, true, root)
  runtimes.push(runtime)
  return { root, runtime, target: path.join(root, 'diagnostics.zip') }
}
async function entries(file: string): Promise<Record<string, Buffer>> {
  return new Promise((resolve, reject) => {
    const files: Record<string, Buffer> = {}
    yauzl.open(file, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) {
        reject(error)
        return
      }
      zip.on('error', reject)
      zip.on('entry', (entry) =>
        zip.openReadStream(entry, (failure, stream) => {
          if (failure || !stream) {
            reject(failure)
            return
          }
          const chunks: Buffer[] = []
          stream.on('data', (chunk) => chunks.push(chunk))
          stream.on('error', reject)
          stream.on('end', () => {
            files[entry.fileName] = Buffer.concat(chunks)
            zip.readEntry()
          })
        }),
      )
      zip.on('end', () => resolve(files))
      zip.readEntry()
    })
  })
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const runtime of runtimes.splice(0)) runtime.close()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})
it('exports only current, sanitized records from the last 24 hours with hashes and environment metadata', async () => {
  const { root, runtime, target } = setup()
  runtime.accept(createErrorInput('main', 'file.write', new Error('token=topsecret failed')))
  const old = createErrorInput('main', 'old.failure', new Error('too old'))
  old.timestamp = new Date(Date.now() - 2 * 86400000).toISOString()
  runtime.accept(old)
  const logs = path.join(root, 'logs'),
    file = fs.readdirSync(logs).find((name) => name.endsWith('.jsonl'))!
  fs.appendFileSync(path.join(logs, file), 'not-json\n{"partial":')
  fs.writeFileSync(path.join(root, 'config.json'), 'private configuration')
  await exportDiagnosticBundle(root, target, environment, runtime.writer.health)
  const result = await entries(target),
    manifest = JSON.parse(result['manifest.json'].toString())
  expect(manifest).toMatchObject({
    schemaVersion: 1,
    invalidRecords: 1,
    partialLines: 1,
    environment,
  })
  expect(Object.keys(result)).not.toContain('config.json')
  const content = Object.entries(result)
    .filter(([name]) => name.startsWith('logs/'))
    .map(([, value]) => value.toString())
    .join('')
  expect(content).toContain('file.write')
  expect(content).not.toMatch(/topsecret|too old|private configuration/)
  for (const item of manifest.files)
    expect(createHash('sha256').update(result[item.path]).digest('hex')).toBe(item.sha256)
})
it('preserves a previous export if the final replacement fails and cleans its temporary file', async () => {
  const { root, runtime, target } = setup()
  runtime.accept(createErrorInput('main', 'failure', new Error('failure')))
  fs.writeFileSync(target, 'previous backup')
  vi.spyOn(fsp, 'rename').mockRejectedValueOnce(
    Object.assign(new Error('permission denied'), { code: 'EACCES' }),
  )
  await expect(
    exportDiagnosticBundle(root, target, environment, runtime.writer.health),
  ).rejects.toThrow('permission denied')
  expect(fs.readFileSync(target, 'utf8')).toBe('previous backup')
  expect(fs.readdirSync(root).some((name) => name.endsWith('.tmp'))).toBe(false)
})
