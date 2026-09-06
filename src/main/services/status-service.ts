import type { CreateStatusInput, Status, UpdateStatusInput } from '../../shared/types'
import { StatusRepository } from '../repositories/status-repository'
import { AppServiceError, assertPositiveId, uniqueError } from './errors'

const builtinMessage = '该数据为内置，无法删除/修改'

export class StatusService {
  constructor(private readonly repository: StatusRepository, private readonly allowBuiltinEdit: boolean) {}
  list(): Status[] { return this.repository.list().map((row) => this.repository.map(row)) }
  get(id: number): Status {
    assertPositiveId(id, '状态 ID')
    const row = this.repository.get(id)
    if (!row) throw new AppServiceError('NOT_FOUND', '状态不存在')
    return this.repository.map(row)
  }
  create(input: CreateStatusInput): Status {
    const label = input.label.trim()
    if (!label) throw new AppServiceError('VALIDATION_ERROR', '状态名称不能为空')
    try {
      const timestamp = Date.now()
      const id = this.repository.create({ label }, this.repository.maxSortOrder() + 1, timestamp)
      return this.get(id)
    } catch (error) {
      if (uniqueError(error)) throw new AppServiceError('VALIDATION_ERROR', '状态名称已存在')
      throw error
    }
  }
  update(id: number, input: UpdateStatusInput): Status {
    const current = this.get(id)
    if (current.isBuiltin && !this.allowBuiltinEdit) throw new AppServiceError('BUILTIN_DATA', builtinMessage)
    const label = input.label === undefined ? current.label : input.label.trim()
    if (!label) throw new AppServiceError('VALIDATION_ERROR', '状态名称不能为空')
    try {
      this.repository.update(id, { label }, Date.now())
      return this.get(id)
    } catch (error) {
      if (uniqueError(error)) throw new AppServiceError('VALIDATION_ERROR', '状态名称已存在')
      throw error
    }
  }
  delete(id: number): void {
    const current = this.get(id)
    if (current.isBuiltin && !this.allowBuiltinEdit) throw new AppServiceError('BUILTIN_DATA', builtinMessage)
    const used = this.repository.countUsage(id)
    if (used > 0) throw new AppServiceError('STATUS_IN_USE', '当前状态正在被使用，不能删除', { count: used })
    if (this.repository.count() <= 1) throw new AppServiceError('LAST_STATUS', '至少需要保留一个状态')
    if (this.repository.delete(id) === 0) throw new AppServiceError('NOT_FOUND', '状态不存在')
  }
  reorder(order: number[]): Status[] {
    const current = this.list().map((status) => status.id)
    if (order.length !== current.length || new Set(order).size !== order.length || order.some((id) => !current.includes(id))) {
      throw new AppServiceError('VALIDATION_ERROR', '状态顺序无效')
    }
    this.repository.reorder(order, Date.now())
    return this.list()
  }
}
