import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { downloadPreviousVelopackFull } from './resolve-velopack-baseline.mjs'

const bytes = Buffer.from('test Full package')
function asset(version = '4.0.0', overrides = {}) {
  return {
    PackageId: 'zhiji',
    Version: version,
    Type: 'Full',
    FileName: `zhiji-${version}-win-full.nupkg`,
    Size: bytes.length,
    SHA256: createHash('sha256').update(bytes).digest('hex'),
    ...overrides,
  }
}
async function harness(
  t,
  {
    assets = [asset()],
    feedStatus = 200,
    feedBody,
    pathname = '/updates',
    headStatus = 200,
    getStatus = 200,
    body = bytes,
  } = {},
) {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jobtrail-baseline-'))
  const requests = []
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`)
    if (req.url.endsWith('releases.win.json'))
      res.writeHead(feedStatus).end(feedBody ?? JSON.stringify({ Assets: assets }))
    else if (req.method === 'HEAD') res.writeHead(headStatus).end()
    else res.writeHead(getStatus).end(body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await fs.rm(outputDir, { recursive: true, force: true })
  })
  return {
    outputDir,
    requests,
    run: () =>
      downloadPreviousVelopackFull({
        feedUrl: `http://127.0.0.1:${server.address().port}${pathname}`,
        targetVersion: '4.0.1',
        outputDir,
      }),
  }
}

test('missing and empty sources select Full only', async (t) => {
  for (const options of [{ feedStatus: 404 }, { assets: [] }, { headStatus: 404 }]) {
    const h = await harness(t, options)
    assert.equal(await h.run(), null)
    assert.deepEqual(await fs.readdir(h.outputDir), [])
  }
})
test('downloads and verifies exactly the highest Full below target even when a newer release exists', async (t) => {
  const previous = asset()
  const h = await harness(t, {
    assets: [asset('5.0.0'), asset('3.9.0'), previous, asset('4.0.1')],
  })
  assert.deepEqual(await h.run(), {
    version: '4.0.0',
    filename: previous.FileName,
    size: bytes.length,
  })
  assert.deepEqual(h.requests, [
    'GET /updates/releases.win.json',
    `HEAD /updates/${previous.FileName}`,
    `GET /updates/${previous.FileName}`,
  ])
  assert.deepEqual(await fs.readFile(path.join(h.outputDir, previous.FileName)), bytes)
  const saved = JSON.parse(await fs.readFile(path.join(h.outputDir, 'releases.win.json'), 'utf8'))
  assert.deepEqual(saved.Assets, [
    {
      ...previous,
      SHA1: createHash('sha1').update(bytes).digest('hex').toUpperCase(),
    },
  ])
})
test('equal and higher versions are never baselines', async (t) => {
  const h = await harness(t, { assets: [asset('4.0.1'), asset('5.0.0')] })
  assert.equal(await h.run(), null)
  assert.equal(h.requests.length, 1)
})
test('invalid feeds, ambiguous baselines and source failures stop the build', async (t) => {
  for (const options of [
    { feedBody: 'bad json' },
    { feedStatus: 500 },
    { feedStatus: 503 },
    {
      feedStatus: 503,
      feedBody: JSON.stringify({ error: 'temporary_failure' }),
    },
    { assets: [asset(), asset()] },
    { assets: [asset('4.0.0', { FileName: '../outside.nupkg' })] },
    { assets: [asset('4.0.0', { SHA256: 'invalid' })] },
    { headStatus: 500 },
    { getStatus: 404 },
  ]) {
    const h = await harness(t, options)
    await assert.rejects(h.run(), /baseline/)
    assert.deepEqual(await fs.readdir(h.outputDir), [])
  }
})
test('size and SHA-256 mismatch leave no package or temporary file', async (t) => {
  for (const body of [
    Buffer.from('short'),
    Buffer.alloc(bytes.length, 1),
    Buffer.alloc(bytes.length + 1),
  ]) {
    const h = await harness(t, { body })
    await assert.rejects(h.run(), /baseline_full_(integrity_failed|size_mismatch)/)
    assert.deepEqual(await fs.readdir(h.outputDir), [])
  }
})
test('existing output package is never overwritten', async (t) => {
  const h = await harness(t)
  await fs.writeFile(path.join(h.outputDir, asset().FileName), 'existing')
  await assert.rejects(h.run(), /baseline_full_download_failed/)
  assert.equal(await fs.readFile(path.join(h.outputDir, asset().FileName), 'utf8'), 'existing')
  assert.deepEqual(await fs.readdir(h.outputDir), [asset().FileName])
})
test("feed publication failure removes only this attempt's new package", async (t) => {
  const h = await harness(t)
  await fs.writeFile(path.join(h.outputDir, 'releases.win.json'), 'existing')
  await assert.rejects(h.run(), /baseline_full_download_failed/)
  assert.deepEqual(await fs.readdir(h.outputDir), ['releases.win.json'])
  assert.equal(await fs.readFile(path.join(h.outputDir, 'releases.win.json'), 'utf8'), 'existing')
})
