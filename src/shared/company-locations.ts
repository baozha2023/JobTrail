import { z } from 'zod'

export const MAX_COMPANY_LOCATIONS = 100
export const MAX_LOCATION_LENGTH = 200

export const companyLocationsInputSchema = z
  .array(
    z.string().refine((value) => {
      const length = value.trim().length
      return length > 0 && length <= MAX_LOCATION_LENGTH
    }, 'Invalid company location'),
  )
  .max(MAX_COMPANY_LOCATIONS)

export const locationPrefixSchema = z
  .string()
  .refine((value) => value.trim().length <= MAX_LOCATION_LENGTH, 'Invalid location prefix')

export function normalizeCompanyLocations(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()))]
}
