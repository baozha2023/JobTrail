import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import type { Duplex } from 'node:stream'
import type { Session } from 'electron'
import { WebNetwork, validateWebUrl } from '../services/web-network'
import { AppServiceError } from '../services/errors'
import { captureError } from '../diagnostics'
import { bounded } from './search-page'

function blocked(): AppServiceError {
  return new AppServiceError('WEB_BLOCKED', 'Discovery connection policy rejected the request')
}

function headers(input: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const denied = new Set([
    'connection',
    'proxy-connection',
    'proxy-authorization',
    'proxy-authenticate',
    'keep-alive',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    ...(input.connection ?? '').split(',').map((v) => v.trim().toLowerCase()),
  ])
  return Object.fromEntries(Object.entries(input).filter(([key]) => !denied.has(key)))
}

/** A local forward proxy pins every destination, without decrypting Chromium TLS. */
export class DiscoveryNetwork {
  private server?: http.Server
  private listening?: Promise<number>
  private prepared = new Map<Session, Promise<void>>()
  private sockets = new Set<Duplex>()
  private controller = new AbortController()

  constructor(
    private resolveProxy: (url: string) => Promise<string>,
    private network = new WebNetwork(),
  ) {}

  async prepare(session: Session): Promise<void> {
    let ready = this.prepared.get(session)
    if (!ready) {
      ready = this.listen().then(async (port) => {
        this.controller.signal.throwIfAborted()
        await session.setProxy({
          mode: 'fixed_servers',
          proxyRules: `http://127.0.0.1:${port}`,
          // Chromium otherwise bypasses proxies for loopback destinations.
          proxyBypassRules: '<-loopback>',
        })
        await session.closeAllConnections()
      })
      this.prepared.set(session, ready)
      void ready.catch(() => {
        if (this.prepared.get(session) === ready) this.prepared.delete(session)
      })
    }
    return ready
  }

  private track(socket: Duplex): void {
    this.sockets.add(socket)
    socket.once('close', () => this.sockets.delete(socket))
    // Connection failures are reported by the owning request, never as unhandled events.
    socket.on('error', () => socket.destroy())
  }

  private listen(): Promise<number> {
    if (this.listening) return this.listening
    this.controller = new AbortController()
    const server = http.createServer({ maxHeaderSize: 16384 }, (request, response) => {
      void this.forward(request, response).catch((error) => {
        this.report(error)
        if (!response.headersSent) response.writeHead(502)
        response.end()
      })
    })
    this.server = server
    server.maxConnections = 256
    server.headersTimeout = 15000
    server.requestTimeout = 120000
    server.on('connection', (socket) => {
      this.track(socket)
      socket.setTimeout(120000, () => socket.destroy())
    })
    server.on('connect', (request, client, head) => {
      void this.tunnel(request, client, head).catch((error) => {
        this.report(error)
        if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
      })
    })
    server.on('upgrade', (_request, socket) => socket.destroy())
    server.on('clientError', (_error, socket) => socket.destroy())
    this.listening = new Promise<number>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        resolve((server.address() as net.AddressInfo).port)
      })
    })
    return this.listening
  }

  private report(error: unknown): void {
    if (!this.controller.signal.aborted)
      captureError(error, { operation: 'discovery.connection', level: 'warn' })
  }

  private async connect(url: URL, client: Duplex): Promise<Duplex> {
    const cancelled = new AbortController()
    const abort = () => cancelled.abort()
    client.once('close', abort)
    const signal = AbortSignal.any([
      this.controller.signal,
      cancelled.signal,
      AbortSignal.timeout(15000),
    ])
    let cancelDial = () => {}
    const abortDial = () => cancelDial()
    signal.addEventListener('abort', abortDial, { once: true })
    try {
      if (client.destroyed) throw blocked()
      const address = await this.network.resolvePublicUrl(url.href, signal)
      const policy = (await bounded(this.resolveProxy(url.href), signal)).split(';')[0].trim()
      signal.throwIfAborted()
      const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
      let socket: Duplex
      if (policy === 'DIRECT') {
        socket = await new Promise<net.Socket>((resolve, reject) => {
          // A numeric host prevents a second DNS lookup after validation.
          const connection = net.createConnection({
            host: address.address,
            port,
            family: address.family,
          })
          cancelDial = () => connection.destroy(blocked())
          this.track(connection)
          connection.once('connect', () => resolve(connection))
          connection.once('error', reject)
        })
      } else {
        // Honor the selected system/PAC proxy. Never fall back to DIRECT or ask
        // an upstream proxy to resolve the untrusted destination hostname.
        const match = /^(PROXY|HTTPS) (\[[\da-f:]+\]|[\w.-]+):(\d{1,5})$/i.exec(policy)
        if (!match || Number(match[3]) < 1 || Number(match[3]) > 65535) throw blocked()
        const target =
          address.family === 6 ? `[${address.address}]:${port}` : `${address.address}:${port}`
        socket = await new Promise<Duplex>((resolve, reject) => {
          const transport = match[1].toUpperCase() === 'HTTPS' ? https : http
          const request = transport.request({
            hostname: match[2].replace(/^\[|\]$/g, ''),
            port: Number(match[3]),
            method: 'CONNECT',
            path: target,
            headers: { Host: target },
            agent: false,
          })
          cancelDial = () => request.destroy(blocked())
          request.once('socket', (connection) => this.track(connection))
          request.once('error', reject)
          request.once('connect', (response, connection, head) => {
            if (response.statusCode !== 200 || head.length) {
              connection.destroy()
              reject(blocked())
            } else resolve(connection)
          })
          request.end()
        })
      }
      // The dial timeout bounds connection establishment, not a long-lived TLS tunnel.
      const disconnect = () => socket.destroy()
      client.once('close', disconnect)
      socket.once('close', () => client.removeListener('close', disconnect))
      return socket
    } finally {
      client.removeListener('close', abort)
      signal.removeEventListener('abort', abortDial)
    }
  }

  private async tunnel(request: http.IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    const authority = request.url ?? ''
    if (!/^(?:\[[\da-f:]+\]|[\w.-]+):443$/i.test(authority)) throw blocked()
    const url = validateWebUrl(`https://${authority}/`)
    const upstream = await this.connect(url, client)
    if (client.destroyed) return void upstream.destroy()
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head.length) upstream.write(head)
    upstream.once('close', () => client.destroy())
    client.pipe(upstream).pipe(client)
  }

  private async forward(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const url = validateWebUrl(request.url ?? '')
    if (url.protocol !== 'http:' || (url.port && url.port !== '80')) throw blocked()
    const connection = await this.connect(url, request.socket)
    if (request.destroyed) return void connection.destroy()
    const agent = new http.Agent({ keepAlive: false })
    agent.createConnection = () => connection as net.Socket
    const outgoing = http.request(url, {
      method: request.method,
      headers: { ...headers(request.headers), host: url.host },
      agent,
    })
    response.once('close', () => {
      outgoing.destroy()
      agent.destroy()
    })
    outgoing.once('error', (error) => {
      this.report(error)
      if (!response.headersSent) response.writeHead(502)
      response.end()
    })
    outgoing.once('response', (incoming) => {
      response.writeHead(incoming.statusCode ?? 502, headers(incoming.headers))
      incoming.once('error', () => response.destroy())
      incoming.pipe(response)
    })
    request.pipe(outgoing)
  }

  async close(): Promise<void> {
    this.controller.abort()
    for (const socket of this.sockets) socket.destroy()
    const server = this.server
    if (server) {
      await this.listening?.catch(() => {})
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    this.server = undefined
    this.listening = undefined
    this.prepared.clear()
  }
}
