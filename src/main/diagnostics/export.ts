import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { ZipFile } from 'yazl'
import * as yauzl from 'yauzl'
import {
  DIAGNOSTIC_VERSION,
  MAX_EVENT_BYTES,
  validateDiagnosticEvent,
  type DiagnosticsHealth,
} from '../../shared/diagnostics'
import { ensureLogDirectory, managedLogs, maintainLogs } from './storage'

export interface DiagnosticEnvironment {
  appVersion: string
  electronVersion: string
  nodeVersion: string
  databaseVersion: number
  configVersion: number
}
async function verifyZip(file: string, expected: Map<string, string>): Promise<void> {
  const remaining = new Map(expected)
  await new Promise<void>((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) {
        reject(error ?? new Error('Missing diagnostic archive'))
        return
      }
      zip.on('error', reject)
      zip.on('entry', (entry) => {
        zip.openReadStream(entry, (readError, stream) => {
          if (readError || !stream) {
            zip.close()
            reject(readError ?? new Error('Unreadable diagnostic archive'))
            return
          }
          const hash = createHash('sha256')
          stream.on('error', (cause) => {
            zip.close()
            reject(cause)
          })
          stream.on('data', (bytes) => hash.update(bytes))
          stream.on('end', () => {
            if (remaining.get(entry.fileName) !== hash.digest('hex')) {
              zip.close()
              reject(new Error('Diagnostic archive verification failed'))
              return
            }
            remaining.delete(entry.fileName)
            zip.readEntry()
          })
        })
      })
      zip.on('end', () =>
        remaining.size ? reject(new Error('Incomplete diagnostic archive')) : resolve(),
      )
      zip.readEntry()
    })
  })
}
export async function exportDiagnosticBundle(
  root: string,
  target: string,
  environment: DiagnosticEnvironment,
  health: DiagnosticsHealth,
  now = Date.now(),
): Promise<void> {
  const directory = ensureLogDirectory(root)
  const resolvedTarget = path.join(
    await fsp.realpath(path.dirname(path.resolve(target))),
    path.basename(target),
  )
  const relative = path.relative(await fsp.realpath(directory), resolvedTarget)
  if (
    relative === '' ||
    (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
  )
    throw new Error('Diagnostic export target must be outside the log directory')
  const maintenance = maintainLogs(root)
  const manifest = {
    format: 'jobtrail-diagnostics-bundle',
    schemaVersion: DIAGNOSTIC_VERSION,
    createdAt: new Date(now).toISOString(),
    since: new Date(now - 86400000).toISOString(),
    environment: {
      ...environment,
      platform: os.platform(),
      architecture: os.arch(),
      osRelease: os.release(),
    },
    health,
    maintenance,
    skippedFiles: 0,
    invalidRecords: 0,
    partialLines: 0,
    files: [] as { path: string; size: number; sha256: string }[],
  }
  const zip = new ZipFile()
  const temporary = path.join(path.dirname(target), `.jobtrail-diagnostics-${randomUUID()}.tmp`)
  const output = fs.createWriteStream(temporary, { flags: 'wx' })
  const writing = pipeline(zip.outputStream, output)
  // Attach rejection handling immediately while snapshot collection is still running.
  void writing.catch(() => {})
  try {
    for (const item of managedLogs(directory)) {
      if (item.version !== DIAGNOSTIC_VERSION || !item.header) {
        manifest.skippedFiles++
        continue
      }
      let pending = '',
        overflow = false,
        first = true
      const records: string[] = []
      let handle: fsp.FileHandle | undefined
      try {
        handle = await fsp.open(item.file, 'r')
        const metadata = await handle.stat()
        if (
          !metadata.isFile() ||
          metadata.ino !== (await fsp.lstat(item.file)).ino ||
          (await fsp.lstat(item.file)).isSymbolicLink()
        ) {
          manifest.skippedFiles++
          continue
        }
        const stream = handle.createReadStream({
          start: 0,
          end: Math.max(0, Math.min(item.size, metadata.size) - 1),
          encoding: 'utf8',
          autoClose: false,
        })
        for await (const chunk of stream) {
          for (const piece of String(chunk).split(/(?<=\n)/)) {
            if (!overflow) pending += piece
            if (Buffer.byteLength(pending) > MAX_EVENT_BYTES) {
              pending = ''
              overflow = true
            }
            if (!piece.endsWith('\n')) continue
            if (first) {
              if (overflow || JSON.stringify(JSON.parse(pending)) !== JSON.stringify(item.header))
                throw new Error('Diagnostic header changed during snapshot')
              first = false
            } else if (overflow) manifest.invalidRecords++
            else {
              try {
                const record = validateDiagnosticEvent(JSON.parse(pending))
                if (!record) manifest.invalidRecords++
                else if (
                  Date.parse(record.timestamp) >= now - 86400000 &&
                  Date.parse(record.timestamp) <= now
                )
                  records.push(JSON.stringify(record) + '\n')
              } catch {
                manifest.invalidRecords++
              }
            }
            pending = ''
            overflow = false
          }
        }
        if (pending || overflow) manifest.partialLines++
      } catch {
        manifest.skippedFiles++
        continue
      } finally {
        await handle?.close()
      }
      if (!records.length) continue
      const bytes = Buffer.from(JSON.stringify(item.header) + '\n' + records.join(''))
      const name = `logs/${item.name}`
      zip.addBuffer(bytes, name)
      manifest.files.push({
        path: name,
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      })
    }
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2))
    zip.addBuffer(manifestBytes, 'manifest.json')
    zip.end()
    await writing
    await verifyZip(
      temporary,
      new Map([
        ...manifest.files.map((file): [string, string] => [file.path, file.sha256]),
        ['manifest.json', createHash('sha256').update(manifestBytes).digest('hex')],
      ]),
    )
    await fsp.rename(temporary, target)
  } catch (error) {
    ;(zip.outputStream as Readable).destroy()
    output.destroy()
    await writing.catch(() => {})
    await fsp.unlink(temporary).catch((cleanupError: NodeJS.ErrnoException) => {
      if (cleanupError.code !== 'ENOENT')
        throw new AggregateError([error, cleanupError], 'Diagnostic export cleanup failed')
    })
    throw error
  }
}
