import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { AppPaths } from './config'
import { AppServiceError } from './services/errors'

const ALLOWED_EXTENSIONS = new Set(['.pdf', '.doc', '.docx'])

export class FileStorageService {
  constructor(private readonly paths: AppPaths) {
    fs.mkdirSync(paths.resumes, { recursive: true })
    this.assertDirectory(paths.resumes)
  }

  importResume(sourcePath: string): {
    relativePath: string
    sizeBytes: number
    sha256: string
    originalExtension: string
  } {
    const extension = path.extname(sourcePath).toLowerCase()
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      throw new AppServiceError('FILE_IMPORT_FAILED', '仅支持 PDF、DOC、DOCX 文件')
    }
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
      throw new AppServiceError('FILE_IMPORT_FAILED', '源文件不存在')
    }

    const relativePath = `${crypto.randomUUID()}${extension}`
    const destination = this.resolve(relativePath)
    let copied = false
    try {
      fs.copyFileSync(sourcePath, destination, fs.constants.COPYFILE_EXCL)
      copied = true
      const hash = crypto.createHash('sha256')
      const buffer = Buffer.allocUnsafe(64 * 1024)
      const file = fs.openSync(destination, 'r')
      try {
        let bytesRead: number
        do {
          bytesRead = fs.readSync(file, buffer, 0, buffer.length, null)
          if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead))
        } while (bytesRead > 0)
      } finally {
        fs.closeSync(file)
      }
      return {
        relativePath,
        sizeBytes: fs.statSync(destination).size,
        sha256: hash.digest('hex'),
        originalExtension: extension,
      }
    } catch {
      if (copied && fs.existsSync(destination)) fs.unlinkSync(destination)
      throw new AppServiceError('FILE_IMPORT_FAILED', '简历文件导入失败')
    }
  }

  resolve(relativePath: string): string {
    const safeName = path.basename(relativePath)
    if (
      safeName !== relativePath ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(pdf|doc|docx)$/i.test(
        safeName,
      )
    ) {
      throw new AppServiceError('FILE_IMPORT_FAILED', '非法的内部文件名')
    }
    this.assertDirectory(this.paths.resumes)
    const target = path.join(this.paths.resumes, safeName)
    try {
      const metadata = fs.lstatSync(target)
      if (!metadata.isFile() || metadata.isSymbolicLink())
        throw new AppServiceError('FILE_IMPORT_FAILED', '简历路径不是普通文件')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return target
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
    this.assertDirectory(trashDirectory)
    const temporaryPath = path.join(
      trashDirectory,
      `${crypto.randomUUID()}-${path.basename(relativePath)}`,
    )
    fs.renameSync(source, temporaryPath)
    return { relativePath, temporaryPath }
  }

  restore(staged: { relativePath: string; temporaryPath: string }): void {
    if (!fs.existsSync(staged.temporaryPath)) return
    fs.renameSync(staged.temporaryPath, this.resolve(staged.relativePath))
  }

  finalizeRemove(staged: { relativePath: string; temporaryPath: string }): void {
    // The database deletion has committed; a cleanup failure must not report
    // the record as undeleted or restore a file no longer referenced by it.
    try {
      fs.unlinkSync(staged.temporaryPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        console.error('简历回收文件清理失败', error)
    }
  }

  private assertDirectory(directory: string): void {
    const metadata = fs.lstatSync(directory)
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw new AppServiceError('FILE_IMPORT_FAILED', '简历存储目录不能是链接')
  }
}
