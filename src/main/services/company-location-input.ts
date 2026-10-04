import {
  companyLocationsInputSchema,
  locationPrefixSchema,
  normalizeCompanyLocations,
} from '../../shared/company-locations'
import { AppServiceError } from './errors'

export function companyLocationsInput(value: unknown): string[] {
  const result = companyLocationsInputSchema.safeParse(value)
  if (!result.success) throw new AppServiceError('VALIDATION_ERROR', '公司地点格式无效')
  return normalizeCompanyLocations(result.data)
}

export function companyLocationPrefix(value: unknown): string {
  const result = locationPrefixSchema.safeParse(value)
  if (!result.success) throw new AppServiceError('VALIDATION_ERROR', '地点搜索前缀格式无效')
  return result.data.trim()
}
