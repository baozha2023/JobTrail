import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { AppPaths } from './config'

const ALLOWED_EXTENSIONS = new Set(['.pdf', '.doc', '.docx'])

export class FileStorageService {
  constructor(private readonly paths: AppPaths) {
    fs.mkdirSync(paths.resumes, { recursive: true })
  }

  importResume(sourcePath: string): { relativePath: string; sizeBytes: number; sha256: string; originalExtension: string } {
    const extension = path.extname(sourcePath).toLowerCase()
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      throw new Error('FILE_IMPORT_FAILED: 仅支持 PDF、DOC、DOCX 文件')
    }
    if (!fs.existsSync(sourcePath)) {
      throw new Error('FILE_IMPORT_FAILED: 源文件不存在')
    }

    const relativePath = `${crypto.randomUUID()}${extension}`
    const destination = this.resolve(relativePath)
    fs.copyFileSync(sourcePath, destination)
    const content = fs.readFileSync(destination)
    return {
      relativePath,
      sizeBytes: content.byteLength,
      sha256: crypto.createHash('sha256').update(content).digest('hex'),
      originalExtension: extension,
    }
  }

  resolve(relativePath: string): string {
    const safeName = path.basename(relativePath)
    if (safeName !== relativePath || !/^[0-9a-f-]+\.(pdf|doc|docx)$/i.test(safeName)) {
      throw new Error('FILE_IMPORT_FAILED: 非法的内部文件名')
    }
    return path.join(this.paths.resumes, safeName)
  }

  remove(relativePath: string): void {
    const target = this.resolve(relativePath)
    if (fs.existsSync(target)) fs.unlinkSync(target)
  }

}
