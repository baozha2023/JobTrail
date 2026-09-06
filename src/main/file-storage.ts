import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { AppPaths } from './config'
import { AppServiceError } from './services/errors'

const ALLOWED_EXTENSIONS = new Set(['.pdf', '.doc', '.docx'])

export class FileStorageService {
  constructor(private readonly paths: AppPaths) {
    fs.mkdirSync(paths.resumes, { recursive: true })
  }

  importResume(sourcePath: string): { relativePath: string; sizeBytes: number; sha256: string; originalExtension: string } {
    const extension = path.extname(sourcePath).toLowerCase()
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      throw new AppServiceError('FILE_IMPORT_FAILED', '仅支持 PDF、DOC、DOCX 文件')
    }
    if (!fs.existsSync(sourcePath)) {
      throw new AppServiceError('FILE_IMPORT_FAILED', '源文件不存在')
    }

    const relativePath = `${crypto.randomUUID()}${extension}`
    const destination = this.resolve(relativePath)
    try {
      fs.copyFileSync(sourcePath, destination)
      const content = fs.readFileSync(destination)
      return {
        relativePath,
        sizeBytes: content.byteLength,
        sha256: crypto.createHash('sha256').update(content).digest('hex'),
        originalExtension: extension,
      }
    } catch {
      if (fs.existsSync(destination)) fs.unlinkSync(destination)
      throw new AppServiceError('FILE_IMPORT_FAILED', '简历文件导入失败')
    }
  }

  resolve(relativePath: string): string {
    const safeName = path.basename(relativePath)
    if (safeName !== relativePath || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(pdf|doc|docx)$/i.test(safeName)) {
      throw new AppServiceError('FILE_IMPORT_FAILED', '非法的内部文件名')
    }
    return path.join(this.paths.resumes, safeName)
  }

  remove(relativePath: string): void {
    const target = this.resolve(relativePath)
    if (fs.existsSync(target)) fs.unlinkSync(target)
  }

  stageRemove(relativePath: string): { relativePath: string; temporaryPath: string } {
    const source = this.resolve(relativePath)
    if (!fs.existsSync(source)) throw new AppServiceError('FILE_IMPORT_FAILED', '简历文件不存在')
    const trashDirectory = path.join(this.paths.resumes, '.trash')
    fs.mkdirSync(trashDirectory, { recursive: true })
    const temporaryPath = path.join(trashDirectory, `${crypto.randomUUID()}-${path.basename(relativePath)}`)
    fs.renameSync(source, temporaryPath)
    return { relativePath, temporaryPath }
  }

  restore(staged: { relativePath: string; temporaryPath: string }): void {
    if (!fs.existsSync(staged.temporaryPath)) return
    fs.renameSync(staged.temporaryPath, this.resolve(staged.relativePath))
  }

  finalizeRemove(staged: { relativePath: string; temporaryPath: string }): void {
    if (fs.existsSync(staged.temporaryPath)) fs.unlinkSync(staged.temporaryPath)
  }

}
