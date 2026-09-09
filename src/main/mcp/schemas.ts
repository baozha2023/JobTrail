import { z } from 'zod'

export const positiveIdSchema = z.number().int().positive()
export const timestampSchema = z.number().int().nonnegative()
const requiredText = z.string().refine((value) => value.trim().length > 0, 'Must not be blank')
const nullableText = z.string().nullable()
const idList = z.array(positiveIdSchema)

const nonEmptyUpdate = <T extends z.ZodRawShape>(shape: T) =>
  z.strictObject(shape).refine((value) => Object.values(value).some((item) => item !== undefined), {
    message: 'At least one update field is required',
  })

export const statusSchema = z.strictObject({
  id: positiveIdSchema,
  label: z.string(),
  sortOrder: z.number().int(),
  isBuiltin: z.boolean(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
})

export const industrySchema = z.strictObject({
  id: positiveIdSchema,
  name: z.string(),
  sortOrder: z.number().int(),
  isBuiltin: z.boolean(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
})

export const companySchema = z.strictObject({
  id: positiveIdSchema,
  name: z.string(),
  industryIds: idList,
  industryName: z.string().nullable(),
  careerUrl: z.string().nullable(),
  lastReadAt: timestampSchema.nullable(),
  aliases: z.array(z.string()),
  isBuiltin: z.boolean(),
  isFavorite: z.boolean(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
})

export const resumeSchema = z.strictObject({
  id: positiveIdSchema,
  name: z.string(),
  relativePath: z.string(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  sha256: z.string().nullable(),
  note: z.string().nullable(),
  sortOrder: z.number().int(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
})

export const resumeImportSchema = resumeSchema.extend({ originalExtension: z.string() })

export const opportunitySchema = z.strictObject({
  id: positiveIdSchema,
  companyId: positiveIdSchema,
  companyName: z.string(),
  title: z.string(),
  department: z.string().nullable(),
  location: z.string().nullable(),
  source: z.string().nullable(),
  jobUrl: z.string().nullable(),
  description: z.string().nullable(),
  statusId: positiveIdSchema,
  statusLabel: z.string(),
  resumeVersionId: positiveIdSchema.nullable(),
  resumeVersionName: z.string().nullable(),
  discoveredAt: timestampSchema.nullable(),
  appliedAt: timestampSchema.nullable(),
  deadlineAt: timestampSchema.nullable(),
  notes: z.string().nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
})

export const calendarEventSchema = z.strictObject({
  id: positiveIdSchema,
  opportunityId: positiveIdSchema.nullable(),
  opportunityTitle: z.string().nullable(),
  opportunityJobUrl: z.string().nullable(),
  companyName: z.string().nullable(),
  title: z.string(),
  eventType: z.string(),
  startAt: timestampSchema,
  endAt: timestampSchema,
  isAllDay: z.boolean(),
  timezone: z.string(),
  location: z.string().nullable(),
  description: z.string().nullable(),
  reminderMinutes: z.number().int().nonnegative().nullable(),
  isCompleted: z.boolean(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
})

export const createStatusInputSchema = z.strictObject({ label: requiredText })
export const updateStatusInputSchema = nonEmptyUpdate({ label: requiredText.optional() })
export const createIndustryInputSchema = z.strictObject({ name: requiredText })
export const updateIndustryInputSchema = nonEmptyUpdate({ name: requiredText.optional() })

const companyInputShape = {
  name: requiredText,
  industryIds: idList.optional(),
  careerUrl: nullableText.optional(),
  aliases: z.array(z.string()).optional(),
}
export const createCompanyInputSchema = z.strictObject(companyInputShape)
export const updateCompanyInputSchema = nonEmptyUpdate({
  name: requiredText.optional(),
  industryIds: idList.optional(),
  careerUrl: nullableText.optional(),
  aliases: z.array(z.string()).optional(),
  isFavorite: z.boolean().optional(),
})

export const updateResumeInputSchema = nonEmptyUpdate({
  name: requiredText.optional(),
  note: nullableText.optional(),
})

const opportunityInputShape = {
  companyId: positiveIdSchema,
  title: requiredText,
  department: nullableText.optional(),
  location: nullableText.optional(),
  source: nullableText.optional(),
  jobUrl: nullableText.optional(),
  description: nullableText.optional(),
  statusId: positiveIdSchema,
  resumeVersionId: positiveIdSchema.nullable().optional(),
  discoveredAt: timestampSchema.nullable().optional(),
  appliedAt: timestampSchema.nullable().optional(),
  deadlineAt: timestampSchema.nullable().optional(),
  notes: nullableText.optional(),
}
export const createOpportunityInputSchema = z.strictObject(opportunityInputShape)
export const updateOpportunityInputSchema = nonEmptyUpdate(
  Object.fromEntries(
    Object.entries(opportunityInputShape).map(([key, schema]) => [key, schema.optional()]),
  ) as {
    [K in keyof typeof opportunityInputShape]: z.ZodOptional<(typeof opportunityInputShape)[K]>
  },
)

const calendarInputShape = {
  opportunityId: positiveIdSchema.nullable().optional(),
  title: requiredText,
  eventType: requiredText,
  startAt: timestampSchema,
  endAt: timestampSchema,
  isAllDay: z.boolean().optional(),
  timezone: requiredText.optional(),
  location: nullableText.optional(),
  description: nullableText.optional(),
  reminderMinutes: z.number().int().nonnegative().nullable().optional(),
}
export const createCalendarInputSchema = z
  .strictObject(calendarInputShape)
  .refine((value) => value.endAt >= value.startAt, { message: 'endAt must be >= startAt' })
export const updateCalendarInputSchema = nonEmptyUpdate(
  Object.fromEntries(
    Object.entries(calendarInputShape).map(([key, schema]) => [key, schema.optional()]),
  ) as { [K in keyof typeof calendarInputShape]: z.ZodOptional<(typeof calendarInputShape)[K]> },
)

export const opportunityQuerySchema = z.strictObject({
  search: z.string().optional(),
  statusId: positiveIdSchema.nullable().optional(),
  companyId: positiveIdSchema.nullable().optional(),
})

export const calendarRangeSchema = z
  .strictObject({ startAt: timestampSchema, endAt: timestampSchema })
  .refine((value) => value.endAt >= value.startAt, { message: 'endAt must be >= startAt' })

export const idInputSchema = z.strictObject({ id: positiveIdSchema })
export const orderInputSchema = z.strictObject({
  order: idList
    .min(1)
    .refine((value) => new Set(value).size === value.length, 'IDs must be unique'),
})

export const itemOutput = <T extends z.ZodType>(schema: T) => z.strictObject({ item: schema })
export const itemsOutput = <T extends z.ZodType>(schema: T) =>
  z.strictObject({ items: z.array(schema) })
export const deleteOutputSchema = z.strictObject({ deleted: z.literal(true), id: positiveIdSchema })
