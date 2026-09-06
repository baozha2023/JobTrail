import type { CreateIndustryInput, Industry, UpdateIndustryInput } from '../../shared/types'
import { IndustryRepository } from '../repositories/industry-repository'
import { AppServiceError, assertPositiveId, uniqueError } from './errors'

const builtinMessage = '该数据为内置，无法删除/修改'

export class IndustryService {
  constructor(private readonly repository: IndustryRepository, private readonly allowBuiltinEdit: boolean) {}
  list(): Industry[] { return this.repository.list().map((row) => this.repository.map(row)) }
  get(id: number): Industry {
    assertPositiveId(id, '行业分类 ID')
    const row = this.repository.get(id)
    if (!row) throw new AppServiceError('NOT_FOUND', '行业分类不存在')
    return this.repository.map(row)
  }
  create(input: CreateIndustryInput): Industry {
    const name = input.name.trim()
    if (!name) throw new AppServiceError('VALIDATION_ERROR', '行业分类名称不能为空')
    try {
      const timestamp = Date.now()
      const id = this.repository.create({ name }, this.repository.maxSortOrder() + 1, timestamp)
      return this.get(id)
    } catch (error) {
      if (uniqueError(error)) throw new AppServiceError('VALIDATION_ERROR', '行业分类名称已存在')
      throw error
    }
  }
  update(id: number, input: UpdateIndustryInput): Industry {
    const current = this.get(id)
    if (current.isBuiltin && !this.allowBuiltinEdit) throw new AppServiceError('BUILTIN_DATA', builtinMessage)
    const name = input.name === undefined ? current.name : input.name.trim()
    if (!name) throw new AppServiceError('VALIDATION_ERROR', '行业分类名称不能为空')
    try {
      this.repository.update(id, { name }, Date.now())
      return this.get(id)
    } catch (error) {
      if (uniqueError(error)) throw new AppServiceError('VALIDATION_ERROR', '行业分类名称已存在')
      throw error
    }
  }
  delete(id: number): void {
    const current = this.get(id)
    if (current.isBuiltin && !this.allowBuiltinEdit) throw new AppServiceError('BUILTIN_DATA', builtinMessage)
    const used = this.repository.countUsage(id)
    if (used > 0) throw new AppServiceError('INDUSTRY_IN_USE', '当前行业分类正在被公司使用，不能删除', { count: used })
    if (this.repository.delete(id) === 0) throw new AppServiceError('NOT_FOUND', '行业分类不存在')
  }
  reorder(order: number[]): Industry[] {
    const current = this.list().map((industry) => industry.id)
    if (order.length !== current.length || new Set(order).size !== order.length || order.some((id) => !current.includes(id))) {
      throw new AppServiceError('VALIDATION_ERROR', '行业分类顺序无效')
    }
    this.repository.reorder(order, Date.now())
    return this.list()
  }
}
