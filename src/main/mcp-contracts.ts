import { z } from 'zod'
import type { Services } from './service-container'
import {
  calendarEventSchema,
  calendarRangeSchema,
  companySchema,
  createCalendarInputSchema,
  createCompanyInputSchema,
  createIndustryInputSchema,
  createOpportunityInputSchema,
  createStatusInputSchema,
  deleteOutputSchema,
  idInputSchema,
  industrySchema,
  itemOutput,
  itemsOutput,
  opportunityQuerySchema,
  opportunitySchema,
  orderInputSchema,
  positiveIdSchema,
  resumeImportSchema,
  resumeSchema,
  statusSchema,
  updateCalendarInputSchema,
  updateCompanyInputSchema,
  updateIndustryInputSchema,
  updateOpportunityInputSchema,
  updateResumeInputSchema,
  updateStatusInputSchema,
} from './mcp/schemas'

interface McpToolDescriptorBase {
  name: string
  title: string
  description: string
  destructive: boolean
  idempotent: boolean
  inputSchema: z.ZodType
  outputSchema: z.ZodType
  execute: (services: Services, args: Record<string, unknown>) => Record<string, unknown>
}

export type McpReadToolDescriptor = McpToolDescriptorBase & {
  readOnly: true
  preview?: never
}

export type McpWriteToolDescriptor = McpToolDescriptorBase & {
  readOnly: false
  preview: (services: Services, args: Record<string, unknown>) => McpMutationPreview
}

export type McpToolDescriptor = McpReadToolDescriptor | McpWriteToolDescriptor

export interface McpMutationPreview {
  entityType: string
  before: unknown
  after: unknown
}

type McpToolDefinition<I extends z.ZodType, O extends z.ZodType> = {
  name: string
  title: string
  description: string
  destructive?: boolean
  idempotent?: boolean
  inputSchema: I
  outputSchema: O
  execute: (services: Services, args: z.output<I>) => z.input<O>
} & (
  | { readOnly: true; preview?: never }
  | {
      readOnly: false
      preview: (services: Services, args: z.output<I>) => McpMutationPreview
    }
)

function tool<I extends z.ZodType, O extends z.ZodType>(
  definition: McpToolDefinition<I, O>,
): McpToolDescriptor {
  return {
    ...definition,
    destructive: definition.destructive ?? false,
    idempotent: definition.idempotent ?? false,
    execute: definition.execute as unknown as (
      services: Services,
      args: Record<string, unknown>,
    ) => Record<string, unknown>,
  } as McpToolDescriptor
}

const emptyInput = z.strictObject({})
const createStatusArgs = z.strictObject({ input: createStatusInputSchema })
const updateStatusArgs = z.strictObject({ id: positiveIdSchema, input: updateStatusInputSchema })
const createIndustryArgs = z.strictObject({ input: createIndustryInputSchema })
const updateIndustryArgs = z.strictObject({
  id: positiveIdSchema,
  input: updateIndustryInputSchema,
})
const keywordArgs = z.strictObject({ keyword: z.string() })
const createCompanyArgs = z.strictObject({ input: createCompanyInputSchema })
const updateCompanyArgs = z.strictObject({ id: positiveIdSchema, input: updateCompanyInputSchema })
const importResumeArgs = z.strictObject({
  sourcePath: z.string().min(1),
  name: z.string().optional(),
  note: z.string().optional(),
})
const updateResumeArgs = z.strictObject({ id: positiveIdSchema, input: updateResumeInputSchema })
const opportunitySearchArgs = z.strictObject({ query: opportunityQuerySchema })
const createOpportunityArgs = z.strictObject({ input: createOpportunityInputSchema })
const updateOpportunityArgs = z.strictObject({
  id: positiveIdSchema,
  input: updateOpportunityInputSchema,
})
const changeStatusArgs = z.strictObject({ id: positiveIdSchema, statusId: positiveIdSchema })
const calendarListArgs = z.strictObject({ range: calendarRangeSchema })
const createCalendarArgs = z.strictObject({ input: createCalendarInputSchema })
const updateCalendarArgs = z.strictObject({
  id: positiveIdSchema,
  input: updateCalendarInputSchema,
})
const completeCalendarArgs = z.strictObject({ id: positiveIdSchema, completed: z.boolean() })

