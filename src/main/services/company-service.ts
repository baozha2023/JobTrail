import type { Company, CreateCompanyInput, UpdateCompanyInput } from '../../shared/types'
import { CompanyRepository } from '../repositories/company-repository'
import { IndustryRepository } from '../repositories/industry-repository'
import {
  AppServiceError,
  assertNonEmptyUpdate,
  assertPositiveId,
  nullableText,
  uniqueError,
} from './errors'
import type { UnitOfWork } from './unit-of-work'

const builtinMessage = '该数据为内置，无法删除/修改'

function normalizeAliases(value: string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined
  const normalized = [
    ...new Set(value.map((item) => item.trim()).filter((item) => item.length > 0)),
  ]
  return normalized
}

function normalizeIndustryIds(value: number[]): number[] {
  return [...new Set(value)]
}

export class CompanyService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly repository: CompanyRepository,
    private readonly industries: IndustryRepository,
    private readonly allowBuiltinEdit: boolean,
  ) {}

  search(keyword: string): Company[] {
    return this.repository.mapMany(this.repository.search(keyword.trim()))
  }
  list(): Company[] {
    return this.repository.mapMany(this.repository.list())
  }
  get(id: number): Company {
    assertPositiveId(id, '公司 ID')
    const row = this.repository.get(id)
    if (!row) throw new AppServiceError('NOT_FOUND', '公司不存在')
    return this.repository.map(row)
  }
  markRead(id: number): Company {
    return this.unitOfWork.run(() => {
      const current = this.get(id)
      if (this.repository.markRead(current.id, Date.now()) === 0)
        throw new AppServiceError('NOT_FOUND', '公司不存在')
      return this.get(id)
    })
  }
  create(input: CreateCompanyInput): Company {
    try {
      return this.unitOfWork.run(() => {
        const name = input.name.trim()
        if (!name) throw new AppServiceError('VALIDATION_ERROR', '公司名称不能为空')
        const industryIds = normalizeIndustryIds(input.industryIds ?? [])
        this.validateIndustries(industryIds)
        const aliases = normalizeAliases(input.aliases) ?? []
        const id = this.repository.create(
          { name, industryIds, careerUrl: nullableText(input.careerUrl), aliases },
          Date.now(),
        )
        return this.get(id)
      })
    } catch (error) {
      if (uniqueError(error)) throw new AppServiceError('VALIDATION_ERROR', '公司名称已存在')
      throw error
    }
  }
  update(id: number, input: UpdateCompanyInput): Company {
    try {
      return this.unitOfWork.run(() => {
        assertNonEmptyUpdate(input, '公司')
        const current = this.get(id)
        const changesCompanyData =
          input.name !== undefined ||
          input.industryIds !== undefined ||
          input.careerUrl !== undefined ||
          input.aliases !== undefined
        if (current.isBuiltin && changesCompanyData && !this.allowBuiltinEdit)
          throw new AppServiceError('BUILTIN_DATA', builtinMessage)
        const name = input.name === undefined ? current.name : input.name.trim()
        if (!name) throw new AppServiceError('VALIDATION_ERROR', '公司名称不能为空')
        const industryIds =
          input.industryIds === undefined
            ? current.industryIds
            : normalizeIndustryIds(input.industryIds)
        this.validateIndustries(industryIds)
        const aliases = input.aliases === undefined ? undefined : normalizeAliases(input.aliases)
        this.repository.update(
          id,
          {
            name,
            industryIds,
            careerUrl:
              input.careerUrl === undefined ? current.careerUrl : nullableText(input.careerUrl),
            ...(aliases === undefined ? {} : { aliases }),
            isFavorite: input.isFavorite === undefined ? current.isFavorite : input.isFavorite,
          },
          Date.now(),
        )
        return this.get(id)
      })
    } catch (error) {
      if (uniqueError(error)) throw new AppServiceError('VALIDATION_ERROR', '公司名称已存在')
      throw error
    }
  }
  delete(id: number): void {
    this.unitOfWork.run(() => {
      const current = this.get(id)
      if (current.isBuiltin && !this.allowBuiltinEdit)
        throw new AppServiceError('BUILTIN_DATA', builtinMessage)
      const used = this.repository.countUsage(id)
      if (used > 0)
        throw new AppServiceError('COMPANY_IN_USE', '当前公司正在被求职记录使用，不能删除', {
          count: used,
        })
      if (this.repository.delete(id) === 0) throw new AppServiceError('NOT_FOUND', '公司不存在')
    })
  }

  private validateIndustries(industryIds: number[]): void {
    industryIds.forEach((industryId) => {
      assertPositiveId(industryId, '行业分类 ID')
      if (!this.industries.get(industryId))
        throw new AppServiceError('VALIDATION_ERROR', '行业分类不存在')
    })
  }
}
