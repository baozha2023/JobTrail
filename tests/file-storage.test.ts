import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileStorageService } from '../src/main/file-storage'
import { resolveStorageRoot } from '../src/main/installation-paths'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrail-storage-'))
  roots.push(root)
  const paths = {
    root,
    config: path.join(root, 'config.json'),
    data: path.join(root, 'data'),
    database: path.join(root, 'data/zhiji.db'),
    resumes: path.join(root, 'resumes'),
  }
  return { root, paths, service: new FileStorageService(paths) }
}
describe('installation and resume storage', () => {
  it('keeps user data outside the version directory', () => {
    const root = path.resolve('JobTrail')
    expect(resolveStorageRoot(path.join(root, '.runtime/current/zhiji.exe'))).toBe(root)
    expect(resolveStorageRoot(path.join(root, 'zhiji.exe'))).toBe(root)
  })
  it('rejects directory imports and path traversal', () => {
    const { root, service } = fixture()
    const directory = path.join(root, 'directory.pdf')
    fs.mkdirSync(directory)
    expect(() => service.importResume(directory)).toThrow()
    expect(() => service.resolve('../secret.pdf')).toThrow()
  })
  it('rejects a junction in place of the resume directory', () => {
    const { root, paths, service } = fixture()
    const outside = path.join(root, 'outside')
    fs.mkdirSync(outside)
    fs.rmdirSync(paths.resumes)
    fs.symlinkSync(outside, paths.resumes, 'junction')
    expect(() => service.resolve('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.pdf')).toThrow('不能是链接')
    fs.unlinkSync(paths.resumes)
  })
  it('imports, restores and finalizes only managed files', () => {
    const { root, service } = fixture()
    const source = path.join(root, 'resume.pdf')
    fs.writeFileSync(source, 'sample')
    const imported = service.importResume(source)
    expect(imported.sizeBytes).toBe(6)
    const staged = service.stageRemove(imported.relativePath)
    service.restore(staged)
    expect(fs.readFileSync(service.resolve(imported.relativePath), 'utf8')).toBe('sample')
    const deleted = service.stageRemove(imported.relativePath)
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(fs, 'unlinkSync').mockImplementationOnce(() => {
      throw new Error('locked')
    })
    expect(() => service.finalizeRemove(deleted)).not.toThrow()
    expect(log).toHaveBeenCalledOnce()
    expect(fs.existsSync(deleted.temporaryPath)).toBe(true)
  })
})
