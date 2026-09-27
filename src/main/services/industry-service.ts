import type {
  CreateIndustryInput,
  Industry,
  ReorderIndustriesInput,
  UpdateIndustryInput,
} from '../../shared/types'
import { IndustryRepository } from '../repositories/industry-repository'
import { AppServiceError, assertNonEmptyUpdate, assertPositiveId, uniqueError } from './errors'
import type { UnitOfWork } from './unit-of-work'

export class IndustryService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly repository: IndustryRepository,
    private readonly allowBuiltinEdit: boolean,
  ) {}
  list(): Industry[] {
    return this.repository.list().map((row) => this.repository.map(row))
  }
  get(id: number): Industry {
    assertPositiveId(id, '行业分类 ID')
    const row = this.repository.get(id)
    if (!row) throw new AppServiceError('NOT_FOUND', '行业分类不存在')
    return this.repository.map(row)
  }
  private assertParent(id: number): void {
    if (this.get(id).parentId !== null)
      throw new AppServiceError('VALIDATION_ERROR', '所属分类必须是一级行业')
  }
  private name(value: string): string {
    const name = value.trim()
    if (!name) throw new AppServiceError('VALIDATION_ERROR', '行业分类名称不能为空')
    return name
  }
  private assertEditable(industry: Industry): void {
    if (industry.isBuiltin && !this.allowBuiltinEdit)
      throw new AppServiceError('BUILTIN_DATA', '该数据为内置，无法删除/修改')
  }
  create(input: CreateIndustryInput): Industry {
    try {
      return this.unitOfWork.run(() => {
        this.assertParent(input.parentId)
        const id = this.repository.create(
          { name: this.name(input.name), parentId: input.parentId },
          Date.now(),
        )
        return this.get(id)
      })
    } catch (error) {
      if (uniqueError(error))
        throw new AppServiceError('VALIDATION_ERROR', '同一分类下的行业名称已存在')
      throw error
    }
  }
  update(id: number, input: UpdateIndustryInput): Industry {
    try {
      return this.unitOfWork.run(() => {
        assertNonEmptyUpdate(input, '行业分类')
        const current = this.get(id)
        this.assertEditable(current)
        if (input.parentId !== undefined) {
          if (current.parentId === null)
            throw new AppServiceError('VALIDATION_ERROR', '不能改变一级行业的层级')
          this.assertParent(input.parentId)
        }
        this.repository.update(
          this.repository.get(id)!,
          input.name === undefined ? current.name : this.name(input.name),
          input.parentId ?? current.parentId,
          Date.now(),
        )
        return this.get(id)
      })
    } catch (error) {
      if (uniqueError(error))
        throw new AppServiceError('VALIDATION_ERROR', '同一分类下的行业名称已存在')
      throw error
    }
  }
  delete(id: number): void {
    this.unitOfWork.run(() => {
      const current = this.get(id)
      this.assertEditable(current)
      if (current.parentId === null && this.repository.siblings(id).length)
        throw new AppServiceError('INDUSTRY_IN_USE', '请先删除或移动该分类下的二级行业')
      const count = this.repository.countUsage(id)
      if (count)
        throw new AppServiceError('INDUSTRY_IN_USE', '当前行业分类正在被公司使用，不能删除', {
          count,
        })
      this.repository.delete(id)
      this.repository.reorder(
        this.repository.siblings(current.parentId).map((row) => row.id),
        Date.now(),
      )
    })
  }
  reorder(input: ReorderIndustriesInput): Industry[] {
    return this.unitOfWork.run(() => {
      if (input.parentId !== null) this.assertParent(input.parentId)
      const current = this.repository.siblings(input.parentId).map((row) => row.id)
      if (
        input.order.length !== current.length ||
        new Set(input.order).size !== current.length ||
        input.order.some((id) => !current.includes(id))
      )
        throw new AppServiceError('VALIDATION_ERROR', '请提交同一分类下的完整行业顺序')
      this.repository.reorder(input.order, Date.now())
      return this.list()
    })
  }
}