export const MCP_TOOLS: readonly McpToolDescriptor[] = [
  tool({
    name: 'list_statuses',
    title: 'List statuses',
    description: 'List all job statuses in display order.',
    readOnly: true,
    inputSchema: emptyInput,
    outputSchema: itemsOutput(statusSchema),
    execute: (s) => ({ items: s.statuses.list() }),
  }),
  tool({
    name: 'get_status',
    title: 'Get status',
    description: 'Get one job status by ID.',
    readOnly: true,
    inputSchema: idInputSchema,
    outputSchema: itemOutput(statusSchema),
    execute: (s, a) => ({ item: s.statuses.get(a.id) }),
  }),
  tool({
    name: 'create_status',
    title: 'Create status',
    description: 'Create a custom job status.',
    readOnly: false,
    inputSchema: createStatusArgs,
    outputSchema: itemOutput(statusSchema),
    preview: (_s, a) => ({ entityType: 'status', before: null, after: a.input }),
    execute: (s, a) => ({ item: s.statuses.create(a.input) }),
  }),
  tool({
    name: 'update_status',
    title: 'Update status',
    description: 'Update a custom job status.',
    readOnly: false,
    idempotent: true,
    inputSchema: updateStatusArgs,
    outputSchema: itemOutput(statusSchema),
    preview: (s, a) => {
      const before = s.statuses.get(a.id)
      return { entityType: 'status', before, after: { ...before, ...a.input } }
    },
    execute: (s, a) => ({ item: s.statuses.update(a.id, a.input) }),
  }),
  tool({
    name: 'delete_status',
    title: 'Delete status',
    description: 'Delete an unused custom job status.',
    readOnly: false,
    destructive: true,
    idempotent: true,
    inputSchema: idInputSchema,
    outputSchema: deleteOutputSchema,
    preview: (s, a) => ({ entityType: 'status', before: s.statuses.get(a.id), after: null }),
    execute: (s, a) => {
      s.statuses.delete(a.id)
      return { deleted: true as const, id: a.id }
    },
  }),
  tool({
    name: 'reorder_statuses',
    title: 'Reorder statuses',
    description: 'Set the complete display order of job statuses.',
    readOnly: false,
    idempotent: true,
    inputSchema: orderInputSchema,
    outputSchema: itemsOutput(statusSchema),
    preview: (s, a) => ({
      entityType: 'status_order',
      before: s.statuses.list().map(({ id, updatedAt }) => ({ id, updatedAt })),
      after: a.order,
    }),
    execute: (s, a) => ({ items: s.statuses.reorder(a.order) }),
  }),

  tool({
    name: 'list_industries',
    title: 'List industries',
    description: 'List all industries in display order.',
    readOnly: true,
    inputSchema: emptyInput,
    outputSchema: itemsOutput(industrySchema),
    execute: (s) => ({ items: s.industries.list() }),
  }),
  tool({
    name: 'get_industry',
    title: 'Get industry',
    description: 'Get one industry by ID.',
    readOnly: true,
    inputSchema: idInputSchema,
    outputSchema: itemOutput(industrySchema),
    execute: (s, a) => ({ item: s.industries.get(a.id) }),
  }),
  tool({
    name: 'create_industry',
    title: 'Create industry',
    description: 'Create a custom industry.',
    readOnly: false,
    inputSchema: createIndustryArgs,
    outputSchema: itemOutput(industrySchema),
    preview: (_s, a) => ({ entityType: 'industry', before: null, after: a.input }),
    execute: (s, a) => ({ item: s.industries.create(a.input) }),
  }),
  tool({
    name: 'update_industry',
    title: 'Update industry',
    description: 'Update a custom industry.',
    readOnly: false,
    idempotent: true,
    inputSchema: updateIndustryArgs,
    outputSchema: itemOutput(industrySchema),
    preview: (s, a) => {
      const before = s.industries.get(a.id)
      return { entityType: 'industry', before, after: { ...before, ...a.input } }
    },
    execute: (s, a) => ({ item: s.industries.update(a.id, a.input) }),
  }),
  tool({
    name: 'delete_industry',
    title: 'Delete industry',
    description: 'Delete an unused custom industry.',
    readOnly: false,
    destructive: true,
    idempotent: true,
    inputSchema: idInputSchema,
    outputSchema: deleteOutputSchema,
    preview: (s, a) => ({ entityType: 'industry', before: s.industries.get(a.id), after: null }),
    execute: (s, a) => {
      s.industries.delete(a.id)
      return { deleted: true as const, id: a.id }
    },
  }),
  tool({
    name: 'reorder_industries',
    title: 'Reorder industries',
    description: 'Set the complete display order of industries.',
    readOnly: false,
    idempotent: true,
    inputSchema: orderInputSchema,
    outputSchema: itemsOutput(industrySchema),
    preview: (s, a) => ({
      entityType: 'industry_order',
      before: s.industries.list().map(({ id, updatedAt }) => ({ id, updatedAt })),
      after: a.order,
    }),
    execute: (s, a) => ({ items: s.industries.reorder(a.order) }),
  }),

  tool({
    name: 'search_companies',
    title: 'Search companies',
    description: 'Search companies by name, industry, or alias.',
    readOnly: true,
    inputSchema: keywordArgs,
    outputSchema: itemsOutput(companySchema),
    execute: (s, a) => ({ items: s.companies.search(a.keyword) }),
  }),
  tool({
    name: 'list_companies',
    title: 'List companies',
    description: 'List all companies.',
    readOnly: true,
    inputSchema: emptyInput,
    outputSchema: itemsOutput(companySchema),
    execute: (s) => ({ items: s.companies.list() }),
  }),
  tool({
    name: 'get_company',
    title: 'Get company',
    description: 'Get one company by ID.',
    readOnly: true,
    inputSchema: idInputSchema,
    outputSchema: itemOutput(companySchema),
    execute: (s, a) => ({ item: s.companies.get(a.id) }),
  }),
  tool({
    name: 'mark_company_read',
    title: 'Mark company read',
    description: 'Mark a company career site as read now.',
    readOnly: false,
    inputSchema: idInputSchema,
    outputSchema: itemOutput(companySchema),
    preview: (s, a) => {
      const before = s.companies.get(a.id)
      return { entityType: 'company', before, after: { ...before, lastReadAt: 'now' } }
    },
    execute: (s, a) => ({ item: s.companies.markRead(a.id) }),
  }),
  tool({
    name: 'create_company',
    title: 'Create company',
    description: 'Create a company with industries and aliases.',
    readOnly: false,
    inputSchema: createCompanyArgs,
    outputSchema: itemOutput(companySchema),
    preview: (_s, a) => ({ entityType: 'company', before: null, after: a.input }),
    execute: (s, a) => ({ item: s.companies.create(a.input) }),
  }),
  tool({
    name: 'update_company',
    title: 'Update company',
    description: 'Update a company, its industries, aliases, or favorite state.',
    readOnly: false,
    idempotent: true,
    inputSchema: updateCompanyArgs,
    outputSchema: itemOutput(companySchema),
    preview: (s, a) => {
      const before = s.companies.get(a.id)
      return { entityType: 'company', before, after: { ...before, ...a.input } }
    },
    execute: (s, a) => ({ item: s.companies.update(a.id, a.input) }),
  }),
  tool({
    name: 'delete_company',
    title: 'Delete company',
    description: 'Delete an unused custom company.',
    readOnly: false,
    destructive: true,
    idempotent: true,
    inputSchema: idInputSchema,
    outputSchema: deleteOutputSchema,
    preview: (s, a) => ({ entityType: 'company', before: s.companies.get(a.id), after: null }),
    execute: (s, a) => {
      s.companies.delete(a.id)
      return { deleted: true as const, id: a.id }
    },
  }),

  tool({
    name: 'list_resume_versions',
    title: 'List resume versions',
    description: 'List resume versions in display order.',
    readOnly: true,
    inputSchema: emptyInput,
    outputSchema: itemsOutput(resumeSchema),
    execute: (s) => ({ items: s.resumes.list() }),
  }),
  tool({
    name: 'get_resume_version',
    title: 'Get resume version',
    description: 'Get one resume version by ID.',
    readOnly: true,
    inputSchema: idInputSchema,
    outputSchema: itemOutput(resumeSchema),
    execute: (s, a) => ({ item: s.resumes.get(a.id) }),
  }),
  tool({
    name: 'import_resume_version',
    title: 'Import resume version',
    description: 'Import a local PDF, DOC, or DOCX resume file.',
    readOnly: false,
    inputSchema: importResumeArgs,
    outputSchema: itemOutput(resumeImportSchema),
    preview: (s, a) => {
      const source = s.resumes.inspectSource(a.sourcePath)
      return {
        entityType: 'resume_version',
        before: null,
        after: { ...source, name: a.name ?? source.name, note: a.note ?? null },
      }
    },
    execute: (s, a) => ({ item: s.resumes.importFromPath(a.sourcePath, a.name, a.note) }),
  }),
  tool({
    name: 'update_resume_version',
    title: 'Update resume version',
    description: 'Update resume version name or note.',
    readOnly: false,
    idempotent: true,
    inputSchema: updateResumeArgs,
    outputSchema: itemOutput(resumeSchema),
    preview: (s, a) => {
      const before = s.resumes.get(a.id)
      return { entityType: 'resume_version', before, after: { ...before, ...a.input } }
    },
    execute: (s, a) => ({ item: s.resumes.update(a.id, a.input) }),
  }),
  tool({
    name: 'reorder_resume_versions',
    title: 'Reorder resume versions',
    description: 'Set the complete display order of resume versions.',
    readOnly: false,
    idempotent: true,
    inputSchema: orderInputSchema,
    outputSchema: itemsOutput(resumeSchema),
    preview: (s, a) => ({
      entityType: 'resume_order',
      before: s.resumes.list().map(({ id, updatedAt }) => ({ id, updatedAt })),
      after: a.order,
    }),
    execute: (s, a) => ({ items: s.resumes.reorder(a.order) }),
  }),
  tool({
    name: 'delete_resume_version',
    title: 'Delete resume version',
    description: 'Delete an unused resume version and its managed file.',
    readOnly: false,
    destructive: true,
    idempotent: true,
    inputSchema: idInputSchema,
    outputSchema: deleteOutputSchema,
    preview: (s, a) => ({
      entityType: 'resume_version',
      before: s.resumes.get(a.id),
      after: null,
    }),
    execute: (s, a) => {
      s.resumes.delete(a.id)
      return { deleted: true as const, id: a.id }
    },
  }),

  tool({
    name: 'search_opportunities',
    title: 'Search opportunities',
    description: 'Search and filter job opportunities.',
    readOnly: true,
    inputSchema: opportunitySearchArgs,
    outputSchema: itemsOutput(opportunitySchema),
    execute: (s, a) => ({ items: s.opportunities.list(a.query) }),
  }),
  tool({
    name: 'get_opportunity',
    title: 'Get opportunity',
    description: 'Get one job opportunity by ID.',
    readOnly: true,
    inputSchema: idInputSchema,
    outputSchema: itemOutput(opportunitySchema),
    execute: (s, a) => ({ item: s.opportunities.get(a.id) }),
  }),
  tool({
    name: 'create_opportunity',
    title: 'Create opportunity',
    description: 'Create a job opportunity.',
    readOnly: false,
    inputSchema: createOpportunityArgs,
    outputSchema: itemOutput(opportunitySchema),
    preview: (_s, a) => ({ entityType: 'opportunity', before: null, after: a.input }),
    execute: (s, a) => ({ item: s.opportunities.create(a.input) }),
  }),
  tool({
    name: 'update_opportunity',
    title: 'Update opportunity',
    description: 'Update a job opportunity.',
    readOnly: false,
    idempotent: true,
    inputSchema: updateOpportunityArgs,
    outputSchema: itemOutput(opportunitySchema),
    preview: (s, a) => {
      const before = s.opportunities.get(a.id)
      return { entityType: 'opportunity', before, after: { ...before, ...a.input } }
    },
    execute: (s, a) => ({ item: s.opportunities.update(a.id, a.input) }),
  }),
  tool({
    name: 'delete_opportunity',
    title: 'Delete opportunity',
    description: 'Delete a job opportunity.',
    readOnly: false,
    destructive: true,
    idempotent: true,
    inputSchema: idInputSchema,
    outputSchema: deleteOutputSchema,
    preview: (s, a) => ({
      entityType: 'opportunity',
      before: s.opportunities.get(a.id),
      after: null,
    }),
    execute: (s, a) => {
      s.opportunities.delete(a.id)
      return { deleted: true as const, id: a.id }
    },
  }),
  tool({
    name: 'change_opportunity_status',
    title: 'Change opportunity status',
    description: 'Change the status of a job opportunity.',
    readOnly: false,
    idempotent: true,
    inputSchema: changeStatusArgs,
    outputSchema: itemOutput(opportunitySchema),
    preview: (s, a) => {
      const before = s.opportunities.get(a.id)
      const status = s.statuses.get(a.statusId)
      return {
        entityType: 'opportunity',
        before,
        after: { ...before, statusId: status.id, statusLabel: status.label },
      }
    },
    execute: (s, a) => ({ item: s.opportunities.changeStatus(a.id, a.statusId) }),
  }),

  tool({
    name: 'list_calendar_events',
    title: 'List calendar events',
    description: 'List calendar events overlapping a time range.',
    readOnly: true,
    inputSchema: calendarListArgs,
    outputSchema: itemsOutput(calendarEventSchema),
    execute: (s, a) => ({ items: s.calendar.list(a.range) }),
  }),
  tool({
    name: 'get_calendar_event',
    title: 'Get calendar event',
    description: 'Get one calendar event by ID.',
    readOnly: true,
    inputSchema: idInputSchema,
    outputSchema: itemOutput(calendarEventSchema),
    execute: (s, a) => ({ item: s.calendar.get(a.id) }),
  }),
  tool({
    name: 'create_calendar_event',
    title: 'Create calendar event',
    description: 'Create a calendar event.',
    readOnly: false,
    inputSchema: createCalendarArgs,
    outputSchema: itemOutput(calendarEventSchema),
    preview: (_s, a) => ({ entityType: 'calendar_event', before: null, after: a.input }),
    execute: (s, a) => ({ item: s.calendar.create(a.input) }),
  }),
  tool({
    name: 'update_calendar_event',
    title: 'Update calendar event',
    description: 'Update a calendar event.',
    readOnly: false,
    idempotent: true,
    inputSchema: updateCalendarArgs,
    outputSchema: itemOutput(calendarEventSchema),
    preview: (s, a) => {
      const before = s.calendar.get(a.id)
      return { entityType: 'calendar_event', before, after: { ...before, ...a.input } }
    },
    execute: (s, a) => ({ item: s.calendar.update(a.id, a.input) }),
  }),
  tool({
    name: 'delete_calendar_event',
    title: 'Delete calendar event',
    description: 'Delete a calendar event.',
    readOnly: false,
    destructive: true,
    idempotent: true,
    inputSchema: idInputSchema,
    outputSchema: deleteOutputSchema,
    preview: (s, a) => ({
      entityType: 'calendar_event',
      before: s.calendar.get(a.id),
      after: null,
    }),
    execute: (s, a) => {
      s.calendar.delete(a.id)
      return { deleted: true as const, id: a.id }
    },
  }),
  tool({
    name: 'complete_calendar_event',
    title: 'Complete calendar event',
    description: 'Set the completion state of a calendar event.',
    readOnly: false,
    idempotent: true,
    inputSchema: completeCalendarArgs,
    outputSchema: itemOutput(calendarEventSchema),
    preview: (s, a) => {
      const before = s.calendar.get(a.id)
      return {
        entityType: 'calendar_event',
        before,
        after: { ...before, isCompleted: a.completed },
      }
    },
    execute: (s, a) => ({ item: s.calendar.complete(a.id, a.completed) }),
  }),
]
