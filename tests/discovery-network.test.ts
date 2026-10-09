import http from 'node:http'
import net from 'node:net'
import type { Session } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'
import { DiscoveryNetwork } from '../src/main/discovery/network'
import { WebNetwork } from '../src/main/services/web-network'

vi.mock('../src/main/diagnostics', () => ({ captureError: vi.fn() }))
const connect = net.createConnection.bind(net)
const networks: DiscoveryNetwork[] = []
const servers: net.Server[] = []
const sockets: net.Socket[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const socket of sockets.splice(0)) socket.destroy()
  await Promise.all(networks.splice(0).map((network) => network.close()))
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  )
})
async function listen(server: net.Server): Promise<number> {
  servers.push(server)
  server.on('connection', (socket) => sockets.push(socket))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as net.AddressInfo).port
}
async function fixture(policy = async (_url: string) => 'DIRECT', addresses = ['8.8.8.8']) {
  const resolve = vi.fn(async () =>
    addresses.map((address) => ({ address, family: net.isIP(address) })),
  )
  const network = new DiscoveryNetwork(policy, new WebNetwork(resolve))
  networks.push(network)
  let port = 0
  const setProxy = vi.fn(async (config: Electron.ProxyConfig) => {
    expect(config.mode).toBe('fixed_servers')
    expect(config.proxyBypassRules).toBe('<-loopback>')
    expect(config.proxyRules).not.toContain('direct')
    port = Number(new URL(config.proxyRules!).port)
  })
  const closeAllConnections = vi.fn(async () => {})
  const session = { setProxy, closeAllConnections } as unknown as Session
  await network.prepare(session)
  return {
    network,
    session,
    resolve,
    setProxy,
    closeAllConnections,
    get port() {
      return port
    },
  }
}
async function tunnel(port: number, target = 'public.example:443') {
  const socket = connect(port, '127.0.0.1')
  sockets.push(socket)
  let buffer = ''
  const status = await new Promise<string>((resolve, reject) => {
    socket.once('error', reject)
    socket.once('connect', () =>
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`),
    )
    const data = (chunk: Buffer) => {
      buffer += chunk.toString()
      if (buffer.includes('\r\n\r\n')) {
        socket.removeListener('data', data)
        resolve(buffer)
      }
    }
    socket.on('data', data)
  })
  return { socket, status }
}
function request(port: number, url: string, options: http.RequestOptions = {}, body = '') {
  return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>(
    (resolve, reject) => {
      const agent = new http.Agent({ keepAlive: false })
      agent.createConnection = () => connect(port, '127.0.0.1')
      const outgoing = http.request(
        { host: '127.0.0.1', port, path: url, agent, ...options },
        (response) => {
          let text = ''
          response.on('data', (chunk) => (text += chunk))
          response.once('end', () =>
            resolve({ status: response.statusCode!, body: text, headers: response.headers }),
          )
        },
      )
      outgoing.once('error', reject)
      outgoing.end(body)
    },
  )
}

it('pins the checked numeric address and rejects a private DNS answer on the next connection', async () => {
  const echo = await listen(net.createServer((socket) => socket.pipe(socket)))
  const dial = vi.spyOn(net, 'createConnection').mockImplementation((...args: unknown[]) => {
    expect(args[0]).toMatchObject({ host: '8.8.8.8', port: 443, family: 4 })
    return connect(echo, '127.0.0.1')
  })
  const f = await fixture()
  const first = await tunnel(f.port)
  expect(first.status).toContain('200 Connection Established')
  expect(f.resolve).toHaveBeenCalledExactlyOnceWith('public.example')
  const echoed = new Promise<Buffer>((resolve) => first.socket.once('data', resolve))
  first.socket.write('opaque TLS bytes')
  expect((await echoed).toString()).toBe('opaque TLS bytes')
  first.socket.destroy()
  f.resolve.mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }])
  expect((await tunnel(f.port)).status).toContain('502')
  expect(dial).toHaveBeenCalledTimes(1)
})

it.each(['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', '::ffff:127.0.0.1'])(
  'rejects mixed public/private answers containing %s before opening a connection',
  async (address) => {
    const f = await fixture(undefined, ['8.8.8.8', address])
    const dial = vi.spyOn(net, 'createConnection')
    expect((await tunnel(f.port)).status).toContain('502')
    expect(dial).not.toHaveBeenCalled()
  },
)

it('streams HTTP bodies, preserves cookies and host, and checks each redirected destination', async () => {
  const upstream = await listen(
    http.createServer((req, res) => {
      expect(req.headers.host).toBe('public.example')
      expect(req.headers['proxy-authorization']).toBeUndefined()
      expect(req.headers['x-private-hop']).toBeUndefined()
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        res.writeHead(302, {
          location: 'http://127.0.0.1/private',
          'set-cookie': 'session=synthetic; HttpOnly',
        })
        res.end(body)
      })
    }),
  )
  const dial = vi.spyOn(net, 'createConnection').mockImplementation((...args: unknown[]) => {
    expect(args[0]).toMatchObject({ host: '8.8.8.8', port: 80 })
    return connect(upstream, '127.0.0.1')
  })
  const f = await fixture()
  const result = await request(
    f.port,
    'http://public.example/path',
    {
      method: 'POST',
      headers: {
        'proxy-authorization': 'secret',
        connection: 'x-private-hop',
        'x-private-hop': 'hidden',
      },
    },
    'form=value',
  )
  expect(result.body).toBe('form=value')
  expect(result.headers['set-cookie']).toEqual(['session=synthetic; HttpOnly'])
  expect((await request(f.port, result.headers.location!)).status).toBe(502)
  expect(dial).toHaveBeenCalledTimes(1)
})

it('sends only the checked IP to the configured HTTP proxy and tunnels bytes unchanged', async () => {
  const upstream = http.createServer()
  const authorities: string[] = []
  upstream.on('connect', (req, socket) => {
    authorities.push(req.url!)
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    socket.pipe(socket)
  })
  const port = await listen(upstream)
  const f = await fixture(async () => `PROXY 127.0.0.1:${port}; DIRECT`)
  const result = await tunnel(f.port)
  expect(result.status).toContain('200')
  expect(authorities).toEqual(['8.8.8.8:443'])
  const received = new Promise<Buffer>((resolve) => result.socket.once('data', resolve))
  result.socket.write('unchanged')
  expect((await received).toString()).toBe('unchanged')
})

it('releases upstream close listeners between HTTP requests on one persistent client connection', async () => {
  const upstream = await listen(http.createServer((_req, res) => res.end('ok')))
  vi.spyOn(net, 'createConnection').mockImplementation(() => connect(upstream, '127.0.0.1'))
  const f = await fixture()
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })
  agent.createConnection = () => connect(f.port, '127.0.0.1')
  const warning = vi.fn()
  process.on('warning', warning)
  try {
    for (let i = 0; i < 15; i++) {
      expect((await request(f.port, 'http://public.example/', { agent })).body).toBe('ok')
    }
    expect(
      warning.mock.calls.filter(([error]) => error.name === 'MaxListenersExceededWarning'),
    ).toEqual([])
  } finally {
    agent.destroy()
    process.removeListener('warning', warning)
  }
})

it('fails closed on proxy authentication failure without falling back to direct', async () => {
  const upstream = http.createServer()
  upstream.on('connect', (_req, socket) =>
    socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'),
  )
  const port = await listen(upstream)
  const f = await fixture(async () => `PROXY 127.0.0.1:${port}; DIRECT`)
  const dial = vi.spyOn(net, 'createConnection')
  expect((await tunnel(f.port)).status).toContain('502')
  expect(dial).toHaveBeenCalledTimes(1)
  expect(dial.mock.calls[0][0]).toMatchObject({ hostname: '127.0.0.1', port })
})

it.each(['SOCKS5 localhost:1080; DIRECT', '', 'PROXY localhost:0', 'PROXY localhost:99999'])(
  'rejects unsupported system proxy policy %s without direct fallback',
  async (policy) => {
    const f = await fixture(async () => policy)
    const dial = vi.spyOn(net, 'createConnection')
    expect((await tunnel(f.port)).status).toContain('502')
    expect(dial).not.toHaveBeenCalled()
  },
)

it.each([
  'localhost:80',
  'public.example:8443',
  'user@public.example:443',
  'public.example:443/path',
])('rejects unsupported tunnel authority %s', async (authority) => {
  const f = await fixture()
  expect((await tunnel(f.port, authority)).status).toContain('502')
  expect(f.resolve).not.toHaveBeenCalled()
})

it('drains sockets during shutdown and configures a fresh listener when resumed', async () => {
  const f = await fixture()
  await Promise.all([f.network.prepare(f.session), f.network.prepare(f.session)])
  expect(f.setProxy).toHaveBeenCalledTimes(1)
  expect(f.closeAllConnections).toHaveBeenCalledTimes(1)
  const socket = connect(f.port, '127.0.0.1')
  sockets.push(socket)
  await new Promise<void>((resolve) => socket.once('connect', resolve))
  const closed = new Promise<void>((resolve) => socket.once('close', resolve))
  await f.network.close()
  await closed
  await f.network.prepare(f.session)
  expect(f.setProxy).toHaveBeenCalledTimes(2)
  expect((await tunnel(f.port, '127.0.0.1:443')).status).toContain('502')
})
