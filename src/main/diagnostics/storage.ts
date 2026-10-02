import fs from 'node:fs'
import path from 'node:path'
import { DIAGNOSTIC_VERSION, type DiagnosticProcess, validId } from '../../shared/diagnostics'

export const SEGMENT_BYTES = 5 * 1024 * 1024
export const RETENTION_BYTES = 50 * 1024 * 1024
export const RETENTION_MS = 14 * 24 * 60 * 60 * 1000
export const CURRENT_NAME = /^(main|agent|mcp)-\d+-[0-9a-f-]{36}-\d+\.(active|closed)\.jsonl$/
const OLD_NAME = /^(?:app(?:\.[1-3])?|(?:agent|mcp)-\d+(?:\.[1-3])?)\.jsonl$/
export interface LogHeader {
  format: 'jobtrail-diagnostics'
  schemaVersion: number
  process: DiagnosticProcess
  pid: number
  instanceId: string
  createdAt: string
}
export interface ManagedLog {
  file: string
  name: string
  size: number
  mtime: number
  header?: LogHeader
  version: number | null
  pid?: number
  closed: boolean
}
export interface MaintenanceResult {
  deletedFiles: number
  maintenanceFailures: number
  skippedFiles: number
  overBudget: boolean
}
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}
export function ensureLogDirectory(root: string, io = fs): string {
  const directory = path.resolve(root, 'logs')
  io.mkdirSync(directory, { recursive: true })
  const stat = io.lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe diagnostic directory')
  return directory
}
export function readHeader(file: string, io = fs): unknown {
  const fd = io.openSync(file, 'r')
  try {
    const bytes = Buffer.alloc(32768)
    const count = io.readSync(fd, bytes, 0, bytes.length, 0)
    const first = bytes.subarray(0, count).toString('utf8').split('\n')[0]
    return JSON.parse(first)
  } finally {
    io.closeSync(fd)
  }
}
export function managedLogs(directory: string, io = fs): ManagedLog[] {
  const result: ManagedLog[] = []
  for (const name of io.readdirSync(directory)) {
    if (!CURRENT_NAME.test(name) && !OLD_NAME.test(name)) continue
    const file = path.resolve(directory, name)
    if (path.dirname(file) !== directory) continue
    let stat: fs.Stats
    try {
      stat = io.lstatSync(file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    const item: ManagedLog = {
      file,
      name,
      size: stat.size,
      mtime: stat.mtimeMs,
      version: null,
      closed: name.endsWith('.closed.jsonl'),
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      result.push(item)
      continue
    }
    try {
      const header = readHeader(file, io) as Partial<LogHeader> & {
        timestamp?: unknown
        code?: unknown
        operation?: unknown
        schemaVersion?: unknown
      }
      if (
        header.format === 'jobtrail-diagnostics' &&
        Number.isSafeInteger(header.schemaVersion) &&
        Number(header.schemaVersion) > 0 &&
        validId(header.instanceId) &&
        Number.isSafeInteger(header.pid) &&
        Number(header.pid) > 0 &&
        ['main', 'agent', 'mcp'].includes(String(header.process)) &&
        typeof header.createdAt === 'string' &&
        Number.isFinite(Date.parse(header.createdAt))
      ) {
        if (
          CURRENT_NAME.test(name) &&
          !name.startsWith(`${header.process}-${header.pid}-${header.instanceId}-`)
        ) {
          result.push(item)
          continue
        }
        item.header = header as LogHeader
        item.version = Number(header.schemaVersion)
        item.pid = header.pid
      } else if (
        OLD_NAME.test(name) &&
        header.schemaVersion === undefined &&
        ['main', 'renderer', 'preload', 'agent', 'mcp'].includes(String(header.process)) &&
        typeof header.timestamp === 'string' &&
        Number.isFinite(Date.parse(header.timestamp)) &&
        typeof header.code === 'string' &&
        typeof header.operation === 'string' &&
        Number.isSafeInteger(header.pid) &&
        Number(header.pid) > 0
      ) {
        // Identification for deletion only. No legacy event conversion or export exists.
        item.version = 0
        item.pid = header.pid
      }
    } catch {
      /* Unknown/corrupt files are retained; callers count them as skipped. */
    }
    result.push(item)
  }
  return result
}
export function maintainLogs(
  root: string,
  options: { now?: number; alive?: (pid: number) => boolean; io?: typeof fs } = {},
): MaintenanceResult {
  const io = options.io ?? fs,
    alive = options.alive ?? processAlive,
    now = options.now ?? Date.now()
  const result: MaintenanceResult = {
    deletedFiles: 0,
    maintenanceFailures: 0,
    skippedFiles: 0,
    overBudget: false,
  }
  let lock: string | undefined,
    owned = false
  try {
    const directory = ensureLogDirectory(root, io)
    lock = path.join(directory, '.maintenance.lock')
    if (io.existsSync(lock)) {
      const stat = io.lstatSync(lock)
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error('Unsafe diagnostic maintenance lock')
      const owner = JSON.parse(io.readFileSync(lock, 'utf8')) as { pid: number }
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0)
        throw new Error('Invalid diagnostic maintenance owner')
      if (alive(owner.pid)) return result
      io.unlinkSync(lock)
    }
    try {
      io.writeFileSync(lock, JSON.stringify({ pid: process.pid }), { flag: 'wx' })
      owned = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return result
      throw error
    }
    const files = managedLogs(directory, io).sort((a, b) => a.mtime - b.mtime)
    let total = files.reduce((sum, item) => sum + item.size, 0)
    for (const item of files) {
      if (item.version === null || item.version > DIAGNOSTIC_VERSION) {
        result.skippedFiles++
        continue
      }
      const active = !item.closed && item.pid !== undefined && alive(item.pid)
      if (active) continue
      if (
        item.version < DIAGNOSTIC_VERSION ||
        now - item.mtime > RETENTION_MS ||
        total > RETENTION_BYTES
      ) {
        try {
          const stat = io.lstatSync(item.file)
          if (!stat.isFile() || stat.isSymbolicLink() || path.dirname(item.file) !== directory)
            throw new Error('Unsafe diagnostic cleanup target')
          io.unlinkSync(item.file)
          total -= item.size
          result.deletedFiles++
        } catch {
          result.maintenanceFailures++
        }
      }
    }
    result.overBudget = total > RETENTION_BYTES
  } catch {
    result.maintenanceFailures++
  } finally {
    if (owned && lock)
      try {
        io.unlinkSync(lock)
      } catch {
        result.maintenanceFailures++
      }
  }
  return result
}
