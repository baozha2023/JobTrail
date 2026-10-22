import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export function examPdfFilename(title: string): string {
  const stem = title
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 140)
  return `${!stem || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem) ? 'JobTrail-exam' : stem}.pdf`
}

export async function examPdfTarget(file: string, root: string): Promise<string> {
  if (!path.isAbsolute(file) || path.extname(file).toLowerCase() !== '.pdf')
    throw new Error('Invalid PDF target')
  const target = path.join(await fs.realpath(path.dirname(file)), path.basename(file))
  const realRoot = await fs.realpath(root)
  for (const name of ['data', 'resumes', 'chat-uploads', '.runtime', 'browser-sessions', 'logs']) {
    const relative = path.relative(path.join(realRoot, name), target)
    if (
      relative === '' ||
      (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
    )
      throw new Error('PDF target is inside managed data')
  }
  const existing = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return undefined
  })
  if (existing && (!existing.isFile() || existing.isSymbolicLink()))
    throw new Error('Unsafe PDF target')
  return target
}

export async function writeExamPdf(file: string, bytes: Buffer, root: string): Promise<void> {
  const target = await examPdfTarget(file, root)
  const temporary = path.join(path.dirname(target), `.jobtrail-pdf-${randomUUID()}.tmp`)
  try {
    const handle = await fs.open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await examPdfTarget(target, root)
    await fs.rename(temporary, target)
  } finally {
    await fs.rm(temporary, { force: true })
  }
}
