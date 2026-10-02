import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  Diagnostics,
  captureError,
  initializeDiagnostics,
  closeDiagnostics,
  runOperation,
  currentDiagnosticContext,
  withDiagnosticContext,
  flushDiagnostics,
  forwardDiagnosticStderr,
} from '../src/main/diagnostics'
import {
  createErrorInput,
  normalizeDiagnosticError,
  newDiagnosticContext,
  validateDiagnosticInput,
  redactDiagnosticText,
  registerDiagnosticSecrets,
  diagnosticReference,
  MAX_EVENT_BYTES,
} from '../src/shared/diagnostics'
import { maintainLogs } from '../src/main/diagnostics/storage'
import { diagnosticRecords } from './helpers/diagnostics'
const roots: string[] = [],
  instances: Diagnostics[] = []
function root() {
  const result = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrail-diagnostics-'))
  roots.push(result)
  return result
}
function runtime(directory = root(), packaged = true, options = {}) {
  const instance = new Diagnostics('main', '1.3.0', packaged, directory, options)
  instances.push(instance)
  return instance
}
afterEach(() => {
  closeDiagnostics()
  for (const item of instances.splice(0)) item.close()
  vi.restoreAllMocks()
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})
describe('diagnostic protocol and normalization', () => {
  it('retains unknown exception details and dependency stacks while removing credentials and machine paths', () => {
    registerDiagnosticSecrets(['test-key-123456'])
    const error = Object.assign(
      new Error('HTTP status: 403; apiKey=test-key-123456; failed to connect'),
      { cause: new Error('Connection reset'), code: 'ECONNRESET' },
    )
    error.stack =
      'Error: hidden\n at connect (C:\\Users\\name\\app\\node_modules\\sdk\\request.js:20:4)'
    const input = createErrorInput('main', 'network.request', error)
    expect(input).toMatchObject({
      code: 'SYSTEM_ERROR',
      error: { httpStatus: 403, cause: { message: 'Connection reset' } },
    })
    expect(input.error?.stack?.[0]).toContain('node_modules/sdk/request.js:20:4')
    expect(JSON.stringify(input)).not.toMatch(/test-key-123456|Users|name\\/)
    expect(validateDiagnosticInput(input)).not.toBeNull()
    expect(redactDiagnosticText('https://user:pass@example.com/api?token=hidden')).toBe(
      'https://example.com/api?[REDACTED]',
    )
  })
  it.each(['VALIDATION_ERROR', 'NOT_FOUND', 'EXAM_CONFLICT', 'AI_API_KEY_EMPTY'])(
    'accepts %s instead of filtering it',
    (code) => {
      const input = createErrorInput('main', 'ipc.exam', { code, message: 'Rejected operation' })
      expect(input.code).toBe(code)
      expect(validateDiagnosticInput(input)).not.toBeNull()
    },
  )
  it('handles non-Error values, cycles, AggregateError and dangerous getters without invoking them', () => {
    const getter = vi.fn(() => {
      throw new Error('must not run')
    })
    const hostile = Object.defineProperty({}, 'message', { get: getter })
    expect(normalizeDiagnosticError(hostile).unreadable).toBe(true)
    expect(getter).not.toHaveBeenCalled()
    const cyclic = new Error('outer')
    Object.assign(cyclic, { cause: cyclic })
    expect(normalizeDiagnosticError(cyclic).cause?.truncated).toBe(true)
    expect(
      normalizeDiagnosticError(
        new AggregateError([new Error('write'), new Error('rollback')], 'transaction'),
      ).errors,
    ).toHaveLength(2)
    expect(normalizeDiagnosticError('plain failure').message).toBe('plain failure')
    expect(normalizeDiagnosticError(new Error('x'.repeat(50000))).truncated).toBe(true)
    expect(
      normalizeDiagnosticError(new SyntaxError('Unexpected token in JSON: private answer')).message,
    ).not.toContain('private answer')
  })
  it('rejects untrusted fields and invalid references', () => {
    const input = createErrorInput('renderer', 'vue.component', new Error('failed'))
    expect(validateDiagnosticInput({ ...input, requestBody: 'private' })).toBeNull()
    expect(validateDiagnosticInput({ ...input, traceId: 'bad' })).toBeNull()
    expect(
      validateDiagnosticInput({ ...input, error: { ...input.error, request: 'private' } }),
    ).toBeNull()
  })
  it('does not execute getters in exception diagnostic references', () => {
    initializeDiagnostics('main', '1.4.0', true, root())
    const getter = vi.fn(() => {
      throw new Error('must not run')
    })
    const diagnostic = Object.defineProperty({}, 'traceId', { get: getter })
    const error = Object.assign(new Error('original failure'), { diagnostic })
    expect(diagnosticReference(error)).toBeUndefined()
    expect(() => captureError(error, { operation: 'hostile.reference' })).not.toThrow()
    expect(getter).not.toHaveBeenCalled()
    const safeFields = { ...newDiagnosticContext(), eventId: randomUUID() }
    Object.defineProperty(safeFields, 'parentSpanId', { get: getter })
    Object.defineProperty(safeFields, 'toJSON', { get: getter })
    const reference = diagnosticReference({ diagnostic: safeFields })
    expect(() => JSON.stringify(reference)).not.toThrow()
    expect(getter).not.toHaveBeenCalled()
  })
  it('bounds incoming events after redaction expands their text', () => {
    registerDiagnosticSecrets(['tiny'])
    const input = createErrorInput('renderer', 'incoming.error', new Error('failure'))
    input.error = {
      name: 'tiny'.repeat(30),
      message: 'tiny'.repeat(1000),
      stack: Array.from({ length: 20 }, () => 'tiny'.repeat(125)),
    }
    const parsed = validateDiagnosticInput(input)
    expect(parsed).not.toBeNull()
    expect(JSON.stringify(parsed)).not.toContain('tiny')
    expect(new TextEncoder().encode(JSON.stringify(parsed)).length).toBeLessThan(MAX_EVENT_BYTES)
    expect(validateDiagnosticInput(parsed)).not.toBeNull()
    expect(parsed?.error?.truncated).toBe(true)
  })
})
describe('diagnostic output', () => {
  it('writes development logs to both console and a versioned file, and deduplicates transport retries', () => {
    const directory = root(),
      stderr = vi.fn(),
      logger = runtime(directory, false, { stderr })
    const input = createErrorInput('main', 'ipc.exams.grade', {
      code: 'AI_API_KEY_EMPTY',
      message: 'Missing API key',
    })
    expect(logger.accept(input).status).toBe('written')
    expect(logger.accept(input).status).toBe('duplicate')
    expect(diagnosticRecords(directory)).toHaveLength(1)
    expect(stderr).toHaveBeenCalledOnce()
    expect(diagnosticRecords(directory)[0]).toMatchObject({
      schemaVersion: 1,
      code: 'AI_API_KEY_EMPTY',
      error: { message: 'Missing API key' },
    })
  })
  it('preserves request isolation and records the same Error in distinct operations', async () => {
    const directory = root()
    initializeDiagnostics('main', '1.3.0', true, directory)
    const error = new Error('request failed'),
      traces: string[] = []
    await Promise.all(
      [1, 2].map(async () => {
        await expect(
          runOperation({ operation: 'request.run' }, async () => {
            await Promise.resolve()
            traces.push(currentDiagnosticContext()!.traceId)
            captureError(error, { operation: 'request.inner' })
            throw error
          }),
        ).rejects.toBe(error)
      }),
    )
    flushDiagnostics()
    expect(new Set(traces).size).toBe(2)
    expect(diagnosticRecords(directory).filter((record) => record.kind === 'error')).toHaveLength(2)
  })
  it('keeps causes when a handled error is propagated within the same context', () => {
    const directory = root()
    initializeDiagnostics('main', '1.3.0', true, directory)
    const error = new Error('failure')
    withDiagnosticContext(newDiagnosticContext(), () => {
      const first = captureError(error, { operation: 'file.write' })
      expect(captureError(error, { operation: 'ipc.write' })).toEqual(first)
    })
    expect(diagnosticRecords(directory).filter((record) => record.kind === 'error')).toHaveLength(1)
  })
  it('records rejected cancellations as cancelled while preserving the original rejection', async () => {
    const directory = root()
    initializeDiagnostics('main', '1.4.0', true, directory)
    const error = Object.assign(new Error('Cancelled by user'), { name: 'AbortError' })
    await expect(
      runOperation({ operation: 'request.cancel' }, () => Promise.reject(error)),
    ).rejects.toBe(error)
    flushDiagnostics()
    const records = diagnosticRecords(directory).filter(
      (record) => record.operation === 'request.cancel',
    )
    expect(records.some((record) => record.outcome === 'cancelled')).toBe(true)
    expect(records.some((record) => record.outcome === 'failed')).toBe(false)
    expect(records.some((record) => record.kind === 'error')).toBe(false)
  })
  it('falls back and exposes degraded health when writes fail, then records recovery', () => {
    const directory = root(),
      stderr = vi.fn(),
      logger = runtime(directory, true, { stderr })
    const failing = vi.spyOn(fs, 'writeSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('full'), { code: 'ENOSPC' })
    })
    expect(logger.accept(createErrorInput('main', 'file.write', new Error('failure'))).status).toBe(
      'fallback',
    )
    expect(logger.writer.health).toMatchObject({ degraded: true, writeFailures: 1 })
    failing.mockRestore()
    logger.accept(createErrorInput('main', 'file.retry', new Error('retry')))
    expect(stderr).toHaveBeenCalledTimes(2)
    expect(stderr.mock.calls[1][0]).toContain('DIAGNOSTICS_WRITE_FAILED')
    expect(
      diagnosticRecords(directory).some((record) => record.operation === 'diagnostics.recovered'),
    ).toBe(true)
  })
  it('rotates without clearing previous segments and aggregates an error storm with counts', () => {
    const directory = root(),
      logger = runtime(directory, true, { segmentBytes: 2500 })
    for (let index = 0; index < 130; index++)
      logger.accept(createErrorInput('main', 'repeat.failure', new Error('same failure')))
    logger.writer.flush()
    const records = diagnosticRecords(directory)
    expect(
      fs.readdirSync(path.join(directory, 'logs')).filter((name) => name.endsWith('.closed.jsonl'))
        .length,
    ).toBeGreaterThan(0)
    expect(records.filter((record) => record.operation === 'repeat.failure')).toHaveLength(100)
    expect(
      records
        .filter((record) => record.operation === 'diagnostics.aggregate')
        .reduce((sum, record) => sum + (record.attributes?.count ?? 0), 0),
    ).toBe(30)
  })
  it('forwards complete validated child records without logging protocol stdout or raw stderr', () => {
    const directory = root(),
      logger = runtime(directory),
      stream = new PassThrough(),
      lines: string[] = []
    logger.accept(createErrorInput('agent', 'custom.new-operation', new Error('failure')))
    const record = { ...diagnosticRecords(directory)[0], process: 'agent' }
    forwardDiagnosticStderr(stream, (line) => lines.push(line))
    const encoded = JSON.stringify(record) + '\n'
    stream.write(encoded.slice(0, 40))
    stream.write(encoded.slice(40))
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]).operation).toBe('custom.new-operation')
  })
})
describe('old log removal', () => {
  it('deletes confirmed old files, preserves live, unknown and future files, and is repeatable', () => {
    const directory = root(),
      logs = path.join(directory, 'logs')
    fs.mkdirSync(logs)
    const old = {
      timestamp: new Date().toISOString(),
      process: 'main',
      pid: 999999,
      operation: 'old.run',
      code: 'INTERNAL_ERROR',
    }
    fs.writeFileSync(path.join(logs, 'app.jsonl'), JSON.stringify(old) + '\n')
    fs.writeFileSync(path.join(logs, 'mcp-123.jsonl'), JSON.stringify({ ...old, pid: 123 }) + '\n')
    fs.writeFileSync(path.join(logs, 'notes.txt'), 'keep')
    fs.writeFileSync(path.join(logs, 'agent-456.jsonl'), 'unknown')
    const future = `main-789-${randomUUID()}-1.closed.jsonl`
    fs.writeFileSync(
      path.join(logs, future),
      JSON.stringify({
        format: 'jobtrail-diagnostics',
        schemaVersion: 99,
        process: 'main',
        pid: 789,
        instanceId: randomUUID(),
        createdAt: new Date().toISOString(),
      }) + '\n',
    )
    expect(maintainLogs(directory, { alive: (pid) => pid === 123 })).toMatchObject({
      deletedFiles: 1,
      skippedFiles: 2,
    })
    expect(fs.existsSync(path.join(logs, 'app.jsonl'))).toBe(false)
    expect(fs.existsSync(path.join(logs, 'mcp-123.jsonl'))).toBe(true)
    expect(fs.existsSync(path.join(logs, future))).toBe(true)
    expect(fs.readFileSync(path.join(logs, 'notes.txt'), 'utf8')).toBe('keep')
    expect(maintainLogs(directory, { alive: (pid) => pid === 123 }).deletedFiles).toBe(0)
  })
})

