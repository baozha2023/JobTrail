import type { CompanyCatalogStatus, CompanyCatalogUpdateResult } from '../../shared/types'
import type { CompanyCatalogDocument } from '../company-catalog'
import type {
  CatalogCompanySnapshot,
  CompanyCatalogRepository,
} from '../repositories/company-catalog-repository'
import { AppServiceError, uniqueError } from './errors'
import type { UnitOfWork } from './unit-of-work'

function sameValues<T extends number | string>(first: T[], second: T[]): boolean {
  if (first.length !== second.length) return false
  const left = [...first].sort()
  const right = [...second].sort()
  return left.every((value, index) => value === right[index])
}

function matchesCatalog(
  current: CatalogCompanySnapshot,
  entry: CompanyCatalogDocument['companies'][number],
): boolean {
  return (
    current.name === entry.name &&
    current.builtinKey === entry.builtinKey &&
    current.careerUrl === entry.careerUrl &&
    sameValues(current.industryIds, entry.industryIds) &&
    sameValues(current.aliases, entry.aliases)
  )
}

export class CompanyCatalogService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly repository: CompanyCatalogRepository,
  ) {}

  status(): CompanyCatalogStatus {
    const state = this.repository.state()
    return {
      formatVersion: state.format_version,
      catalogVersion: state.catalog_version,
      appliedAt: state.applied_at,
    }
  }

  synchronize(catalog: CompanyCatalogDocument, hash: string): CompanyCatalogUpdateResult {
    const currentState = this.repository.state()
    if (catalog.catalogVersion < currentState.catalog_version)
      throw new AppServiceError('CATALOG_VERSION_ROLLBACK', '当前内置公司数据无法使用，请稍后再试')
    if (catalog.catalogVersion === currentState.catalog_version) {
      if (hash !== currentState.content_sha256)
        throw new AppServiceError('CATALOG_INVALID', '获取的内置公司数据有误，请稍后重试')
      return {
        status: 'up-to-date',
        previousVersion: currentState.catalog_version,
        currentVersion: currentState.catalog_version,
        added: 0,
        updated: 0,
        adopted: 0,
        unchanged: catalog.companies.length,
      }
    }

    const builtinIndustryIds = this.repository.builtinIndustryIds()
    for (const company of catalog.companies) {
      if (company.industryIds.some((industryId) => !builtinIndustryIds.has(industryId)))
        throw new AppServiceError('CATALOG_INVALID', '获取的内置公司数据有误，请稍后重试')
    }

    try {
      return this.unitOfWork.run(() => {
        const timestamp = Date.now()
        let added = 0
        let updated = 0
        let adopted = 0
        let unchanged = 0

        for (const entry of catalog.companies) {
          const keyed = this.repository.findByBuiltinKey(entry.builtinKey)
          if (keyed) {
            const nameOwner = this.repository.findByName(entry.name)
            if (nameOwner && nameOwner.id !== keyed.id)
              throw new AppServiceError(
                'CATALOG_CONFLICT',
                '本地公司与新数据存在冲突，请检查公司名称后重试',
              )
            if (matchesCatalog(keyed, entry)) unchanged += 1
            else {
              this.repository.replaceCatalogData(keyed.id, entry, timestamp)
              updated += 1
            }
            continue
          }

          const sameName = this.repository.findByName(entry.name)
          if (sameName) {
            if (sameName.builtinKey !== null)
              throw new AppServiceError(
                'CATALOG_CONFLICT',
                '本地公司与新数据存在冲突，请检查公司名称后重试',
              )
            this.repository.replaceCatalogData(sameName.id, entry, timestamp)
            adopted += 1
          } else {
            this.repository.insert(entry, timestamp)
            added += 1
          }
        }

        this.repository.updateState(catalog.formatVersion, catalog.catalogVersion, hash, timestamp)
        return {
          status: 'updated',
          previousVersion: currentState.catalog_version,
          currentVersion: catalog.catalogVersion,
          added,
          updated,
          adopted,
          unchanged,
        }
      })
    } catch (error) {
      if (uniqueError(error))
        throw new AppServiceError(
          'CATALOG_CONFLICT',
          '本地公司与新数据存在冲突，请检查公司名称后重试',
        )
      throw error
    }
  }
}
