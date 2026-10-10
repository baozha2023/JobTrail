import { z } from 'zod'

// Public metadata only: website behavior lives in Main's platform adapters.
export const platformNames = {
  boss: 'BOSS 直聘',
  liepin: '猎聘',
  zhilian: '智联招聘',
  wuyou: '前程无忧',
  iguopin: '国聘',
  shixiseng: '实习僧',
} as const
export type JobPlatform = keyof typeof platformNames
export const platforms = Object.keys(platformNames) as [JobPlatform, ...JobPlatform[]]
export const platformSchema = z.enum(platforms)
export const searchQuerySchema = z
  .strictObject({
    keyword: z.string().trim().min(1).max(100),
    city: z
      .string()
      .trim()
      .max(50)
      .refine((v) => v !== '全国', 'Choose a city or leave it empty')
      .default(''),
    platforms: z
      .array(platformSchema)
      .min(1)
      .max(platforms.length)
      .refine((v) => new Set(v).size === v.length, 'Duplicate platform'),
    salaryMin: z.number().nonnegative().max(10000000).optional(),
    salaryMax: z.number().nonnegative().max(10000000).optional(),
  })
  .refine(
    (q) => q.salaryMin === undefined || q.salaryMax === undefined || q.salaryMin <= q.salaryMax,
    'Invalid salary range',
  )
export type JobQuery = z.infer<typeof searchQuerySchema>
export const missingReasons = [
  'login_required',
  'session_expired',
  'challenge',
  'not_provided',
  'parse_error',
  'detail_not_read',
] as const
export type MissingReason = (typeof missingReasons)[number]
export const jobFields = [
  'title',
  'company',
  'city',
  'salary',
  'experience',
  'education',
  'recruitment',
  'employment',
  'jd',
] as const
export type JobField = (typeof jobFields)[number]
export interface RawJob {
  platform: JobPlatform
  externalId?: string
  url: string
  title: string
  company: string
  city: string
  salary: string
  experience: string
  education: string
  recruitment: string
  employment: string
  jd: string
  detailRead: boolean
  missing?: Partial<Record<JobField, MissingReason>>
  provenance?: Partial<Record<JobField, 'response' | 'dom'>>
}
export interface JobObservation extends RawJob {
  salaryMin: number | null
  salaryMax: number | null
  detailReadAt: number | null
  missing: Partial<Record<JobField, MissingReason>>
  readAt: number
}
export interface DiscoveredJob extends JobObservation {
  id: string
  observationId: number
  removedFromCurrentSearch: boolean
  savedOpportunityId: number | null
  possibleDuplicate: boolean
}
export const sourceStates = [
  'queued',
  'running',
  'completed',
  'partial',
  'login_required',
  'session_expired',
  'challenge',
  'unsupported_city',
  'scope_unverified',
  'parse_error',
  'timeout',
  'network_error',
  'cancelled',
  'interrupted',
] as const
export type SourceState = (typeof sourceStates)[number]
export function needsHumanAction(state: SourceState): boolean {
  return state === 'login_required' || state === 'session_expired' || state === 'challenge'
}
export const salaryExclusionReasons = ['out_of_range', 'day', 'hour', 'foreign', 'unknown'] as const
export type SalaryExclusionReason = (typeof salaryExclusionReasons)[number]
export interface SourceProgress {
  platform: JobPlatform
  state: SourceState
  count: number
  batches: number
  sourcePage: number
  rawCount: number
  validCount: number
  duplicateCount: number
  rejectedCount: number
  salaryExcluded: Record<SalaryExclusionReason, number>
  cursor: string | null
  generation: number
  remote: { keyword: string; city: string; cityCode: string }
  message: string
  cachedAt: number | null
}
export interface SearchRun {
  id: string
  requestId: string
  query: JobQuery
  state: 'queued' | 'running' | 'completed' | 'partial' | 'cancelled' | 'interrupted'
  createdAt: number
  updatedAt: number
  sources: SourceProgress[]
}
export interface PlatformStatus {
  platform: JobPlatform
  state: 'unknown' | 'authenticated' | 'login_required' | 'session_expired' | 'challenge'
  checkedAt: number | null
  generation: number
  evidence: string
  capabilities: { cities: string[]; remoteFilters: string[]; qr: 'website' }
  limitations: string[]
}
export const startSearchSchema = z.strictObject({
  requestId: z.string().trim().min(1).max(120),
  query: searchQuerySchema,
})
export const jobDetailSchema = z
  .strictObject({
    jobId: z.string().min(1).max(100),
    runId: z.string().uuid().optional(),
    viewId: z.string().uuid().optional(),
    observationId: z.number().int().positive().optional(),
    mode: z.enum(['snapshot', 'ensure', 'refresh']).default('snapshot'),
  })
  .refine((v) => !v.viewId || !!v.runId, 'A view requires its search')
