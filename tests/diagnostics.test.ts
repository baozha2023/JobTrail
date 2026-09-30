import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FaultLogger,
  forwardDiagnosticStderr,
  initializeFaultLogger,
} from '../src/main/diagnostics'
import { faultInput, faultRecord, safeStack, validateFaultInput } from '../src/shared/diagnostics'
import { DesktopUpdateService, type UpdateBackend } from '../src/main/update-service'

const roots: string[] = []
function root(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrail-diagnostics-'))
  roots.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('fault diagnostics', () => {
  it('extracts status 403 without keeping an error message, request or absolute path', () => {
    const error = new Error(
      'Authorization: Bearer secret; https://example.com/private?token=secret Http error: http status: 403',
    )
    error.stack = `Error: ${error.message}\n    at check (F:\\private\\JobTrail\\src\\main\\update-service.ts:53:17)\n    at external (C:\\Users\\secret\\file.ts:3:2)`
    const input = faultInput('main', 'update.check', error)
    expect(input).toEqual({
      source: 'main',
      operation: 'update.check',
      code: 'INTERNAL_ERROR',
      httpStatus: 403,
      stack: ['src/main/update-service.ts:53:17'],
    })
    const serialized = JSON.stringify(input)
    expect(serialized).not.toContain('secret')
    expect(serialized).not.toContain('C:')
    expect(serialized).not.toContain('Bearer')
  })

  it('excludes expected outcomes and rejects untrusted fields', () => {
    expect(faultInput('main', 'ipc.lookup', { code: 'NOT_FOUND' })).toBeNull()
    expect(faultInput('agent', 'agent.cancel', { code: 'AGENT_CANCELLED' })).toBeNull()
    expect(
      validateFaultInput({
        source: 'renderer',
        operation: 'ui.error',
        code: 'INTERNAL_ERROR',
        message: 'secret',
      }),
    ).toBeNull()
    expect(
      validateFaultInput({ source: 'renderer', operation: 'ui.error', code: 'SECRET' }),
    ).toBeNull()
    expect(
      validateFaultInput({
        source: 'renderer',
        operation: 'ui.error',
        code: 'INTERNAL_ERROR',
        stack: ['C:/private/file.ts:1:2'],
      }),
    ).toBeNull()
    expect(safeStack('Error: secret\n at f (C:/private/file.ts:1:2)')).toBeUndefined()
    expect(
      faultInput('main', 'file.read', Object.assign(new Error('private'), { code: 'EACCES' })),
    ).toMatchObject({
      code: 'SYSTEM_ERROR',
      systemCode: 'EACCES',
    })
  })

  it('does not persist cancellation, missing data or validation outcomes', () => {
    const directory = root()
    const logger = new FaultLogger('main', '1.1.0', true, directory)
    for (const code of ['VALIDATION_ERROR', 'NOT_FOUND', 'AGENT_CANCELLED'])
      logger.log('ipc.expected', { code })
    expect(fs.existsSync(path.join(directory, 'logs', 'app.jsonl'))).toBe(false)
  })

  it('prints a sanitized JSON line to the development console', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const logger = new FaultLogger('agent', '1.1.0', false, root())
      logger.log('agent.run', new Error('Bearer secret'))
      expect(write).toHaveBeenCalledOnce()
      const record = JSON.parse(String(write.mock.calls[0][0]))
      expect(record).toMatchObject({ process: 'agent', operation: 'agent.run' })
      expect(JSON.stringify(record)).not.toContain('secret')
    } finally {
      write.mockRestore()
    }
  })

  it.each([false, true])('records a missing API key once with packaged=%s', (packaged) => {
    const directory = root()
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const logger = new FaultLogger('main', '1.3.0', packaged, directory)
      const error = Object.assign(new Error('private configuration'), { code: 'AI_API_KEY_EMPTY' })
      logger.log('ipc.exams.grade', error)
      logger.log('ipc.exams.grade', error)
      const output = packaged
        ? fs.readFileSync(path.join(directory, 'logs', 'app.jsonl'), 'utf8')
        : String(write.mock.calls[0][0])
      const lines = output.trim().split('\n')
      expect(lines).toHaveLength(1)
      expect(JSON.parse(lines[0])).toMatchObject({
        process: 'main',
        operation: 'ipc.exams.grade',
        code: 'AI_API_KEY_EMPTY',
      })
      expect(write).toHaveBeenCalledTimes(packaged ? 0 : 1)
      expect(output).not.toContain('private configuration')
    } finally {
      write.mockRestore()
    }
  })

  it('forwards only validated child JSON lines to the development console', () => {
    const stream = new PassThrough()
    const lines: string[] = []
    forwardDiagnosticStderr(stream, (line) => lines.push(line))
    stream.write('raw child stderr: Bearer secret\n')
    stream.write(
      `${JSON.stringify({
        ...faultRecord(
          { source: 'agent', operation: 'agent.run', code: 'INTERNAL_ERROR' },
          123,
          '1.1.0',
        ),
        message: 'secret',
      })}\n`,
    )
    const valid = JSON.stringify(
      faultRecord(
        { source: 'agent', operation: 'agent.run', code: 'INTERNAL_ERROR' },
        123,
        '1.1.0',
      ),
    )
    stream.write(valid.slice(0, 30))
    stream.write(`${valid.slice(30)}\n`)
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0])).toMatchObject({
      process: 'agent',
      operation: 'agent.run',
      pid: 123,
    })
    expect(lines[0]).not.toContain('secret')
  })

  it('rotates main logs and removes only old named logs', () => {
    const directory = root()
    const logs = path.join(directory, 'logs')
    fs.mkdirSync(logs)
    fs.writeFileSync(path.join(logs, 'app.jsonl'), 'x'.repeat(5 * 1024 * 1024))
    fs.writeFileSync(path.join(logs, 'agent-123.jsonl'), 'old')
    fs.writeFileSync(path.join(logs, 'other.log'), 'preserve')
    const old = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000)
    fs.utimesSync(path.join(logs, 'agent-123.jsonl'), old, old)
    const logger = new FaultLogger('main', '1.1.0', true, directory)
    logger.report({
      source: 'main',
      operation: 'update.check',
      code: 'INTERNAL_ERROR',
      httpStatus: 403,
    })
    expect(fs.existsSync(path.join(logs, 'agent-123.jsonl'))).toBe(false)
    expect(fs.existsSync(path.join(logs, 'other.log'))).toBe(true)
    expect(fs.statSync(path.join(logs, 'app.1.jsonl')).size).toBe(5 * 1024 * 1024)
    expect(JSON.parse(fs.readFileSync(path.join(logs, 'app.jsonl'), 'utf8'))).toMatchObject({
      process: 'main',
      appVersion: '1.1.0',
      operation: 'update.check',
      httpStatus: 403,
    })
  })

  it('caps each child file and trims an oversized directory at startup', () => {
    const directory = root()
    const logs = path.join(directory, 'logs')
    fs.mkdirSync(logs)
    const oversized = path.join(logs, 'mcp-123.jsonl')
    fs.writeFileSync(oversized, '')
    fs.truncateSync(oversized, 50 * 1024 * 1024 + 1)
    const childFile = path.join(logs, `agent-${process.pid}.jsonl`)
    fs.writeFileSync(childFile, 'x'.repeat(1024 * 1024))
    const logger = new FaultLogger('agent', '1.1.0', true, directory)
    expect(fs.existsSync(oversized)).toBe(false)
    logger.report({ source: 'agent', operation: 'agent.run', code: 'INTERNAL_ERROR' })
    expect(fs.statSync(childFile).size).toBeLessThan(1024 * 1024)
    expect(fs.existsSync(path.join(logs, `agent-${process.pid}.1.jsonl`))).toBe(false)
  })

  it('does not block application work if the log destination cannot be written', () => {
    const directory = root()
    fs.writeFileSync(path.join(directory, 'logs'), 'occupied')
    const logger = new FaultLogger('mcp', '1.1.0', true, directory)
    expect(() => logger.log('mcp.run', new Error('secret'))).not.toThrow()
  })

  it('records an update-check 403 once while preserving the original failure', async () => {
    const directory = root()
    initializeFaultLogger('main', '1.1.0', true, directory)
    const error = new Error('Network error: Http error: http status: 403')
    const backend = {
      checkForUpdatesAsync: async () => {
        throw error
      },
      downloadUpdateAsync: async () => {},
      getUpdatePendingRestart: () => null,
      waitExitThenApplyUpdate: () => {},
    } satisfies UpdateBackend
    const service = new DesktopUpdateService(backend, {
      preserve: async () => {},
      prepare: async () => {},
      cancelPrepare: async () => {},
    })
    await expect(service.check()).rejects.toBe(error)
    const lines = fs
      .readFileSync(path.join(directory, 'logs', 'app.jsonl'), 'utf8')
      .trim()
      .split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0])).toMatchObject({ operation: 'update.check', httpStatus: 403 })
  })
})
