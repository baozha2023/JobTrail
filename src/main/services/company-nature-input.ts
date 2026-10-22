import { companyNatureFilterSchema, companyNatureSchema } from '../../shared/company-natures'
import type { CompanyNature } from '../../shared/types'
import { AppServiceError } from './errors'

export function companyNatureInput(value: unknown): CompanyNature | null {
  const parsed = companyNatureSchema.nullable().safeParse(value)
  if (!parsed.success) throw new AppServiceError('VALIDATION_ERROR', '企业性质无效')
  return parsed.data
}

export function companyNaturesInput(value: unknown): CompanyNature[] {
  const parsed = companyNatureFilterSchema.safeParse(value)
  if (!parsed.success) throw new AppServiceError('VALIDATION_ERROR', '企业性质筛选无效')
  return parsed.data
}
