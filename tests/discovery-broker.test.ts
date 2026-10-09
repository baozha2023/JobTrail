import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import {
  DiscoveryBrokerClient,
  startDiscoveryBroker,
  brokerPipe,
} from '../src/main/discovery/broker'
import type { DiscoveryLive } from '../src/main/discovery/service'
import { AppServiceError } from '../src/main/services/errors'
import { captureError } from '../src/main/diagnostics'
vi.mock('../src/main/diagnostics', async (original) => ({
  ...(await original<typeof import('../src/main/diagnostics')>()),
  captureError: vi.fn(),
}))

const roots: string[] = [],
  closers: (() => Promise<void>)[] = [],
  clients: DiscoveryBrokerClient[] = []
afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  for (const close of closers.splice(0)) await close()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})
async function fixture(enabled = () => true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-broker-'))
  roots.push(root)
  const status = vi.fn().mockResolvedValue([])
  const runtime = {
    status,
    start: vi.fn(),
    continue: vi.fn(),
    cancel: vi.fn(),
    detail: vi.fn(),
    browser: vi.fn(),
    qrLogin: vi.fn(),
    verification: vi.fn(),
    region: vi.fn(),
  } as DiscoveryLive
  closers.push(await startDiscoveryBroker(root, runtime, enabled))
  const client = new DiscoveryBrokerClient(root)
  clients.push(client)
  return { root, status, runtime, client }
}
function raw(root: string, overrides: Record<string, unknown>) {
  const descriptor = JSON.parse(
    fs.readFileSync(path.join(root, '.runtime', 'state', 'discovery-broker.json'), 'utf8'),
  )
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    let text = ''
    const socket = net.createConnection(brokerPipe(root))
    socket.once('connect', () =>
      socket.write(
        JSON.stringify({
          ...descriptor,
          request: { method: 'status', args: [false] },
          ...overrides,
        }) + '\n',
      ),
    )
    socket.on('data', (data) => (text += data.toString()))
    socket.on('end', () => resolve(JSON.parse(text)))
    socket.on('error', reject)
  })
}
it('serves concurrent clients over an installation-bound pipe and removes boot credentials on exit', async () => {
  const { root, client, status } = await fixture()
  await Promise.all([client.status(false), client.status(true)])
  expect(status).toHaveBeenCalledTimes(2)
  expect(brokerPipe(root)).not.toBe(brokerPipe(root + '2'))
  const close = closers.pop()!
  await close()
  expect(fs.existsSync(path.join(root, '.runtime', 'state', 'discovery-broker.json'))).toBe(false)
})
it('rejects bad tokens, protocol/root drift and browser/script methods before dispatch', async () => {
  const { root, status } = await fixture()
  for (const overrides of [
    { token: '0'.repeat(64) },
    { protocol: 99 },
    { root: 'another-installation' },
    { request: { method: 'browser', args: [{ action: 'open', url: 'file:///private' }] } },
    { request: { method: 'executeJavaScript', args: ['document.cookie'] } },
    { request: { method: 'enrich', args: ['11111111-1111-4111-8111-111111111111'] } },
  ])
    expect(await raw(root, overrides)).toMatchObject({ ok: false })
  expect(status).not.toHaveBeenCalled()
})
it('honors MCP disablement at dispatch time', async () => {
  let enabled = true
  const { client, status } = await fixture(() => enabled)
  await client.status(false)
  enabled = false
  await expect(client.status(true)).rejects.toMatchObject({ code: 'DISCOVERY_FAILED' })
  expect(status).toHaveBeenCalledTimes(1)
})
it('records the original desktop failure before returning a fixed broker error', async () => {
  const { client, status } = await fixture()
  const error = new Error('status failed')
  status.mockRejectedValueOnce(error)
  await expect(client.status(true)).rejects.toMatchObject({ code: 'DISCOVERY_FAILED' })
  expect(captureError).toHaveBeenCalledWith(error, {
    operation: 'discovery.broker.dispatch',
    level: 'warn',
  })
})
it('preserves confirmed delisting for MCP without restarting the desktop', async () => {
  const { client, runtime } = await fixture()
  vi.mocked(runtime.detail).mockRejectedValue(
    new AppServiceError('DISCOVERY_JOB_OFFLINE', 'Job offline'),
  )
  await expect(
    client.detail({ jobId: 'removed-job', mode: 'refresh' as const }),
  ).rejects.toMatchObject({
    code: 'DISCOVERY_JOB_OFFLINE',
  })
  expect(runtime.detail).toHaveBeenCalledOnce()
})
it('preserves runtime errors when the broker becomes available on the connection retry', async () => {
  const { client, runtime } = await fixture()
  vi.mocked(runtime.detail).mockRejectedValue(
    new AppServiceError('DISCOVERY_JOB_OFFLINE', 'Job offline'),
  )
  const descriptor = vi.spyOn(fs, 'readFileSync').mockImplementationOnce(() => {
    throw new Error('descriptor_not_ready')
  })
  try {
    await expect(client.detail({ jobId: 'removed-job', mode: 'refresh' })).rejects.toMatchObject({
      code: 'DISCOVERY_JOB_OFFLINE',
    })
    expect(runtime.detail).toHaveBeenCalledOnce()
  } finally {
    descriptor.mockRestore()
  }
})
it('refuses live calls during update freeze without starting a desktop process', async () => {
  const { client, root, status } = await fixture()
  fs.writeFileSync(path.join(root, '.runtime', 'state', 'update-freeze'), '')
  await expect(client.status(true)).rejects.toMatchObject({ code: 'PERSISTENCE_BUSY' })
  expect(status).not.toHaveBeenCalled()
})
it('decodes a Chinese search condition split inside a UTF-8 character', async () => {
  const { root, runtime } = await fixture()
  vi.mocked(runtime.start).mockResolvedValue({ id: 'received' } as Awaited<
    ReturnType<DiscoveryLive['start']>
  >)
  const descriptor = JSON.parse(
    fs.readFileSync(path.join(root, '.runtime/state/discovery-broker.json'), 'utf8'),
  )
  const query = { keyword: '开发工程师', city: '北京', platforms: ['boss'] }
  const bytes = Buffer.from(
    JSON.stringify({
      ...descriptor,
      request: { method: 'start', args: [{ requestId: 'split', query }] },
    }) + '\n',
  )
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection(brokerPipe(root))
    socket.on('error', reject)
    socket.once('connect', () => {
      const boundary = bytes.indexOf(Buffer.from('开发')) + 1
      socket.write(bytes.subarray(0, boundary))
      setTimeout(() => socket.end(bytes.subarray(boundary)), 20)
    })
    socket.on('data', () => {})
    socket.on('end', resolve)
  })
  expect(runtime.start).toHaveBeenCalledWith({ requestId: 'split', query })
})
it('decodes response text split inside a UTF-8 character', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-broker-'))
  roots.push(root)
  fs.mkdirSync(path.join(root, '.runtime/state'), { recursive: true })
  fs.writeFileSync(path.join(root, '.runtime/state/discovery-broker.json'), '{}')
  const server = net.createServer((socket) => {
    socket.once('data', () => {
      const bytes = Buffer.from(
        JSON.stringify({ ok: true, result: [{ evidence: '已登录' }] }) + '\n',
      )
      const boundary = bytes.indexOf(Buffer.from('已登录')) + 1
      socket.write(bytes.subarray(0, boundary))
      setTimeout(() => socket.end(bytes.subarray(boundary)), 20)
    })
  })
  await new Promise<void>((resolve) => server.listen(brokerPipe(root), resolve))
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const client = new DiscoveryBrokerClient(root)
  clients.push(client)
  expect(await client.status()).toEqual([{ evidence: '已登录' }])
})
it('does not reconnect or relaunch after a client is closed during an in-flight call', async () => {
  const { client, status } = await fixture()
  let release!: () => void
  status.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      }),
  )
  const request = client.status()
  const rejected = expect(request).rejects.toMatchObject({ code: 'DISCOVERY_UNAVAILABLE' })
  await vi.waitFor(() => expect(status).toHaveBeenCalledOnce())
  client.close()
  await rejected
  release()
  await expect(client.status()).rejects.toMatchObject({ code: 'DISCOVERY_UNAVAILABLE' })
  expect(status).toHaveBeenCalledOnce()
})
