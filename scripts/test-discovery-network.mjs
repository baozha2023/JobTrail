import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { _electron as electron } from 'playwright'
import { linkPackagedProgram } from './packaged-test-helpers.mjs'

const project = path.resolve(import.meta.dirname, '..')
const staging = fs.mkdtempSync(path.join(project, 'dist', '.discovery-network-'))
const root = path.join(staging, 'JobTrail'),
  runtime = path.join(root, '.runtime/current')
linkPackagedProgram(path.join(project, 'dist', 'win-unpacked'), runtime)
fs.copyFileSync(
  path.join(project, 'native/bootstrap/target/debug/launcher.exe'),
  path.join(root, 'JobTrail.exe'),
)
const certificate = path.join(staging, 'fixture.pfx')
// Generate an ephemeral test certificate without installing anything in the OS store.
execFileSync(
  'powershell.exe',
  [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `
  $rsa = [System.Security.Cryptography.RSA]::Create(2048)
  $request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=www.zhipin.com', $rsa, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
  $san = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
  $san.AddDnsName('www.zhipin.com')
  $request.CertificateExtensions.Add($san.Build())
  $cert = $request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddDays(-1), [DateTimeOffset]::UtcNow.AddDays(1))
  [IO.File]::WriteAllBytes($env:ZHIJI_QA_CERT_FILE, $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx))
  $cert.Dispose()
  $rsa.Dispose()
`,
  ],
  { env: { ...process.env, ZHIJI_QA_CERT_FILE: certificate }, windowsHide: true },
)
const env = { ...process.env, APPDATA: staging }
delete env.ELECTRON_RUN_AS_NODE
let application
try {
  application = await electron.launch({
    executablePath: path.join(runtime, 'zhiji.exe'),
    args: [`--user-data-dir=${path.join(staging, 'chromium')}`],
    env,
  })
  const page = await application.firstWindow()
  await page.locator('.sidebar').waitFor()
  const platforms = ['boss', 'liepin', 'zhilian', 'wuyou', 'iguopin', 'shixiseng']
  await application.evaluate(
    ({ session }, { root, platforms }) => {
      const path = process.getBuiltinModule('path')
      globalThis.systemNetworkCalls = {}
      for (const platform of platforms) {
        const current = session.fromPath(path.join(root, 'browser-sessions', platform))
        const original = current.setProxy.bind(current)
        const calls = (globalThis.systemNetworkCalls[platform] = [])
        current.setProxy = async (config) => {
          calls.push(config)
          return original(config)
        }
      }
    },
    { root, platforms },
  )
  // Initialize the production sessions using only disposable account storage.
  for (const platform of platforms) {
    await page.evaluate(
      (platform) => window.zhijiApi.discovery.browser({ action: 'clear', platform }),
      platform,
    )
  }
  const configured = await application.evaluate(
    async ({ session }, { root, platforms }) => {
      const path = process.getBuiltinModule('path')
      const reference = session.fromPartition('network-system-reference')
      await reference.setProxy({ mode: 'system' })
      const expected = await reference.resolveProxy('https://www.zhipin.com/')
      const matches = []
      for (const platform of platforms) {
        const current = session.fromPath(path.join(root, 'browser-sessions', platform))
        matches.push((await current.resolveProxy('https://www.zhipin.com/')) === expected)
      }
      return { calls: globalThis.systemNetworkCalls, matches }
    },
    { root, platforms },
  )
  for (const platform of platforms)
    assert.deepEqual(configured.calls[platform], [{ mode: 'system' }])
  assert.ok(configured.matches.every(Boolean), 'Every platform must use the system proxy policy')

  const result = await application.evaluate(
    async ({ session, BrowserWindow }, { root, certificate }) => {
      const https = process.getBuiltinModule('https')
      const http = process.getBuiltinModule('http')
      const net = process.getBuiltinModule('net')
      const fs = process.getBuiltinModule('fs')
      const path = process.getBuiltinModule('path')
      const current = session.fromPath(path.join(root, 'browser-sessions', 'boss'))
      const requests = []
      const authorities = []
      const sockets = new Set()
      const tls = https.createServer({ pfx: fs.readFileSync(certificate) }, (req, res) => {
        requests.push(req.url)
        res.setHeader('Cache-Control', 'no-store')
        if (req.url === '/worker.js') {
          res.setHeader('Content-Type', 'application/javascript')
          res.end(
            `self.addEventListener('install',e=>e.waitUntil(self.skipWaiting()));self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('message',e=>e.waitUntil(fetch('/worker-fetch').then(r=>r.text()).then(text=>e.ports[0].postMessage(text))));`,
          )
        } else if (req.url === '/hang') {
          // Deliberately leave the response pending to check cancellation.
        } else if (req.url === '/redirect') {
          res.writeHead(302, { location: '/redirected' })
          res.end()
        } else if (req.url.endsWith('-fetch')) {
          res.end(req.headers.cookie || 'missing cookie')
        } else {
          res.setHeader('Content-Type', 'text/html')
          res.setHeader(
            'Set-Cookie',
            'network-fixture=synthetic; Secure; HttpOnly; SameSite=Lax; Path=/',
          )
          res.end('<!doctype html><title>Network fixture</title><p>system transport</p>')
        }
      })
      const proxy = http.createServer((_req, res) => {
        res.writeHead(502)
        res.end()
      })
      for (const server of [tls, proxy])
        server.on('connection', (socket) => {
          sockets.add(socket)
          socket.on('close', () => sockets.delete(socket))
        })
      await new Promise((resolve) => tls.listen(0, '127.0.0.1', resolve))
      proxy.on('connect', (req, socket, head) => {
        authorities.push(req.url)
        if (!['www.zhipin.com:443', 'untrusted.zhipin.com:443'].includes(req.url))
          return socket.destroy()
        const upstream = net.createConnection(tls.address().port, '127.0.0.1', () => {
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
          if (head.length) upstream.write(head)
          socket.pipe(upstream).pipe(socket)
        })
        socket.on('error', () => upstream.destroy())
        socket.on('close', () => upstream.destroy())
        upstream.on('error', () => socket.destroy())
        upstream.on('close', () => socket.destroy())
      })
      await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve))
      let win
      try {
        // The production system configuration was verified above. Substitute a
        // local proxy only in this disposable test Session to avoid real websites
        // and changes to Windows settings while exercising Chromium's transport.
        await current.setProxy({
          mode: 'fixed_servers',
          proxyRules: `http://127.0.0.1:${proxy.address().port}`,
        })
        await current.closeAllConnections()
        let certRejected = false
        try {
          await current.fetch('https://untrusted.zhipin.com/untrusted')
        } catch {
          certRejected = true
        }
        current.setCertificateVerifyProc((request, done) =>
          done(request.hostname === 'www.zhipin.com' ? 0 : -3),
        )
        await current.closeAllConnections()
        const response = await current.fetch('https://www.zhipin.com/session', {
          cache: 'no-store',
        })
        const text = await response.text()
        const redirected = await (await current.fetch('https://www.zhipin.com/redirect')).text()
        win = new BrowserWindow({
          show: false,
          webPreferences: {
            session: current,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
          },
        })
        await win.loadURL('https://www.zhipin.com/page')
        const renderer = await win.webContents.executeJavaScript(`(async()=>{
        const page=await(await fetch('/renderer-fetch')).text();
        await navigator.serviceWorker.register('/worker.js');
        const registration=await navigator.serviceWorker.ready;
        const channel=new MessageChannel();
        const worker=new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>reject(new Error('worker timeout')),10000);
          channel.port1.onmessage=event=>{clearTimeout(timer);resolve(event.data)};
        });
        registration.active.postMessage('check',[channel.port2]);
        return {page,worker:await worker};
      })()`)
        let cancelled = false
        try {
          await current.fetch('https://www.zhipin.com/hang', { signal: AbortSignal.timeout(200) })
        } catch {
          cancelled = true
        }
        return { certRejected, text, redirected, renderer, cancelled, authorities, requests }
      } finally {
        win?.destroy()
        await current.closeAllConnections()
        current.setCertificateVerifyProc(null)
        await current.setProxy({ mode: 'system' })
        for (const socket of sockets) socket.destroy()
        await Promise.all(
          [tls, proxy].map((server) => new Promise((resolve) => server.close(resolve))),
        )
      }
    },
    { root, certificate },
  )
  assert.equal(result.certRejected, true)
  assert.match(result.text, /system transport/)
  assert.match(result.redirected, /system transport/)
  assert.match(result.renderer.page, /network-fixture=synthetic/)
  assert.match(result.renderer.worker, /network-fixture=synthetic/)
  assert.equal(result.cancelled, true)
  assert.ok(result.authorities.length > 0)
  assert.ok(
    result.authorities.every((value) =>
      ['www.zhipin.com:443', 'untrusted.zhipin.com:443'].includes(value),
    ),
  )
  assert.ok(result.requests.includes('/redirected'))
  console.log(
    'Packaged discovery system networking passed: six platform policies, Chromium TLS, Session fetch, renderer, Service Worker, cookies, redirects and cancellation',
  )
} finally {
  await application?.close()
  assert.equal(path.dirname(staging), path.join(project, 'dist'))
  assert.ok(path.basename(staging).startsWith('.discovery-network-'))
  fs.rmSync(staging, { recursive: true, force: true })
}
