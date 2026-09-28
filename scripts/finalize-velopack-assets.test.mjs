import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { finalizeVelopackAssets } from './finalize-velopack-assets.mjs'

function asset(version, type, bytes) {
  return {
    PackageId: 'zhiji',
    Version: version,
    Type: type,
    FileName: `zhiji-${version}-${type.toLowerCase()}.nupkg`,
    Size: bytes.length,
    SHA256: createHash('sha256').update(bytes).digest('hex'),
  }
}

async function workspace(t, entries) {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'jobtrail-release-assets-'))
  t.after(async () => {
    for (const name of await fs.readdir(output)) await fs.unlink(path.join(output, name))
    await fs.rmdir(output)
  })
  await fs.writeFile(
    path.join(output, 'releases.win.json'),
    JSON.stringify({ Assets: entries.map(([item]) => item) }),
  )
  for (const [item, bytes] of entries) await fs.writeFile(path.join(output, item.FileName), bytes)
  return output
}

test('publishes only current Full and Delta packages after verifying the local baseline', async (t) => {
  const previousBytes = Buffer.from('previous full')
  const fullBytes = Buffer.from('current full')
  const deltaBytes = Buffer.from('current delta')
  const previous = asset('1.0.0', 'Full', previousBytes)
  const full = asset('1.1.0', 'Full', fullBytes)
  const delta = asset('1.1.0', 'Delta', deltaBytes)
  const output = await workspace(t, [
    [full, fullBytes],
    [delta, deltaBytes],
    [previous, previousBytes],
  ])

  await finalizeVelopackAssets(output, '1.1.0', {
    version: '1.0.0',
    filename: previous.FileName,
    size: previous.Size,
  })

  const feed = JSON.parse(await fs.readFile(path.join(output, 'releases.win.json'), 'utf8'))
  assert.deepEqual(feed.Assets, [full, delta])
  assert.deepEqual(
    (await fs.readdir(output)).sort(),
    ['releases.win.json', full.FileName, delta.FileName].sort(),
  )
  assert.deepEqual(await fs.readFile(path.join(output, full.FileName)), fullBytes)
})

test('does not change the feed or remove the baseline when a current package fails integrity', async (t) => {
  const previousBytes = Buffer.from('previous full')
  const fullBytes = Buffer.from('current full')
  const previous = asset('1.0.0', 'Full', previousBytes)
  const full = asset('1.1.0', 'Full', fullBytes)
  const output = await workspace(t, [
    [previous, previousBytes],
    [full, Buffer.from('corrupt full')],
  ])
  const originalFeed = await fs.readFile(path.join(output, 'releases.win.json'), 'utf8')

  await assert.rejects(
    finalizeVelopackAssets(output, '1.1.0', {
      version: '1.0.0',
      filename: previous.FileName,
      size: previous.Size,
    }),
    /Invalid release asset/,
  )
  assert.equal(await fs.readFile(path.join(output, 'releases.win.json'), 'utf8'), originalFeed)
  assert.deepEqual(await fs.readFile(path.join(output, previous.FileName)), previousBytes)
})

test('keeps a Full-only first release intact', async (t) => {
  const bytes = Buffer.from('first full')
  const full = asset('1.0.0', 'Full', bytes)
  const output = await workspace(t, [[full, bytes]])

  await finalizeVelopackAssets(output, '1.0.0', null)

  const feed = JSON.parse(await fs.readFile(path.join(output, 'releases.win.json'), 'utf8'))
  assert.deepEqual(feed.Assets, [full])
  assert.deepEqual(await fs.readFile(path.join(output, full.FileName)), bytes)
})

test('requires a Delta package when a baseline was used', async (t) => {
  const previousBytes = Buffer.from('previous full')
  const fullBytes = Buffer.from('current full')
  const previous = asset('1.0.0', 'Full', previousBytes)
  const full = asset('1.1.0', 'Full', fullBytes)
  const output = await workspace(t, [
    [previous, previousBytes],
    [full, fullBytes],
  ])
  const originalFeed = await fs.readFile(path.join(output, 'releases.win.json'), 'utf8')

  await assert.rejects(
    finalizeVelopackAssets(output, '1.1.0', {
      version: '1.0.0',
      filename: previous.FileName,
      size: previous.Size,
    }),
    /Unexpected Delta packages/,
  )
  assert.equal(await fs.readFile(path.join(output, 'releases.win.json'), 'utf8'), originalFeed)
  assert.deepEqual(await fs.readFile(path.join(output, previous.FileName)), previousBytes)
})

test('rejects a package absent from the release feed', async (t) => {
  const bytes = Buffer.from('current full')
  const full = asset('1.1.0', 'Full', bytes)
  const output = await workspace(t, [[full, bytes]])
  await fs.writeFile(path.join(output, 'zhiji-1.0.0-full.nupkg'), Buffer.from('stale'))
  const originalFeed = await fs.readFile(path.join(output, 'releases.win.json'), 'utf8')

  await assert.rejects(finalizeVelopackAssets(output, '1.1.0', null), /Unlisted package/)
  assert.equal(await fs.readFile(path.join(output, 'releases.win.json'), 'utf8'), originalFeed)
})