export type JobDetailInput = z.input<typeof jobDetailSchema>
export const jobListSchema = z
  .strictObject({
    runId: z.string().uuid(),
    viewId: z.string().uuid().optional(),
    page: z.number().int().min(1).default(1),
    pageSize: z.union([z.literal(10), z.literal(20), z.literal(50)]).default(20),
    sort: z.enum(['relevance', 'salary', 'discovered']).optional(),
  })
  .refine((q) => q.page === 1 || !!q.viewId, 'Subsequent pages require viewId')
export const saveJobSchema = z
  .strictObject({
    jobId: z.string().min(1).max(100),
    observationId: z.number().int().positive().optional(),
    companyId: z.number().int().positive().optional(),
    newCompanyName: z.string().trim().min(1).max(200).optional(),
    statusId: z.number().int().positive(),
    resumeVersionId: z.number().int().positive().nullable().optional(),
  })
  .refine(
    (v) => !!v.companyId !== !!v.newCompanyName,
    'Choose an existing company or confirm a new company',
  )
export interface JobPage {
  viewId: string
  items: DiscoveredJob[]
  total: number
  page: number
  pageSize: number
}
export interface BrowserRegion {
  x: number
  y: number
  width: number
  height: number
  visible: boolean
}
export const browserRegionSchema = z.strictObject({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().nonnegative(),
  height: z.number().finite().nonnegative(),
  visible: z.boolean(),
})
export interface BrowserLoadingState {
  requestId: string
  loading: boolean
}
export const browserActionSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('open'),
    jobId: z.string().min(1).max(100),
    requestId: z.string().uuid(),
  }),
  z.strictObject({ action: z.literal('clear'), platform: platformSchema }),
  z.strictObject({
    action: z.enum(['close', 'back', 'forward', 'reload', 'zoomIn', 'zoomOut', 'external']),
  }),
])
export const qrMethodSchema = z.enum(['website', 'app', 'wechat'])
export type QrLoginMethod = z.infer<typeof qrMethodSchema>
export const qrLoginSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('start'),
    platform: platformSchema,
    method: qrMethodSchema.optional(),
  }),
  z.strictObject({
    action: z.enum(['get', 'cancel']),
    platform: platformSchema,
    attemptId: z.string().uuid().optional(),
  }),
  z.strictObject({
    action: z.enum(['verify', 'retry']),
    platform: platformSchema,
    attemptId: z.string().uuid(),
  }),
])
export const MAX_OBSERVATION_BYTES = 128 * 1024
export const sourceVerificationSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('open'), runId: z.string().uuid(), platform: platformSchema }),
  z.strictObject({
    action: z.literal('recheck'),
    runId: z.string().uuid(),
    platform: platformSchema,
    attemptId: z.string().uuid(),
  }),
  z.strictObject({ action: z.enum(['get', 'close']) }),
])
export interface SourceVerificationState {
  runId: string
  platform: JobPlatform
  phase: 'open' | 'checking' | 'resuming'
}
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const observationSchema = z
  .strictObject({
    externalId: z.string().optional(),
    provenance: z.partialRecord(z.enum(jobFields), z.enum(['dom', 'response'])).optional(),
    salaryMin: z.number().nonnegative().nullable(),
    salaryMax: z.number().nonnegative().nullable(),
    platform: platformSchema,
    url: z.string(),
    title: z.string(),
    company: z.string(),
    city: z.string(),
    salary: z.string(),
    experience: z.string(),
    education: z.string(),
    recruitment: z.string(),
    employment: z.string(),
    jd: z.string(),
    detailRead: z.boolean(),
    readAt: timestamp,
    detailReadAt: timestamp.nullable(),
    missing: z.partialRecord(z.enum(jobFields), z.enum(missingReasons)),
  })
  .refine(
    (v) => v.salaryMax === null || (v.salaryMin !== null && v.salaryMax >= v.salaryMin),
    'Invalid salary bounds',
  )
  .refine(
    (v) =>
      v.detailRead === (v.detailReadAt !== null) &&
      (v.detailReadAt === null || v.detailReadAt <= v.readAt),
    'Invalid detail timestamp',
  )
