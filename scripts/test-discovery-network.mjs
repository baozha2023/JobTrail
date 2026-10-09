import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { _electron as electron } from 'playwright'
import { linkPackagedProgram } from './packaged-test-helpers.mjs'

const project = path.resolve(import.meta.dirname, '..')
const staging = fs.mkdtempSync(path.join(project, 'dist', '.discovery-network-'))
const root = path.join(staging, 'JobTrail')
linkPackagedProgram(path.join(project, 'dist', 'win-unpacked'), root)
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
  application = await electron.launch({ executablePath: path.join(root, 'zhiji.exe'), env })
  const page = await application.firstWindow()
  await page.locator('.sidebar').waitFor()
  await application.evaluate(
    async ({ session }, { certificate }) => {
      const https = process.getBuiltinModule('https')
      const http = process.getBuiltinModule('http')
      const net = process.getBuiltinModule('net')
      const dns = process.getBuiltinModule('dns/promises')
      const fs = process.getBuiltinModule('fs')
      const originalDial = net.createConnection.bind(net)
      const originalLookup = dns.lookup.bind(dns)
      const state = (globalThis.networkFixture = {
        private: false,
        dialed: [],
        authorities: [],
        requests: [],
        privateRequests: 0,
      })
      const tls = https.createServer({ pfx: fs.readFileSync(certificate) }, (req, res) => {
        state.requests.push(req.url)
        res.setHeader('Cache-Control', 'no-store')
        const privateUrl = `https://127.0.0.1:${state.tlsPort}/private`
        if (req.url === '/redirect') {
          res.writeHead(302, { location: privateUrl })
        } else if (req.url === '/worker.js') {
          res.setHeader('Content-Type', 'application/javascript')
          res.end(
            `self.addEventListener("install",event=>event.waitUntil(self.skipWaiting()));self.addEventListener("activate",event=>event.waitUntil(self.clients.claim()));self.addEventListener("message",event=>event.waitUntil(fetch(${JSON.stringify(privateUrl)}).then(()=>event.ports[0].postMessage(false),()=>event.ports[0].postMessage(true))));`,
          )
          return
        } else res.setHeader('Content-Type', 'text/html')
        res.end(
          `<!doctype html><title>Network fixture</title><p>public connection</p><img src="${privateUrl}">`,
        )
      })
      await new Promise((resolve) => tls.listen(0, '127.0.0.1', resolve))
      const port = tls.address().port
      state.tlsPort = port
      dns.lookup = (hostname, options) =>
        ['www.zhipin.com', 'untrusted.zhipin.com'].includes(hostname)
          ? Promise.resolve([{ address: state.private ? '127.0.0.1' : '8.8.8.8', family: 4 }])
          : originalLookup(hostname, options)
      net.createConnection = (...args) => {
        if (args[0]?.host === '8.8.8.8') {
          state.dialed.push({ host: args[0].host, port: args[0].port })
          return originalDial(port, '127.0.0.1')
        }
        return originalDial(...args)
      }
      const proxy = http.createServer((_request, response) => {
        state.privateRequests++
        response.end('private endpoint')
      })
      proxy.on('connect', (req, socket, head) => {
        state.authorities.push(req.url)
        if (req.url !== '8.8.8.8:443') return socket.destroy()
        const upstream = originalDial(port, '127.0.0.1', () => {
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
      state.proxyPort = proxy.address().port
      await session.defaultSession.setProxy({ mode: 'direct' })
    },
    { certificate },
  )
  // This creates the production platform Session and applies its connection policy.
  await page.evaluate(() =>
    window.zhijiApi.discovery.browser({ action: 'clear', platform: 'boss' }),
  )
  const result = await application.evaluate(async ({ session, BrowserWindow }, root) => {
    const path = process.getBuiltinModule('path')
    const s = session.fromPath(path.join(root, 'browser-sessions', 'boss'))
    const state = globalThis.networkFixture
    const rejected = async (url) => {
      try {
        const response = await s.fetch(url, {
          cache: 'no-store',
          signal: AbortSignal.timeout(10000),
        })
        return !response.ok
      } catch {
        return true
      }
    }
    // Trust the fixture targets in this disposable Session so a loopback bypass
    // would succeed and fail the assertions, rather than being hidden by TLS.
    s.setCertificateVerifyProc((request, done) =>
      done(['www.zhipin.com', '127.0.0.1'].includes(request.hostname) ? 0 : -3),
    )
    const certRejected = await rejected('https://untrusted.zhipin.com/untrusted')
    const response = await s.fetch('https://www.zhipin.com/fetch', { cache: 'no-store' })
    const text = await response.text()
    const win = new BrowserWindow({
      show: false,
      webPreferences: { session: s, sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    await win.loadURL('https://www.zhipin.com/page')
    const renderer = await win.webContents.executeJavaScript(`(async()=>{
      await navigator.serviceWorker.register('/worker.js');
      const registration=await navigator.serviceWorker.ready;
      const channel=new MessageChannel();
      const blocked=new Promise(resolve=>{channel.port1.onmessage=event=>resolve(event.data);setTimeout(()=>resolve(false),10000)});
      registration.active.postMessage('check',[channel.port2]);
      try {await fetch('https://127.0.0.1:${state.tlsPort}/private');return false}catch{return await blocked}
    })()`)
    const redirectBlocked = await rejected('https://www.zhipin.com/redirect')
    const localBlocked = await rejected(`http://127.0.0.1:${state.proxyPort}/private`)
    await s.closeAllConnections()
    state.private = true
    const before = state.dialed.length
    const reboundBlocked = await rejected('https://www.zhipin.com/rebound')
    const noPrivateDial = state.dialed.length === before
    state.private = false
    await s.closeAllConnections()
    await session.defaultSession.setProxy({
      mode: 'fixed_servers',
      proxyRules: `http://127.0.0.1:${state.proxyPort}`,
    })
    const proxied = await (
      await s.fetch('https://www.zhipin.com/proxied', { cache: 'no-store' })
    ).text()
    await s.closeAllConnections()
    await session.defaultSession.setProxy({
      mode: 'fixed_servers',
      proxyRules: 'socks5://127.0.0.1:1',
    })
    const unsupportedProxyBlocked = await rejected('https://www.zhipin.com/unsupported-proxy')
    win.destroy()
    return {
      certRejected,
      text,
      renderer,
      redirectBlocked,
      localBlocked,
      reboundBlocked,
      noPrivateDial,
      proxied,
      unsupportedProxyBlocked,
      authorities: state.authorities,
      dialed: state.dialed,
      privateRequests: state.privateRequests,
      tlsPrivateRequests: state.requests.filter((url) => url === '/private').length,
    }
  }, root)
  for (const key of [
    'certRejected',
    'renderer',
    'redirectBlocked',
    'localBlocked',
    'reboundBlocked',
    'noPrivateDial',
    'unsupportedProxyBlocked',
  ])
    assert.equal(result[key], true, key)
  assert.match(result.text, /public connection/)
  assert.match(result.proxied, /public connection/)
  assert.equal(result.privateRequests, 0)
  assert.equal(result.tlsPrivateRequests, 0)
  assert.ok(result.dialed.length > 0)
  assert.ok(result.dialed.every((target) => target.host === '8.8.8.8' && target.port === 443))
  assert.ok(result.authorities.length > 0)
  assert.ok(result.authorities.every((authority) => authority === '8.8.8.8:443'))
  console.log(
    'Packaged discovery connection policy passed: TLS, Session fetch, renderer, redirects, rebinding, HTTP proxy and fail-closed proxy policy',
  )
} finally {
  await application?.close()
  assert.equal(path.dirname(staging), path.join(project, 'dist'))
  assert.ok(path.basename(staging).startsWith('.discovery-network-'))
  fs.rmSync(staging, { recursive: true, force: true })
}
