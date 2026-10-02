import fs from 'node:fs'
import path from 'node:path'
import type { DiagnosticEvent } from '../../src/shared/diagnostics'
export function diagnosticRecords(root: string): DiagnosticEvent[] {
  const directory = path.join(root, 'logs')
  if (!fs.existsSync(directory)) return []
  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith('.jsonl'))
    .flatMap((name) =>
      fs
        .readFileSync(path.join(directory, name), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    )
    .filter((record) => record.eventId)
}
