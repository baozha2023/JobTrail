import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  DIAGNOSTIC_VERSION,
  normalizeDiagnosticError,
  type DiagnosticEvent,
  type DiagnosticReceipt,
  type DiagnosticsHealth,
  type DiagnosticProcess,
} from '../../shared/diagnostics'
import { ensureLogDirectory, maintainLogs, SEGMENT_BYTES, type LogHeader } from './storage'

export interface WriterOptions {
  io?: typeof fs
  now?: () => number
  id?: () => string
  stderr?: (line: string) => void
  segmentBytes?: number
  queueBytes?: number
}
export class DiagnosticWriter {
  readonly instanceId: string
  readonly health: DiagnosticsHealth = {
    degraded: false,
    writeFailures: 0,
    transportFailures: 0,
    dropped: 0,
    aggregated: 0,
    deletedFiles: 0,
    maintenanceFailures: 0,
    skippedFiles: 0,
    overBudget: false,
  }
  private readonly io: typeof fs
  private readonly now: () => number
  private readonly stderr: (line: string) => void
  private fd?: number
  private file?: string
  private size = 0
  private segment = 0
  private sequence = 0
  private queue: string[] = []
  private queueSize = 0
  private timer?: ReturnType<typeof setTimeout>
  private maintenanceTimer?: ReturnType<typeof setInterval>
  private writing = false
  private diskFailed = false
  private readonly seen = new Map<string, DiagnosticReceipt>()
  private readonly bursts = new Map<string, { at: number; count: number; event: DiagnosticEvent }>()
  constructor(
    readonly source: DiagnosticProcess,
    readonly root: string,
    readonly packaged: boolean,
    private readonly options: WriterOptions = {},
  ) {
    this.io = options.io ?? fs
    this.now = options.now ?? Date.now
    this.stderr =
      options.stderr ??
      ((line) => {
        process.stderr.write(line)
      })
    this.instanceId = (options.id ?? randomUUID)()
    this.maintain()
    this.maintenanceTimer = setInterval(() => this.maintain(), 60000)
    this.maintenanceTimer.unref()
  }
  maintain(): void {
    const result = maintainLogs(this.root, { io: this.io, now: this.now() })
    this.health.deletedFiles += result.deletedFiles
    this.health.maintenanceFailures += result.maintenanceFailures
    this.health.skippedFiles = result.skippedFiles
    this.health.overBudget = result.overBudget
    if (result.maintenanceFailures) this.health.degraded = true
  }
  accept(event: DiagnosticEvent): DiagnosticReceipt {
    const existing = this.seen.get(event.eventId)
    if (existing) return { ...existing, status: 'duplicate' }
    const key = `${event.process}:${event.kind}:${event.outcome}:${event.operation}:${event.code}:${event.error?.name}:${event.error?.message}`
    const burst = this.bursts.get(key)
    if (burst && this.now() - burst.at < 10000 && ++burst.count > 100) {
      this.health.aggregated++
      const receipt: DiagnosticReceipt = { eventId: event.eventId, status: 'buffered' }
      this.remember(receipt)
      this.schedule()
      return receipt
    }
    if (!burst || this.now() - burst.at >= 10000) {
      if (burst && burst.count > 100) this.writeSummary(burst)
      this.bursts.set(key, { at: this.now(), count: 1, event })
      if (this.bursts.size > 256) {
        const first = this.bursts.keys().next().value!
        const removed = this.bursts.get(first)!
        if (removed.count > 100) this.writeSummary(removed)
        this.bursts.delete(first)
      }
    }
    const line = JSON.stringify(event) + '\n'
    let status: DiagnosticReceipt['status']
    if (event.level === 'error' || event.level === 'fatal' || event.level === 'warn') {
      this.flush()
      status = this.write(line)
    } else {
      if (this.queueSize + Buffer.byteLength(line) > (this.options.queueBytes ?? 1024 * 1024))
        this.flush()
      this.queue.push(line)
      this.queueSize += Buffer.byteLength(line)
      this.schedule()
      status = 'buffered'
    }
    const receipt = { eventId: event.eventId, status }
    this.remember(receipt)
    return receipt
  }
  private remember(receipt: DiagnosticReceipt): void {
    if (receipt.status === 'unavailable') return
    this.seen.set(receipt.eventId, receipt)
    if (this.seen.size > 10000) this.seen.delete(this.seen.keys().next().value!)
  }
  private schedule(): void {
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), 100)
      this.timer.unref()
    }
  }
  private writeSummary(burst: { count: number; event: DiagnosticEvent }): void {
    this.write(
      JSON.stringify({
        ...burst.event,
        eventId: randomUUID(),
        timestamp: new Date(this.now()).toISOString(),
        kind: 'maintenance',
        operation: 'diagnostics.aggregate',
        attributes: {
          count: burst.count - 100,
          relatedEventId: burst.event.eventId,
          firstSeenAt: Date.parse(burst.event.timestamp),
          lastSeenAt: this.now(),
        },
      }) + '\n',
    )
    burst.count = 100
  }
  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    const lines = this.queue.splice(0)
    this.queueSize = 0
    for (const line of lines) this.write(line)
    for (const burst of this.bursts.values()) if (burst.count > 100) this.writeSummary(burst)
  }
  private open(): void {
    const directory = ensureLogDirectory(this.root, this.io)
    const file = path.join(
      directory,
      `${this.source}-${process.pid}-${this.instanceId}-${++this.segment}.active.jsonl`,
    )
    const fd = this.io.openSync(file, 'wx')
    try {
      const header: LogHeader = {
        format: 'jobtrail-diagnostics',
        schemaVersion: DIAGNOSTIC_VERSION,
        process: this.source,
        pid: process.pid,
        instanceId: this.instanceId,
        createdAt: new Date(this.now()).toISOString(),
      }
      const text = JSON.stringify(header) + '\n'
      this.writeAll(fd, text)
      this.size = Buffer.byteLength(text)
      this.fd = fd
      this.file = file
    } catch (error) {
      try {
        this.io.closeSync(fd)
      } catch {
        this.health.maintenanceFailures++
      }
      try {
        if (path.dirname(file) === directory) this.io.unlinkSync(file)
      } catch {
        this.health.maintenanceFailures++
      }
      this.file = undefined
      throw error
    }
  }
  private writeAll(fd: number, text: string): void {
    const bytes = Buffer.from(text)
    let offset = 0
    while (offset < bytes.length) {
      const count = this.io.writeSync(fd, bytes, offset, bytes.length - offset)
      if (count <= 0) throw new Error('Diagnostic write made no progress')
      offset += count
    }
  }

  private closeSegment(): void {
    if (this.fd !== undefined) {
      this.io.closeSync(this.fd)
      this.fd = undefined
    }
    if (this.file) {
      this.io.renameSync(this.file, this.file.replace('.active.jsonl', '.closed.jsonl'))
      this.file = undefined
    }
  }
  private write(line: string): DiagnosticReceipt['status'] {
    if (this.writing) {
      this.health.dropped++
      return 'unavailable'
    }
    this.writing = true
    line = JSON.stringify({ ...JSON.parse(line), sequence: ++this.sequence }) + '\n'
    try {
      if (this.fd === undefined) this.open()
      if (this.size + Buffer.byteLength(line) > (this.options.segmentBytes ?? SEGMENT_BYTES)) {
        this.closeSegment()
        this.open()
      }
      this.writeAll(this.fd!, line)
      this.size += Buffer.byteLength(line)
      if (!this.packaged) {
        try {
          this.stderr(line)
        } catch {
          this.health.transportFailures++
          this.health.degraded = true
        }
      }
      if (this.diskFailed) {
        const failures = this.health.writeFailures
        this.diskFailed = false
        this.health.degraded =
          this.health.maintenanceFailures > 0 || this.health.transportFailures > 0
        const recovered = JSON.parse(line) as DiagnosticEvent
        const recovery =
          JSON.stringify({
            ...recovered,
            eventId: randomUUID(),
            sequence: ++this.sequence,
            kind: 'maintenance',
            operation: 'diagnostics.recovered',
            level: 'info',
            code: undefined,
            error: undefined,
            attributes: { failedCount: failures, count: this.health.dropped },
          }) + '\n'
        this.writeAll(this.fd!, recovery)
        this.size += Buffer.byteLength(recovery)
      }
      return 'written'
    } catch (error) {
      this.health.writeFailures++
      this.diskFailed = true
      this.health.degraded = true
      // A short/failed write may leave an incomplete line. Never append to that segment again.
      if (this.fd !== undefined) {
        try {
          this.io.closeSync(this.fd)
        } catch {
          this.health.maintenanceFailures++
        }
        this.fd = undefined
      }
      if (this.file) {
        try {
          this.io.renameSync(this.file, this.file.replace('.active.jsonl', '.closed.jsonl'))
        } catch {
          this.health.maintenanceFailures++
        }
        this.file = undefined
      }
      try {
        this.stderr(line)
        const original = JSON.parse(line) as DiagnosticEvent
        this.stderr(
          JSON.stringify({
            ...original,
            eventId: randomUUID(),
            sequence: ++this.sequence,
            operation: 'diagnostics.write',
            kind: 'error',
            code: 'DIAGNOSTICS_WRITE_FAILED',
            level: 'error',
            error: normalizeDiagnosticError(error),
            attributes: {
              relatedEventId: original.eventId,
              failedCount: this.health.writeFailures,
            },
          }) + '\n',
        )
        return 'fallback'
      } catch {
        this.health.dropped++
        return 'unavailable'
      }
    } finally {
      this.writing = false
    }
  }
  close(): void {
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer)
    this.flush()
    try {
      this.closeSegment()
    } catch {
      this.health.maintenanceFailures++
      this.health.degraded = true
    }
  }
}
