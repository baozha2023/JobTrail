import fs from 'node:fs'
import path from 'node:path'
import {
  faultInput,
  faultRecord,
  validateForwardedFaultRecord,
  type FaultInput,
  type FaultProcess,
} from '../shared/diagnostics'

const MAIN_LIMIT = 5 * 1024 * 1024
const CHILD_LIMIT = 1024 * 1024
const TOTAL_LIMIT = 50 * 1024 * 1024
const MAX_AGE = 14 * 24 * 60 * 60 * 1000
const OWN_FILE = /^(?:app(?:\.[1-3])?|(?:agent|mcp)-\d+(?:\.[1-3])?)\.jsonl$/

export class FaultLogger {
  private readonly directory: string
  private readonly filename: string
  private readonly seen = new WeakSet<object>()
  private writing = false

  constructor(
    private readonly source: FaultProcess,
    private readonly version: string,
    private readonly packaged: boolean,
    root: string,
  ) {
    this.directory = path.join(root, 'logs')
    this.filename = source === 'main' ? 'app.jsonl' : `${source}-${process.pid}.jsonl`
    if (packaged) this.clean()
  }

  log(operation: string, error: unknown): void {
    try {
      if (error && typeof error === 'object') {
        if (this.seen.has(error)) return
        this.seen.add(error)
      }
      const input = faultInput(this.source, operation, error)
      if (input) this.report(input)
    } catch {
      // Exception inspection itself may fail for a hostile Error or Proxy.
    }
  }

  report(input: FaultInput, pid = process.pid): void {
    if (this.writing) return
    this.writing = true
    try {
      const line = `${JSON.stringify(faultRecord(input, pid, this.version))}\n`
      if (!this.packaged) {
        process.stderr.write(line)
        return
      }
      fs.mkdirSync(this.directory, { recursive: true })
      const directoryStat = fs.lstatSync(this.directory)
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return
      const file = path.join(this.directory, this.filename)
      if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) return
      const limit = this.source === 'main' ? MAIN_LIMIT : CHILD_LIMIT
      const size = fs.existsSync(file) ? fs.statSync(file).size : 0
      if (size + Buffer.byteLength(line) > limit) {
        if (this.source === 'main') this.rotate(file)
        else fs.truncateSync(file, 0)
      }
      fs.appendFileSync(file, line, { encoding: 'utf8', flag: 'a' })
    } catch {
      // Logging must never turn a recoverable application failure into a crash.
    } finally {
      this.writing = false
    }
  }

  private rotate(file: string): void {
    for (let index = 3; index >= 1; index--) {
      const previous = index === 1 ? file : file.replace(/\.jsonl$/, `.${index - 1}.jsonl`)
      const next = file.replace(/\.jsonl$/, `.${index}.jsonl`)
      if (fs.existsSync(previous)) {
        if (fs.existsSync(next)) fs.unlinkSync(next)
        fs.renameSync(previous, next)
      }
    }
  }

  private clean(): void {
    try {
      if (!fs.existsSync(this.directory)) return
      const directoryStat = fs.lstatSync(this.directory)
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return
      const files = fs
        .readdirSync(this.directory)
        .filter((name) => OWN_FILE.test(name))
        .map((name) => {
          const file = path.join(this.directory, name)
          const stat = fs.lstatSync(file)
          return stat.isFile() && !stat.isSymbolicLink()
            ? { file, size: stat.size, mtime: stat.mtimeMs }
            : null
        })
        .filter((item): item is { file: string; size: number; mtime: number } => item !== null)
        .sort((a, b) => a.mtime - b.mtime)
      let total = files.reduce((sum, item) => sum + item.size, 0)
      for (const item of files) {
        if (Date.now() - item.mtime <= MAX_AGE && total <= TOTAL_LIMIT) break
        fs.unlinkSync(item.file)
        total -= item.size
      }
    } catch {
      // Failure to clean old files cannot block startup.
    }
  }
}

let current: FaultLogger | undefined

export function initializeFaultLogger(
  source: FaultProcess,
  version: string,
  packaged: boolean,
  root: string,
): FaultLogger {
  current = new FaultLogger(source, version, packaged, root)
  return current
}

export function logFault(operation: string, error: unknown): void {
  current?.log(operation, error)
}

export function reportFault(input: FaultInput, pid?: number): void {
  current?.report(input, pid && Number.isSafeInteger(pid) && pid > 0 ? pid : process.pid)
}

export function forwardDiagnosticStderr(
  stream:
    | { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown }
    | null
    | undefined,
  write: (line: string) => void = (line) => {
    process.stderr.write(line)
  },
): void {
  let pending = ''
  stream?.on('data', (chunk: Buffer | string) => {
    pending += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk
    let boundary = pending.indexOf('\n')
    while (boundary >= 0) {
      const line = pending.slice(0, boundary)
      pending = pending.slice(boundary + 1)
      if (line.length <= 2048) {
        try {
          const record = validateForwardedFaultRecord(JSON.parse(line))
          if (record) write(`${JSON.stringify(record)}\n`)
        } catch {
          // Discard arbitrary child stderr and broken diagnostic transport.
        }
      }
      boundary = pending.indexOf('\n')
    }
    if (pending.length > 8192) pending = ''
  })
}
