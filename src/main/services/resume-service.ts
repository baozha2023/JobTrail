import path from 'node:path'
import type {
  ResumeImportResult,
  ResumeVersion,
  UpdateResumeVersionInput,
} from '../../shared/types'
import { FileStorageService, type ResumeSourceInfo } from '../file-storage'
import { ResumeRepository } from '../repositories/resume-repository'
import { AppServiceError, assertNonEmptyUpdate, assertPositiveId, nullableText } from './errors'
import type { UnitOfWork } from './unit-of-work'

export class ResumeService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly repository: ResumeRepository,
    private readonly files: FileStorageService,
  ) {}
  list(): ResumeVersion[] {
    return this.repository.list().map((row) => this.repository.map(row))
  }
  get(id: number): ResumeVersion {
    assertPositiveId(id, '简历版本 ID')
    const row = this.repository.get(id)
    if (!row) throw new AppServiceError('NOT_FOUND', '简历版本不存在')
    return this.repository.map(row)
  }
  inspectSource(sourcePath: string): ResumeSourceInfo {
    return this.files.inspectResumeSource(sourcePath)
  }
  importFromPath(sourcePath: string, name?: string, note?: string): ResumeImportResult {
    return this.unitOfWork.run((lifecycle) => {
      const imported = this.files.importResume(sourcePath)
      lifecycle.afterRollback(() => this.files.remove(imported.relativePath))
      const id = this.repository.create(
        name?.trim() || path.basename(sourcePath, path.extname(sourcePath)),
        imported.relativePath,
        imported.sizeBytes,
        imported.sha256,
        nullableText(note),
        this.repository.maxSortOrder() + 1,
        Date.now(),
      )
      return { ...this.get(id), originalExtension: imported.originalExtension }
    })
  }
  getPath(id: number): string {
    return this.files.resolve(this.get(id).relativePath)
  }
  update(id: number, input: UpdateResumeVersionInput): ResumeVersion {
    return this.unitOfWork.run(() => {
      assertNonEmptyUpdate(input, '简历版本')
      assertPositiveId(id, '简历版本 ID')
      const current = this.repository.get(id)
      if (!current) throw new AppServiceError('NOT_FOUND', '简历版本不存在')
      const name = input.name === undefined ? current.name : input.name.trim()
      if (!name) throw new AppServiceError('VALIDATION_ERROR', '简历版本名称不能为空')
      this.repository.update(
        id,
        { name, note: input.note === undefined ? current.note : nullableText(input.note) },
        current,
        Date.now(),
      )
      return this.get(id)
    })
  }
  reorder(order: number[]): ResumeVersion[] {
    return this.unitOfWork.run(() => {
      const current = this.list().map((resume) => resume.id)
      if (
        order.length !== current.length ||
        new Set(order).size !== order.length ||
        order.some((id) => !current.includes(id))
      ) {
        throw new AppServiceError('VALIDATION_ERROR', '简历版本顺序无效')
      }
      this.repository.reorder(order, Date.now())
      return this.list()
    })
  }
  delete(id: number): void {
    this.unitOfWork.run((lifecycle) => {
      assertPositiveId(id, '简历版本 ID')
      const current = this.repository.get(id)
      if (!current) throw new AppServiceError('NOT_FOUND', '简历版本不存在')
      const used = this.repository.countUsage(id)
      if (used > 0)
        throw new AppServiceError('RESUME_IN_USE', '当前简历版本正在被使用，不能删除', {
          count: used,
        })
      const staged = this.files.stageRemove(current.relative_path)
      lifecycle.afterRollback(() => this.files.restore(staged))
      lifecycle.afterCommit(() => this.files.finalizeRemove(staged))
      if (this.repository.delete(id) === 0) throw new AppServiceError('NOT_FOUND', '简历版本不存在')
    })
  }
}
