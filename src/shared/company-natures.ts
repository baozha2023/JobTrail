import { z } from 'zod'

// Wire codes are shared; dictionary records and their order live in SQLite.
export const companyNatureSchema = z.enum([
  'state_owned',
  'private',
  'foreign_invested',
  'public_institution',
  'social_organization',
  'other',
])

export const companyNatureFilterSchema = z
  .array(companyNatureSchema)
  .max(6)
  .refine((values) => new Set(values).size === values.length)