describe('diagnostic failure boundaries', () => {
  it('recovers after a partial event write without appending into the damaged line', () => {
    const directory = root(),
      logger = runtime(directory, true, { stderr: () => {} })
    logger.accept(createErrorInput('main', 'file.first', new Error('first')))
    const write = fs.writeSync.bind(fs)
    let failed = false
    const spy = vi.spyOn(fs, 'writeSync').mockImplementation(((
      fd: number,
      bytes: Buffer,
      offset: number,
      length: number,
    ) => {
      if (!failed) {
        failed = true
        write(fd, bytes, offset, Math.min(10, length))
        throw new Error('disk unavailable')
      }
      return write(fd, bytes, offset, length)
    }) as typeof fs.writeSync)
    expect(
      logger.accept(createErrorInput('main', 'file.partial', new Error('partial'))).status,
    ).toBe('fallback')
    spy.mockRestore()
    logger.accept(createErrorInput('main', 'file.recovered', new Error('recovered')))
    const files = fs.readdirSync(path.join(directory, 'logs'))
    expect(files.filter((name) => name.endsWith('.jsonl'))).toHaveLength(2)
    const active = files.find((name) => name.endsWith('.active.jsonl'))!
    const lines = fs
      .readFileSync(path.join(directory, 'logs', active), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(lines.some((line) => line.operation === 'file.recovered')).toBe(true)
  })
  it('counts complete output failure instead of masking the business failure', () => {
    const logger = runtime(root(), true, {
      stderr: () => {
        throw new Error('stderr unavailable')
      },
    })
    vi.spyOn(fs, 'openSync').mockImplementationOnce(() => {
      throw new Error('denied')
    })
    expect(
      logger.accept(createErrorInput('main', 'file.write', new Error('business failure'))).status,
    ).toBe('unavailable')
    expect(logger.writer.health).toMatchObject({ degraded: true, dropped: 1, writeFailures: 1 })
  })
  it('reports cleanup failures, respects a live lock, and retries after it is released', () => {
    const directory = root(),
      logs = path.join(directory, 'logs')
    fs.mkdirSync(logs)
    const file = path.join(logs, 'app.jsonl')
    fs.writeFileSync(
      file,
      JSON.stringify({
        timestamp: new Date().toISOString(),
        process: 'main',
        pid: 987654,
        code: 'INTERNAL_ERROR',
        operation: 'old.failure',
      }),
    )
    const lock = path.join(logs, '.maintenance.lock')
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }))
    expect(maintainLogs(directory).deletedFiles).toBe(0)
    fs.unlinkSync(lock)
    const unlink = fs.unlinkSync.bind(fs)
    const spy = vi.spyOn(fs, 'unlinkSync').mockImplementation((target) => {
      if (target === file) throw new Error('occupied')
      unlink(target)
    })
    expect(maintainLogs(directory, { alive: () => false }).maintenanceFailures).toBe(1)
    expect(fs.existsSync(file)).toBe(true)
    spy.mockRestore()
    expect(maintainLogs(directory, { alive: () => false }).deletedFiles).toBe(1)
  })
  it('bounds exception trees and errors under a sustained storm', () => {
    const directory = root(),
      logger = runtime(directory)
    const started = performance.now()
    for (let index = 0; index < 2000; index++)
      logger.accept(createErrorInput('main', 'stress.failure', { message: 'repeat failure' }))
    logger.writer.flush()
    const records = diagnosticRecords(directory)
    expect(records.filter((item) => item.operation === 'stress.failure')).toHaveLength(100)
    expect(
      records
        .filter((item) => item.operation === 'diagnostics.aggregate')
        .reduce((count, item) => count + (item.attributes?.count ?? 0), 0),
    ).toBe(1900)
    expect(performance.now() - started).toBeLessThan(5000)
    expect(
      fs
        .readdirSync(path.join(directory, 'logs'))
        .reduce((size, file) => size + fs.statSync(path.join(directory, 'logs', file)).size, 0),
    ).toBeLessThan(256 * 1024)
  })
})

