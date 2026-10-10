import type { ExamPaper } from '../shared/exams'
import {
  createExamSchema,
  appendExamSchema,
  examIdentitySchema,
  examQuestionSchema,
  updateExamSchema,
} from '../shared/exams'
import { z } from 'zod'
import {
  startSearchSchema,
  jobListSchema,
  jobDetailSchema,
  saveJobSchema,
  discoveryJobOutputSchema,
  discoveryRunOutputSchema,
  discoveryStatusOutputSchema,
} from '../shared/job-discovery'
import { companyLocationsInputSchema } from '../shared/company-locations'
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
  pageInputSchema,
  pageOutput,
  pageSchema,
  pageSizeSchema,
  positiveIdSchema,
  readWebPageInputSchema,
  readWebPageOutputSchema,
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
  openWorld: boolean
  confirmation?: 'never'
  readOnlyHint?: boolean
  inputSchema: z.ZodType
  outputSchema: z.ZodType
}

export type McpReadToolDescriptor = McpToolDescriptorBase & {
  readOnly: true
  preview?: never
  execute: (
    services: Services,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>
}

export type McpWriteToolDescriptor = McpToolDescriptorBase & {
  readOnly: false
  preview: (services: Services, args: Record<string, unknown>) => McpMutationPreview
  execute: (services: Services, args: Record<string, unknown>) => Record<string, unknown>
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
  openWorld?: boolean
  confirmation?: 'never'
  readOnlyHint?: boolean
  inputSchema: I
  outputSchema: O
} & (
  | {
      readOnly: true
      preview?: never
      execute: (
        services: Services,
        args: z.output<I>,
        signal: AbortSignal,
      ) => z.input<O> | Promise<z.input<O>>
    }
  | {
      readOnly: false
      preview: (services: Services, args: z.output<I>) => McpMutationPreview
      execute: (services: Services, args: z.output<I>) => z.input<O>
    }
)

function tool<I extends z.ZodType, O extends z.ZodType>(
  definition: McpToolDefinition<I, O>,
): McpToolDescriptor {
  return {
    ...definition,
    destructive: definition.destructive ?? false,
    idempotent: definition.idempotent ?? false,
    openWorld: definition.openWorld ?? false,
  } as unknown as McpToolDescriptor
}

function examSummary(paper: ExamPaper) {
  return {
    id: paper.id,
    conversationId: paper.conversationId,
    title: paper.title,
    topic: paper.topic,
    difficulty: paper.difficulty,
    counts: paper.counts,
    status: paper.status,
    questionCount: paper.questions.length,
  }
}
const examSummarySchema = createExamSchema
  .pick({ conversationId: true, title: true, topic: true, difficulty: true, counts: true })
  .extend({
    id: z.string().uuid(),
    status: z.enum(['generating', 'completed', 'interrupted']),
    questionCount: z.number().int().min(0).max(300),
  })
const examReadSchema = examSummarySchema.omit({ questionCount: true }).extend({
  taskId: createExamSchema.shape.taskId,
  resetVersion: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  questions: z
    .array(
      z.strictObject({
        id: z.string().uuid(),
        position: z.number().int().min(1).max(300),
        content: examQuestionSchema,
      }),
    )
    .max(300),
})
const examSummaryOutput = z.strictObject({ paper: examSummarySchema })
const emptyInput = z.strictObject({})
const createStatusArgs = z.strictObject({ input: createStatusInputSchema })
const updateStatusArgs = z.strictObject({ id: positiveIdSchema, input: updateStatusInputSchema })
const createIndustryArgs = z.strictObject({ input: createIndustryInputSchema })
const updateIndustryArgs = z.strictObject({
  id: positiveIdSchema,
  input: updateIndustryInputSchema,
})
const companySearchArgs = z.strictObject({
  locations: companyLocationsInputSchema.optional(),
  keyword: z.string().optional(),
  industryId: positiveIdSchema.nullable().optional(),
  page: pageSchema,
  pageSize: pageSizeSchema,
})
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

export const MCP_TOOLS: readonly McpToolDescriptor[] = [
  tool({
    name: 'get_job_platform_status',
    title: '招聘平台状态',
    description:
      '读取六个平台的会话、能力及字段限制。check=true 时检查桌面 Chromium 会话；登录和网站验证必须由用户在岗位发现的账号管理中完成。',
    readOnly: true,
    readOnlyHint: false,
    openWorld: true,
    inputSchema: z.strictObject({ check: z.boolean().default(false) }),
    outputSchema: z.strictObject({ items: z.array(discoveryStatusOutputSchema) }),
    execute: async (s, a) => ({ items: await s.discovery.status(a.check) }),
  }),
  tool({
    name: 'start_job_search',
    title: '开始岗位搜索',
    description:
      '通过指定平台的官方主搜索框和地点控件搜索；city 可省略或为空，此时沿用网站默认地点并返回实际条件。非空城市必须被全部所选平台支持，否则拒绝创建任务；各平台能力中的 cities 是其独立完整城市列表，按统一名称的字符串交集选择。不按岗位文字再次筛选关键词。网站专用搜索、广告及地点规则由对应平台适配器处理，不增加全平台统一城市过滤；不选城市则不做城市过滤。单条解析失败静默跳过并记录日志，不影响其他岗位。返回 runId 后用 get_job_search 查询；requestId 用于幂等重试。每轮最多 90 秒、每平台 3 批，200 条按整批边界停止。部分来源失败不代表全网无结果。薪资条件单位为人民币元/月，在入库前按区间相交判断；年薪除以12，日薪、时薪、外币和无法比较的薪资不入库。不填薪资则不做薪资过滤。',
    readOnly: true,
    readOnlyHint: false,
    openWorld: true,
    inputSchema: startSearchSchema,
    outputSchema: z.strictObject({ item: discoveryRunOutputSchema }),
    execute: async (s, a) => ({ item: await s.discovery.start(a) }),
  }),
  tool({
    name: 'get_job_search',
    title: '查询搜索进度',
    description:
      '读取任务及各来源覆盖、阻断和恢复提示。login_required/session_expired 需用户登录；challenge 需用户验证；scope_unverified 不应解释为零结果。',
    readOnly: true,
    inputSchema: z.strictObject({ runId: z.string().uuid() }),
    outputSchema: z.strictObject({ item: discoveryRunOutputSchema }),
    execute: async (s, a) => ({ item: await s.discovery.run(a.runId) }),
  }),
  tool({
    name: 'list_discovered_jobs',
    title: '分页读取发现岗位',
    description:
      '从本地稳定分页读取结果，不触发网站翻页。首屏不传 viewId 创建视图；后续分页必须传返回的 viewId，新岗位仅追加末尾。重新排列时不传 viewId 并回到第一页。展示分页不再执行任何业务筛选。',
    readOnly: true,
    inputSchema: jobListSchema,
    outputSchema: z.strictObject({
      viewId: z.string().uuid(),
      items: z.array(discoveryJobOutputSchema),
      total: z.number(),
      page: z.number(),
      pageSize: z.number(),
    }),
    execute: async (s, a) => ({ ...(await s.discovery.list(a)) }),
  }),
  tool({
    name: 'continue_job_search',
    title: '继续岗位搜索',
    description:
      '为指定任务启动下一预算轮，保留条件和已存结果。登录后可使用；失效游标会重新获取并标注。',
    readOnly: true,
    readOnlyHint: false,
    openWorld: true,
    inputSchema: z.strictObject({ runId: z.string().uuid() }),
    outputSchema: z.strictObject({ item: discoveryRunOutputSchema }),
    execute: async (s, a) => ({ item: await s.discovery.continue(a.runId) }),
  }),
  tool({
    name: 'cancel_job_search',
    title: '取消岗位搜索',
    description: '只取消指定任务并保留已保存结果，不影响其他任务。',
    readOnly: true,
    readOnlyHint: false,
    inputSchema: z.strictObject({ runId: z.string().uuid() }),
    outputSchema: z.strictObject({ item: discoveryRunOutputSchema }),
    execute: async (s, a) => ({ item: await s.discovery.cancel(a.runId) }),
  }),
  tool({
    name: 'get_discovered_job',
    title: '读取发现岗位详情',
    description:
      'mode=snapshot（默认）读取指定 viewId/observationId 或当前搜索观察；mode=ensure 按需补全，复用最新完整详情的30分钟缓存；mode=refresh 强制重新读取网站。补全不改变固定视图顺序与观察，不符合原薪资条件时移除当前结果并返回 removedFromCurrentSearch。确认下架后删除发现岗位及所有结果、视图和观察，保留已有求职记录，返回 DISCOVERY_JOB_OFFLINE。',
    readOnly: true,
    readOnlyHint: false,
    openWorld: true,
    inputSchema: jobDetailSchema,
    outputSchema: z.strictObject({ item: discoveryJobOutputSchema }),
    execute: async (s, a) => ({ item: await s.discovery.detail(a) }),
  }),
  tool({
    name: 'list_job_search_history',
    title: '岗位搜索历史',
    description: '分页读取本地搜索历史（每页 20），无需桌面浏览器运行。',
    readOnly: true,
    inputSchema: z.strictObject({ page: z.number().int().positive().default(1) }),
    outputSchema: z.strictObject({ items: z.array(discoveryRunOutputSchema), total: z.number() }),
    execute: async (s, a) => ({ ...(await s.discovery.history(a.page)) }),
  }),
  tool({
    name: 'save_discovered_job',
    title: '加入求职记录',
    description:
      '确认公司后保存发现岗位为求职记录；指定已有 companyId 或明确 newCompanyName（两者择一），并指定现有 statusId，可选 resumeVersionId。公司创建、记录和来源关联同事务；重复保存返回既有记录，不覆盖用户编辑。遵守 MCP 写入确认。',
    readOnly: false,
    idempotent: true,
    inputSchema: saveJobSchema,
    outputSchema: z.strictObject({ opportunityId: z.number(), alreadySaved: z.boolean() }),
    preview: (s, a) => ({
      ...s.discovery.savePreview(a),
      after: {
        ...a,
        status: s.statuses.get(a.statusId),
        resume: a.resumeVersionId ? s.resumes.get(a.resumeVersionId) : null,
      },
    }),
    execute: (s, a) => s.discovery.saveSync(a),
  }),
  tool({
    name: 'create_exam_paper',
    title: '创建练习卷',
    description:
      '创建笔试练习卷。内置智能体自动提供 conversationId、taskId、requestId；外部调用须提供这些标识。',
    readOnly: false,
    confirmation: 'never',
    idempotent: true,
    inputSchema: createExamSchema,
    outputSchema: examSummaryOutput,
    preview: (_s, args) => ({ entityType: 'exam', before: null, after: args }),
    execute: (s, args) => ({ paper: examSummary(s.exams.create(args)) }),
  }),
  tool({
    name: 'update_exam_paper',
    title: '修改练习卷设置',
    description:
      '修改所属聊天试卷的 topic、difficulty 或 counts，至少提供一项；counts 必须提供三种题型的完整目标数量，且不得少于对应已生成题数。保留已有题目、作答和评分；增加题量后可在原卷继续追加题目。内置智能体自动提供 conversationId。',
    readOnly: false,
    confirmation: 'never',
    idempotent: true,
    inputSchema: updateExamSchema,
    outputSchema: examSummaryOutput,
    preview: (s, args) => ({
      entityType: 'exam',
      before: examSummary(
        s.exams.get({ conversationId: args.conversationId, paperId: args.paperId }),
      ),
      after: args,
    }),
    execute: (s, args) => ({ paper: examSummary(s.exams.update(args)) }),
  }),
  tool({
    name: 'append_exam_question',
    title: '追加练习题',
    description:
      '每完成一道完整题目立即保存到试卷，禁止等待整卷生成后批量保存。requestId 用于幂等重试。',
    readOnly: false,
    confirmation: 'never',
    idempotent: true,
    inputSchema: appendExamSchema,
    outputSchema: examSummaryOutput,
    preview: (_s, args) => ({ entityType: 'exam', before: null, after: args }),
    execute: (s, args) => ({ paper: examSummary(s.exams.append(args)) }),
  }),
  tool({
    name: 'get_exam_paper',
    title: '读取练习卷',
    description: '读取所属聊天的试卷及已生成题目，继续出题前核对已有内容。',
    readOnly: true,
    idempotent: true,
    inputSchema: examIdentitySchema,
    outputSchema: z.strictObject({ paper: examReadSchema }),
    execute: (s, args) => {
      const paper = s.exams.get(args)
      return {
        paper: {
          ...paper,
          questions: paper.questions.map(({ answer: _answer, ...q }) => q),
        },
      }
    },
  }),
  tool({
    name: 'complete_exam_paper',
    title: '完成练习卷',
    description: '全部题型达到约定数量后完成出卷。',
    readOnly: false,
    confirmation: 'never',
    idempotent: true,
    inputSchema: examIdentitySchema,
    outputSchema: examSummaryOutput,
    preview: (_s, args) => ({ entityType: 'exam', before: null, after: args }),
    execute: (s, args) => ({ paper: examSummary(s.exams.complete(args)) }),
  }),

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
    description:
      'List the two-level industry tree in display order. parentId is null for groups; only second-level industries can be assigned to companies or referenced in chat.',
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
    description:
      'Create a custom second-level industry under an existing first-level group using parentId.',
    readOnly: false,
    inputSchema: createIndustryArgs,
    outputSchema: itemOutput(industrySchema),
    preview: (s, a) => ({
      entityType: 'industry',
      before: null,
      after: { ...a.input, parentName: s.industries.get(a.input.parentId).name },
    }),
    execute: (s, a) => ({ item: s.industries.create(a.input) }),
  }),
  tool({
    name: 'update_industry',
    title: 'Update industry',
    description:
      'Rename a custom second-level industry or move it to another first-level group using parentId. Built-in industries are editable only in development.',
    readOnly: false,
    idempotent: true,
    inputSchema: updateIndustryArgs,
    outputSchema: itemOutput(industrySchema),
    preview: (s, a) => {
      const before = s.industries.get(a.id)
      const parentId = a.input.parentId ?? before.parentId
      return {
        entityType: 'industry',
        before: {
          ...before,
          parentName: before.parentId === null ? null : s.industries.get(before.parentId).name,
        },
        after: {
          ...before,
          ...a.input,
          parentName: parentId === null ? null : s.industries.get(parentId).name,
        },
      }
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
    description:
      'Set the complete sibling order under parentId; use null for first-level sections.',
    readOnly: false,
    idempotent: true,
    inputSchema: z.strictObject({
      parentId: positiveIdSchema.nullable(),
      order: z.array(positiveIdSchema),
    }),
    outputSchema: itemsOutput(industrySchema),
    preview: (s, a) => ({
      entityType: 'industry_order',
      before: s.industries
        .list()
        .filter((item) => item.parentId === a.parentId)
        .map(({ id, updatedAt }) => ({ id, updatedAt })),
      after: a,
    }),
    execute: (s, a) => ({ items: s.industries.reorder(a) }),
  }),

  tool({
    name: 'search_companies',
    title: 'Search companies',
    description:
      'Search companies by name or alias, industry, and exact office location labels. Multiple locations match any selected label; combine with other filters using AND.',
    readOnly: true,
    inputSchema: companySearchArgs,
    outputSchema: pageOutput(companySchema),
    execute: (s, a) => s.companies.search(a),
  }),
  tool({
    name: 'list_companies',
    title: 'List companies',
    description: 'List companies one page at a time.',
    readOnly: true,
    inputSchema: pageInputSchema,
    outputSchema: pageOutput(companySchema),
    execute: (s, a) => s.companies.search(a),
  }),
  tool({
    name: 'get_company',
    title: 'Get company',
    description: 'Get one locally stored JobTrail company record by ID.',
    readOnly: true,
    inputSchema: idInputSchema,
    outputSchema: itemOutput(companySchema),
    execute: (s, a) => ({ item: s.companies.get(a.id) }),
  }),
  tool({
    name: 'read_web_page',
    title: 'Read public web page',
    description:
      'Read any public HTML page. Set scroll: true for infinite-scroll content; omit cursor or pass 0 to start, then pass each nextCursor back with the same URL, render mode and scroll value until null. One opaque cursor continues long text and links before loading the next scroll batch. Each response contains up to 20,000 UTF-16 text units and 50 links, independent of the number of page items. The browser may execute bounded same-origin JSON POST requests to allowlisted query endpoints; their server-side effects cannot be proven absent. It does not click buttons or submit forms. Check incompleteReason and warnings before claiming all content was read.',
    readOnly: true,
    readOnlyHint: false,
    openWorld: true,
    inputSchema: readWebPageInputSchema,
    outputSchema: readWebPageOutputSchema,
    execute: (s, a, signal) => s.web.read(a, signal),
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
    description: 'Create a company with industries, aliases, and office location labels.',
    readOnly: false,
    inputSchema: createCompanyArgs,
    outputSchema: itemOutput(companySchema),
    preview: (_s, a) => ({ entityType: 'company', before: null, after: a.input }),
    execute: (s, a) => ({ item: s.companies.create(a.input) }),
  }),
  tool({
    name: 'update_company',
    title: 'Update company',
    description:
      'Update a company, its industries, aliases, office locations, or favorite state. Omit locations to preserve them; an empty array clears them.',
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
    outputSchema: pageOutput(opportunitySchema),
    execute: (s, a) => s.opportunities.search(a.query),
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
]