export const discoveryJobOutputSchema = observationSchema.safeExtend({
  id: z.string().min(1),
  observationId: z.number().int().positive(),
  removedFromCurrentSearch: z.boolean(),
  savedOpportunityId: z.number().int().positive().nullable(),
  possibleDuplicate: z.boolean(),
})
export const sourceProgressSchema = z.strictObject({
  platform: platformSchema,
  state: z.enum(sourceStates),
  count,
  batches: count,
  sourcePage: count,
  rawCount: count,
  validCount: count,
  duplicateCount: count,
  rejectedCount: count,
  salaryExcluded: z.strictObject({
    out_of_range: count,
    day: count,
    hour: count,
    foreign: count,
    unknown: count,
  }),
  cursor: z.string().nullable(),
  generation: count,
  remote: z.strictObject({ keyword: z.string(), city: z.string(), cityCode: z.string() }),
  message: z.string(),
  cachedAt: timestamp.nullable(),
})
export const discoveryRunOutputSchema = z.strictObject({
  id: z.string(),
  requestId: z.string(),
  query: searchQuerySchema,
  state: z.enum(['queued', 'running', 'completed', 'partial', 'cancelled', 'interrupted']),
  createdAt: z.number(),
  updatedAt: z.number(),
  sources: z.array(sourceProgressSchema),
})
export const discoveryStatusOutputSchema = z.strictObject({
  platform: platformSchema,
  state: z.enum(['unknown', 'authenticated', 'login_required', 'session_expired', 'challenge']),
  checkedAt: timestamp.nullable(),
  generation: count,
  evidence: z.string(),
  capabilities: z.strictObject({
    cities: z.array(z.string()),
    remoteFilters: z.array(z.string()),
    qr: z.literal('website'),
  }),
  limitations: z.array(z.string()),
})
export interface QrVerificationState {
  available: boolean
  window: 'closed' | 'loading' | 'ready' | 'error'
  error: 'unavailable' | 'network' | 'blocked' | 'blank' | 'timeout' | 'site_error' | null
}
export type QrScanHint = Record<'zh-CN' | 'en-US', string>
export interface QrLoginState {
  method: QrLoginMethod
  methods: { id: QrLoginMethod; label: QrScanHint }[]
  scanHint: QrScanHint
  platform: JobPlatform
  attemptId: string
  state:
    | 'loading'
    | 'waiting'
    | 'scanned'
    | 'authenticated'
    | 'expired'
    | 'cancelled'
    | 'challenge'
    | 'error'
  image: string | null
  expiresAt: number
  reason: 'network' | 'protocol' | 'verification' | null
  verification: QrVerificationState
}
export interface DiscoveryApi {
  verification(
    input: z.input<typeof sourceVerificationSchema>,
  ): Promise<SourceVerificationState | null>
  qrLogin(input: z.input<typeof qrLoginSchema>): Promise<QrLoginState | null>
  status(check?: boolean): Promise<PlatformStatus[]>
  start(input: z.input<typeof startSearchSchema>): Promise<SearchRun>
  run(id: string): Promise<SearchRun>
  list(input: z.input<typeof jobListSchema>): Promise<JobPage>
  continue(id: string): Promise<SearchRun>
  cancel(id: string): Promise<SearchRun>
  detail(input: JobDetailInput): Promise<DiscoveredJob>
  history(page: number): Promise<{ items: SearchRun[]; total: number }>
  removeHistory(ids: string[]): Promise<void>
  save(
    input: z.input<typeof saveJobSchema>,
  ): Promise<{ opportunityId: number; alreadySaved: boolean }>
  browser(input: z.input<typeof browserActionSchema>): Promise<void>
  region(input: BrowserRegion): Promise<void>
}