it('retains live segments under retention pressure and rejects a linked log directory', () => {
  const directory = root(),
    logger = runtime(directory)
  logger.accept(createErrorInput('main', 'retention.test', new Error('failure')))
  const logs = path.join(directory, 'logs')
  const file = path.join(logs, fs.readdirSync(logs).find((name) => name.endsWith('.jsonl'))!)
  const old = new Date(Date.now() - 20 * 86400000)
  fs.utimesSync(file, old, old)
  expect(maintainLogs(directory).deletedFiles).toBe(0)
  logger.close()
  const closed = path.join(
    logs,
    fs.readdirSync(logs).find((name) => name.endsWith('.closed.jsonl'))!,
  )
  fs.utimesSync(closed, old, old)
  expect(maintainLogs(directory).deletedFiles).toBe(1)
  const linkedRoot = root(),
    external = root()
  fs.writeFileSync(path.join(external, 'app.jsonl'), 'do not touch')
  fs.symlinkSync(external, path.join(linkedRoot, 'logs'), 'junction')
  expect(maintainLogs(linkedRoot).maintenanceFailures).toBe(1)
  expect(fs.readFileSync(path.join(external, 'app.jsonl'), 'utf8')).toBe('do not touch')
})

it('persists packaged child fallback records and exposes the degraded transport', () => {
  const childRoot = root(),
    child = runtime(childRoot)
  child.accept(createErrorInput('agent', 'worker.failure', new Error('original worker failure')))
  const event = diagnosticRecords(childRoot)[0]
  const parentRoot = root(),
    parent = initializeDiagnostics('main', '1.4.0', true, parentRoot)
  const stream = new PassThrough()
  forwardDiagnosticStderr(stream, () => {})
  stream.write(JSON.stringify(event) + '\n')
  expect(
    diagnosticRecords(parentRoot).find((record) => record.eventId === event.eventId),
  ).toMatchObject({ traceId: event.traceId, error: { message: 'original worker failure' } })
  expect(parent.writer.health).toMatchObject({ degraded: true, transportFailures: 1 })
})
