import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { spawn } from 'node:child_process'
import { z } from 'zod'
import type { DiscoveryLive } from './service'
import { startSearchSchema, jobDetailSchema } from '../../shared/job-discovery'
import { ROOT_LAUNCHER } from '../installation-paths'
import { AppServiceError } from '../services/errors'
import { isUpdateFrozen } from '../update-freeze'
import { captureError, recordEvent } from '../diagnostics'

const protocol = 1
const rootKey = (root: string) =>
  createHash('sha256').update(path.resolve(root).toLowerCase()).digest('hex').slice(0, 24)
export const brokerPipe = (root: string) => `\\\\.\\pipe\\jobtrail-discovery-${rootKey(root)}`
const descriptorFile = (root: string) =>
  path.join(root, '.runtime', 'state', 'discovery-broker.json')
const requestSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('status'), args: z.tuple([z.boolean().optional()]) }),
  z.object({ method: z.literal('start'), args: z.tuple([startSearchSchema]) }),
  z.object({ method: z.literal('continue'), args: z.tuple([z.string().uuid()]) }),
  z.object({ method: z.literal('cancel'), args: z.tuple([z.string().uuid()]) }),
  z.object({
    method: z.literal('detail'),
    args: z.tuple([jobDetailSchema]),
  }),
])
export async function startDiscoveryBroker(
  root: string,
  runtime: DiscoveryLive,
  enabled: () => boolean,
): Promise<() => Promise<void>> {
  const token = randomBytes(32).toString('hex'),
    sockets = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8')
    sockets.add(socket)
    socket.setTimeout(120000, () => socket.destroy())
    socket.once('close', () => sockets.delete(socket))
    let buffer = '',
      received = false
    socket.on('error', (error) => {
      captureError(error, { operation: 'discovery.broker.socket', level: 'warn' })
    })
    socket.on('data', (chunk) => {
      if (received) return socket.destroy()
      buffer += chunk.toString('utf8')
      if (Buffer.byteLength(buffer) > 32768) return socket.destroy()
      const end = buffer.indexOf('\n')
      if (end < 0) return
      received = true
      void (async () => {
        const envelope = z
          .object({
            protocol: z.literal(protocol),
            root: z.literal(rootKey(root)),
            token: z.string().length(64),
            request: requestSchema,
          })
          .parse(JSON.parse(buffer.slice(0, end)))
        if (
          !timingSafeEqual(Buffer.from(envelope.token), Buffer.from(token)) ||
          !enabled() ||
          isUpdateFrozen(root)
        )
          throw new AppServiceError('DISCOVERY_UNAVAILABLE', 'Discovery broker unavailable')
        const req = envelope.request
        const result =
          req.method === 'detail'
            ? await runtime.detail(req.args[0])
            : req.method === 'start'
              ? await runtime.start(req.args[0])
              : req.method === 'status'
                ? await runtime.status(req.args[0])
                : req.method === 'continue'
                  ? await runtime.continue(req.args[0])
                  : await runtime.cancel(req.args[0])
        if (!socket.destroyed) socket.end(JSON.stringify({ ok: true, result }) + '\n')
      })().catch((error) => {
        captureError(error, { operation: 'discovery.broker.dispatch', level: 'warn' })
        if (!socket.destroyed)
          socket.end(
            JSON.stringify({
              ok: false,
              code: error instanceof AppServiceError ? error.code : 'DISCOVERY_FAILED',
            }) + '\n',
          )
      })
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(brokerPipe(root), resolve)
  })
  const file = descriptorFile(root)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = file + '.' + process.pid
  fs.writeFileSync(
    temporary,
    JSON.stringify({ protocol, root: rootKey(root), token, pid: process.pid }),
    { mode: 0o600 },
  )
  fs.renameSync(temporary, file)
  return async () => {
    try {
      if (JSON.parse(fs.readFileSync(file, 'utf8')).token === token) fs.unlinkSync(file)
    } catch (error) {
      /* A stale descriptor cannot authenticate. */
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        captureError(error, { operation: 'discovery.broker.cleanup', level: 'warn' })
    }
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
export class DiscoveryBrokerClient implements DiscoveryLive {
  private boot?: Promise<void>
  private closed = false
  private sockets = new Set<net.Socket>()
  constructor(private root: string) {}
  private assertOpen() {
    if (this.closed)
      throw new AppServiceError('DISCOVERY_UNAVAILABLE', 'Discovery client is closed')
  }
  private async connect(method: string, args: unknown[]): Promise<unknown> {
    this.assertOpen()
    if (isUpdateFrozen(this.root))
      throw new AppServiceError('PERSISTENCE_BUSY', 'Data maintenance in progress')
    const send = () =>
      new Promise<unknown>((resolve, reject) => {
        let descriptor: { protocol: number; root: string; token: string }
        try {
          descriptor = JSON.parse(fs.readFileSync(descriptorFile(this.root), 'utf8'))
        } catch (error) {
          reject(new Error('broker_offline', { cause: error }))
          return
        }
        const socket = net.createConnection(brokerPipe(this.root))
        socket.setEncoding('utf8')
        this.sockets.add(socket)
        let buffer = '',
          settled = false
        const fail = (error: Error) => {
          if (!settled) {
            settled = true
            reject(error)
          }
          socket.destroy()
        }
        socket.setTimeout(110000, () => fail(new Error('broker_timeout')))
        socket.once('error', fail)
        socket.once('close', () => {
          this.sockets.delete(socket)
          if (!settled) fail(new Error('broker_disconnected'))
        })
        socket.once('connect', () =>
          socket.write(JSON.stringify({ ...descriptor, request: { method, args } }) + '\n'),
        )
        socket.on('data', (chunk) => {
          buffer += chunk.toString('utf8')
          if (Buffer.byteLength(buffer) > 2_000_000) return fail(new Error('broker_size_limit'))
          if (!buffer.includes('\n')) return
          try {
            const response = JSON.parse(buffer.slice(0, buffer.indexOf('\n')))
            settled = true
            socket.end()
            if (response.ok) resolve(response.result)
            else
              reject(
                new AppServiceError(
                  response.code === 'PERSISTENCE_BUSY' || response.code === 'DISCOVERY_JOB_OFFLINE'
                    ? response.code
                    : 'DISCOVERY_FAILED',
                  'Discovery runtime rejected request',
                ),
              )
          } catch (error) {
            fail(new Error('broker_invalid_response', { cause: error }))
          }
        })
      })
    try {
      return await send()
    } catch (error) {
      this.assertOpen()
      if (error instanceof AppServiceError) throw error
      if (
        error instanceof Error &&
        ['broker_timeout', 'broker_size_limit', 'broker_invalid_response'].includes(error.message)
      )
        throw new AppServiceError(
          'DISCOVERY_UNAVAILABLE',
          'Existing discovery runtime did not return a valid response',
          undefined,
          { cause: error },
        )
      if (error instanceof Error && (error.cause as NodeJS.ErrnoException)?.code === 'ENOENT')
        recordEvent({ operation: 'discovery.broker.startup' })
      else captureError(error, { operation: 'discovery.broker.reconnect', level: 'warn' })
      await this.ensureDesktop()
      try {
        return await send()
      } catch (error) {
        if (error instanceof AppServiceError) throw error
        throw new AppServiceError(
          'DISCOVERY_UNAVAILABLE',
          'Unable to connect to desktop discovery runtime',
          undefined,
          { cause: error },
        )
      }
    }
  }
  private async ensureDesktop() {
    if (this.boot) return this.boot
    this.boot = this.launch().finally(() => {
      this.boot = undefined
    })
    return this.boot
  }
  private async launch() {
    this.assertOpen()
    // Recheck after a failed request: an existing desktop always takes precedence.
    if (await this.reachable()) return
    const lock = path.join(this.root, '.runtime', 'state', 'discovery-start.lock')
    fs.mkdirSync(path.dirname(lock), { recursive: true })
    let owner = false
    try {
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' })
      owner = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
        captureError(error, { operation: 'discovery.broker.start-lock', level: 'warn' })
      try {
        const prior = JSON.parse(fs.readFileSync(lock, 'utf8'))
        let alive = true
        try {
          process.kill(prior.pid, 0)
        } catch {
          alive = false
        }
        if (!alive || Date.now() - prior.at > 40000) {
          fs.unlinkSync(lock)
          fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }), {
            flag: 'wx',
          })
          owner = true
        }
      } catch (error) {
        /* Another client owns startup. */
        if (!['ENOENT', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? ''))
          captureError(error, { operation: 'discovery.broker.start-lock', level: 'warn' })
      }
    }
    try {
      if (owner && !(await this.reachable())) {
        this.assertOpen()
        const launcher = path.join(this.root, ROOT_LAUNCHER),
          packaged = fs.existsSync(launcher)
        const env = { ...process.env }
        delete env.ELECTRON_RUN_AS_NODE
        const child = spawn(
          packaged ? launcher : process.execPath,
          packaged ? ['--discovery-background'] : [this.root, '--discovery-background'],
          { cwd: this.root, env, windowsHide: true, detached: true, stdio: 'ignore' },
        )
        await new Promise<void>((resolve, reject) => {
          child.once('spawn', resolve)
          child.once('error', reject)
        })
        child.unref()
      }
      const deadline = Date.now() + 30000
      while (Date.now() < deadline) {
        this.assertOpen()
        if (isUpdateFrozen(this.root)) throw new Error('frozen')
        if (await this.reachable()) return
        await new Promise((r) => setTimeout(r, 300))
      }
      throw new Error('desktop_start_timeout')
    } finally {
      if (owner)
        try {
          fs.unlinkSync(lock)
        } catch (error) {
          /* Client exiting also releases the lease. */
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
            captureError(error, { operation: 'discovery.broker.cleanup', level: 'warn' })
        }
    }
  }
  private reachable(): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.createConnection(brokerPipe(this.root))
      const end = (result: boolean) => {
        socket.destroy()
        resolve(result)
      }
      socket.setTimeout(1000)
      socket.once('connect', () => end(true))
      socket.once('error', () => end(false))
      socket.once('timeout', () => end(false))
    })
  }
  async status(check = false) {
    return this.connect('status', [check]) as ReturnType<DiscoveryLive['status']>
  }
  async start(input: Parameters<DiscoveryLive['start']>[0]) {
    return this.connect('start', [input]) as ReturnType<DiscoveryLive['start']>
  }
  async continue(id: string) {
    return this.connect('continue', [id]) as ReturnType<DiscoveryLive['continue']>
  }
  async cancel(id: string) {
    return this.connect('cancel', [id]) as ReturnType<DiscoveryLive['cancel']>
  }
  async detail(input: Parameters<DiscoveryLive['detail']>[0]) {
    return this.connect('detail', [input]) as ReturnType<DiscoveryLive['detail']>
  }
  async qrLogin(): Promise<never> {
    throw new AppServiceError(
      'DISCOVERY_UNAVAILABLE',
      'QR login requires the desktop account dialog',
    )
  }
  async browser(): Promise<void> {
    throw new AppServiceError(
      'DISCOVERY_UNAVAILABLE',
      'Browser control is available only in the desktop UI',
    )
  }
  async verification(): Promise<never> {
    throw new AppServiceError('DISCOVERY_UNAVAILABLE', 'Verification requires the desktop UI')
  }
  async region(): Promise<void> {
    throw new AppServiceError(
      'DISCOVERY_UNAVAILABLE',
      'Browser control is available only in the desktop UI',
    )
  }
  close() {
    this.closed = true
    for (const socket of this.sockets) socket.destroy()
  }
}
