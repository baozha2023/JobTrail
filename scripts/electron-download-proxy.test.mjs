import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)
const builderRequire = createRequire(require.resolve('electron-builder/package.json'))
const appBuilderRequire = createRequire(builderRequire.resolve('app-builder-lib/package.json'))
const getterEntry = appBuilderRequire.resolve('@electron/get')
const fixture = 'JobTrail Electron download proxy fixture\n'
const fixtureHash = createHash('sha256').update(fixture).digest('hex')

// @electron/get catches bootstrap failures, so exercise its real downloader in
// a child process rather than only checking that global-agent exports bootstrap.
async function downloadThroughProxy(root) {
  const { downloadArtifact, ElectronDownloadCacheMode } = require(getterEntry)
  const options = {
    version: require('electron/package.json').version,
    artifactName: 'proxy-fixture.txt',
    isGeneric: true,
    cacheMode: ElectronDownloadCacheMode.Bypass,
    cacheRoot: root,
    tempDirectory: root,
    checksums: { 'proxy-fixture.txt': fixtureHash },
    downloadOptions: { quiet: true, timeout: { request: 3000 }, retry: { limit: 0 } },
  }
  const url = 'http://jobtrail-electron-proxy.invalid/proxy-fixture.txt'
  const downloaded = await downloadArtifact({
    ...options,
    mirrorOptions: { resolveAssetURL: async () => url },
  })
  assert.equal(await readFile(downloaded, 'utf8'), fixture)
  await assert.rejects(
    downloadArtifact({
      ...options,
      mirrorOptions: { resolveAssetURL: async () => url.replace('http:', 'https:') },
    }),
    /Proxy server refused connecting.*407/,
  )
}

if (process.argv[2] === '--proxy-download-child') {
  await downloadThroughProxy(process.argv[3])
} else {
  test('Electron build downloads use HTTP and HTTPS proxies after bootstrap', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'jobtrail-electron-proxy-'))
    const requests = []
    const proxy = createServer((request, response) => {
      requests.push(request.url)
      response.end(fixture)
    })
    proxy.on('connect', (request, socket) => {
      requests.push(`CONNECT ${request.url}`)
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nConnection: close\r\n\r\n')
    })
    try {
      proxy.listen(0, '127.0.0.1')
      await once(proxy, 'listening')
      const proxyUrl = `http://127.0.0.1:${proxy.address().port}`
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !/^(GLOBAL_AGENT_|HTTPS?_PROXY$|NO_PROXY$|DEBUG$)/i.test(key),
        ),
      )
      await execFileAsync(
        process.execPath,
        [fileURLToPath(import.meta.url), '--proxy-download-child', root],
        {
          timeout: 15000,
          env: {
            ...env,
            ELECTRON_GET_USE_PROXY: '1',
            ELECTRON_GET_NO_PROGRESS: '1',
            GLOBAL_AGENT_HTTP_PROXY: proxyUrl,
            GLOBAL_AGENT_HTTPS_PROXY: proxyUrl,
          },
        },
      )
      assert.deepEqual(requests, [
        'http://jobtrail-electron-proxy.invalid/proxy-fixture.txt',
        'CONNECT jobtrail-electron-proxy.invalid:443',
      ])
    } finally {
      await new Promise((resolve) => proxy.close(resolve))
      await rm(root, { recursive: true, force: true })
    }
  })
}
