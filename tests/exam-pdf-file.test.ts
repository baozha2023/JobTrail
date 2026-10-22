import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { examPdfFilename, examPdfTarget, writeExamPdf } from '../src/main/exam-pdf-file'
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})
async function fixture() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'exam-pdf-file-'))
  roots.push(base)
  const root = path.join(base, 'JobTrail')
  await fs.mkdir(path.join(root, 'data'), { recursive: true })
  return { base, root, target: path.join(base, 'Exam.pdf') }
}
it('normalizes Windows filenames and rejects protected targets', async () => {
  expect(examPdfFilename('CON')).toBe('JobTrail-exam.pdf')
  expect(examPdfFilename('卷子:/?*. ')).toBe('卷子____.pdf')
  const f = await fixture()
  await expect(examPdfTarget(path.join(f.root, 'data', 'exam.pdf'), f.root)).rejects.toThrow(
    'managed data',
  )
  await expect(examPdfTarget(path.join(f.base, 'config.json'), f.root)).rejects.toThrow(
    'Invalid PDF target',
  )
  await fs.mkdir(f.target)
  await expect(examPdfTarget(f.target, f.root)).rejects.toThrow('Unsafe PDF target')
})
it('replaces a chosen PDF atomically and preserves existing bytes if replacement fails', async () => {
  const f = await fixture()
  await fs.writeFile(f.target, 'original')
  const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('replacement failed'))
  await expect(writeExamPdf(f.target, Buffer.from('%PDF-new'), f.root)).rejects.toThrow(
    'replacement failed',
  )
  expect(await fs.readFile(f.target, 'utf8')).toBe('original')
  expect((await fs.readdir(f.base)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  rename.mockRestore()
  await writeExamPdf(f.target, Buffer.from('%PDF-new'), f.root)
  expect(await fs.readFile(f.target, 'utf8')).toBe('%PDF-new')
})
