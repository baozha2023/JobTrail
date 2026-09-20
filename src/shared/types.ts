export type ThemeMode = 'light' | 'dark' | 'system'
export type StatusFlowTheme = 'violet' | 'ocean' | 'gold'
export type Locale = 'zh-CN' | 'en-US'
export type CloseBehavior = 'tray' | 'quit'
export type AppErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'BUILTIN_DATA'
  | 'STATUS_IN_USE'
  | 'LAST_STATUS'
  | 'RESUME_IN_USE'
  | 'COMPANY_IN_USE'
  | 'INDUSTRY_IN_USE'
  | 'FILE_IMPORT_FAILED'
  | 'FILE_OPEN_FAILED'
  | 'DATABASE_ERROR'
  | 'CATALOG_DOWNLOAD_FAILED'
  | 'CATALOG_ASSET_MISSING'
  | 'CATALOG_TOO_LARGE'
  | 'CATALOG_HASH_MISMATCH'
  | 'CATALOG_INVALID'
  | 'CATALOG_VERSION_ROLLBACK'
  | 'CATALOG_APP_UPDATE_REQUIRED'
  | 'CATALOG_CONFLICT'
  | 'CATALOG_UPDATE_IN_PROGRESS'
  | 'INTERNAL_ERROR'

export type McpErrorCode =
  | AppErrorCode
  | 'MCP_DISABLED'
  | 'CONFIRMATION_REQUIRED'
  | 'CONFIRMATION_UNSUPPORTED'

export interface McpConnectionInfo {
  command: string
  args: string[]
  env?: Record<string, string>
}

export type CompanyCatalogPhase = 'metadata' | 'download' | 'validation' | 'sync' | 'finalizing'

export interface CompanyCatalogProgress {
  phase: CompanyCatalogPhase
  progress: number
}

export interface CompanyCatalogStatus {
  formatVersion: number
  catalogVersion: number
  appliedAt: number
}

export interface CompanyCatalogUpdateResult {
  status: 'up-to-date' | 'updated'
  previousVersion: number
  currentVersion: number
  added: number
  updated: number
  adopted: number
  unchanged: number
}

export interface VelopackConfig {
  [key: string]: unknown
}

export interface AppConfig {
  configVersion: number
  themeMode: ThemeMode
  statusFlowTheme: StatusFlowTheme
  locale: Locale
  closeBehavior: CloseBehavior
  launchAtStartup: boolean
  companyReadValidityMonths: number
  velopack: VelopackConfig
  mcp: {
    enabled: boolean
    requireWriteConfirmation: boolean
  }
  ai: {
    baseUrl: string
    modelId: string
    apiKey: string
    multimodal: boolean
    contextWindowK: number
    compactThresholdPercent: number
  }
  [key: string]: unknown
}

export interface AgentConversation {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

export interface AgentAttachment {
  id: string
  conversationId: string
  name: string
  mimeType: string
  sizeBytes: number
}

export type AgentReference =
  | { kind: 'resume'; id: number; name: string }
  | { kind: 'opportunity'; id: number; name: string }
  | { kind: 'company'; id: number; name: string }
  | { kind: 'industry'; id: number; name: string }
  | { kind: 'skill'; name: 'resume-match' }
  | { kind: 'command'; name: 'compact' }

export type AgentDraftPart = { kind: 'text'; text: string } | AgentReference

export type AgentMessage =
  | { id: string; role: 'user'; parts: AgentDraftPart[]; attachments: AgentAttachment[] }
  | {
      id: string
      role: 'assistant'
      text: string
      incomplete?: boolean
      attachments: AgentAttachment[]
    }
  | {
      id: string
      role: 'tool'
      toolCallId: string
      name: string
      args: string
      result: string | null
      status: 'running' | 'waiting' | 'completed' | 'error'
      attachments: []
    }
  | {
      id: string
      role: 'compact'
      beforeTokens: number
      afterTokens: number
      status: 'completed' | 'skipped'
      attachments: []
    }

export interface AgentUsage {
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  contextTokens: number | null
  contextEstimated: boolean
  contextWindowTokens: number
}

export interface AgentHistory {
  messages: AgentMessage[]
  pending: AgentPending | null
  usage: AgentUsage
  running: boolean
}

export interface AgentQuestion {
  question: string
  options?: { label: string; description: string; recommended?: boolean }[]
}

export type AgentPending =
  | { kind: 'question'; questions: AgentQuestion[] }
  | { kind: 'confirmation'; message: string; fingerprint: string }

export interface AgentEvent {
  conversationId: string
  kind:
    | 'title'
    | 'token'
    | 'tool-start'
    | 'tool-end'
    | 'done'
    | 'error'
    | 'pending'
    | 'usage'
    | 'compact'
  text?: string
  toolCallId?: string
  toolName?: string
  toolArgs?: string
  toolResult?: string
  toolStatus?: 'completed' | 'error'
  pending?: AgentPending
  usage?: AgentUsage
  compact?: Extract<AgentMessage, { role: 'compact' }>
}

export interface Status {
  id: number
  label: string
  sortOrder: number
  isBuiltin: boolean
  createdAt: number
  updatedAt: number
}

export interface Company {
  id: number
  name: string
  industryIds: number[]
  industryName: string | null
  careerUrl: string | null
  lastReadAt: number | null
  aliases: string[]
  isBuiltin: boolean
  isFavorite: boolean
  createdAt: number
  updatedAt: number
}

export interface Industry {
  id: number
  name: string
  sortOrder: number
  isBuiltin: boolean
  createdAt: number
  updatedAt: number
}

export interface ResumeVersion {
  id: number
  name: string
  relativePath: string
  sizeBytes: number | null
  sha256: string | null
  note: string | null
  sortOrder: number
  createdAt: number
  updatedAt: number
}

export interface Opportunity {
  id: number
  companyId: number
  companyName: string
  title: string
  department: string | null
  location: string | null
  source: string | null
  jobUrl: string | null
  description: string | null
  statusId: number
  statusLabel: string
  resumeVersionId: number | null
  resumeVersionName: string | null
  discoveredAt: number | null
  appliedAt: number | null
  deadlineAt: number | null
  notes: string | null
  createdAt: number
  updatedAt: number
}

export type OpportunityStatusEventKind = 'created' | 'changed'

export interface OpportunityStatusEvent {
  id: number
  opportunityId: number
  statusId: number
  statusLabel: string
  occurredAt: number
  kind: OpportunityStatusEventKind
}

export interface OpportunityStatusFlow {
  opportunity: Opportunity
  events: OpportunityStatusEvent[]
}

export interface CalendarEvent {
  id: number
  opportunityId: number | null
  opportunityTitle: string | null
  opportunityJobUrl: string | null
  companyName: string | null
  title: string
  eventType: string
  startAt: number
  endAt: number
  isAllDay: boolean
  timezone: string
  location: string | null
  description: string | null
  reminderMinutes: number | null
  /** Read-only state derived from endAt and the current time. */
  isCompleted: boolean
  createdAt: number
  updatedAt: number
}

export interface CalendarReminderNotification {
  eventId: number
  startAt: number
}

export interface CreateCompanyInput {
  name: string
  industryIds?: number[]
  careerUrl?: string | null
  aliases?: string[]
}

export type UpdateCompanyInput = Partial<CreateCompanyInput> & {
  isFavorite?: boolean
}

export interface CreateIndustryInput {
  name: string
}

export type UpdateIndustryInput = Partial<CreateIndustryInput>

export interface CreateStatusInput {
  label: string
}

export type UpdateStatusInput = Partial<CreateStatusInput>

export interface UpdateResumeVersionInput {
  name?: string
  note?: string | null
}

export interface CreateOpportunityInput {
  companyId: number
  title: string
  department?: string | null
  location?: string | null
  source?: string | null
  jobUrl?: string | null
  description?: string | null
  statusId: number
  resumeVersionId?: number | null
  discoveredAt?: number | null
  appliedAt?: number | null
  deadlineAt?: number | null
  notes?: string | null
}

export type UpdateOpportunityInput = Partial<CreateOpportunityInput>

export interface OpportunityQuery {
  search?: string
  statusId?: number | null
  companyId?: number | null
}

export interface CreateCalendarEventInput {
  opportunityId?: number | null
  title: string
  eventType: string
  startAt: number
  endAt: number
  isAllDay?: boolean
  timezone?: string
  location?: string | null
  description?: string | null
  reminderMinutes?: number | null
}

export type UpdateCalendarEventInput = Partial<CreateCalendarEventInput>

export interface CalendarRange {
  startAt: number
  endAt: number
}

export interface ResumeImportResult extends ResumeVersion {
  originalExtension: string
}

export interface AppErrorShape {
  code: AppErrorCode
  message: string
  details?: Record<string, unknown>
}

export interface ZhijiApi {
  agent: {
    list(): Promise<AgentConversation[]>
    create(): Promise<AgentConversation>
    history(id: string): Promise<AgentHistory>
    rename(id: string, title: string): Promise<AgentConversation>
    delete(id: string): Promise<void>
    upload(id: string): Promise<AgentAttachment | null>
    uploadBytes(
      id: string,
      name: string,
      mimeType: string,
      bytes: Uint8Array,
    ): Promise<AgentAttachment>
    preview(id: string, attachmentId: string): Promise<string | null>
    removeUpload(id: string, attachmentId: string): Promise<void>
    send(id: string, parts: AgentDraftPart[], attachmentIds: string[]): Promise<void>
    compact(id: string): Promise<void>
    resume(id: string, answer: string[] | boolean): Promise<void>
    cancel(id: string): Promise<void>
    saveSettings(ai: AppConfig['ai']): Promise<AppConfig>
    onEvent(listener: (event: AgentEvent) => void): () => void
  }
  data: {
    onExternalChange(listener: () => void): () => void
  }
  config: {
    get(): Promise<AppConfig>
    update(input: Partial<AppConfig>): Promise<AppConfig>
  }
  mcp: {
    getConnectionInfo(): Promise<McpConnectionInfo>
  }
  statuses: {
    list(): Promise<Status[]>
    get(id: number): Promise<Status>
    create(input: CreateStatusInput): Promise<Status>
    update(id: number, input: UpdateStatusInput): Promise<Status>
    delete(id: number): Promise<void>
    reorder(order: number[]): Promise<Status[]>
  }
  industries: {
    list(): Promise<Industry[]>
    get(id: number): Promise<Industry>
    create(input: CreateIndustryInput): Promise<Industry>
    update(id: number, input: UpdateIndustryInput): Promise<Industry>
    delete(id: number): Promise<void>
    reorder(order: number[]): Promise<Industry[]>
  }
  companies: {
    search(keyword: string): Promise<Company[]>
    list(): Promise<Company[]>
    get(id: number): Promise<Company>
    markRead(id: number): Promise<Company>
    create(input: CreateCompanyInput): Promise<Company>
    update(id: number, input: UpdateCompanyInput): Promise<Company>
    delete(id: number): Promise<void>
  }
  companyCatalog: {
    getStatus(): Promise<CompanyCatalogStatus>
    update(): Promise<CompanyCatalogUpdateResult>
    onProgress(listener: (progress: CompanyCatalogProgress) => void): () => void
  }
  resumes: {
    list(): Promise<ResumeVersion[]>
    get(id: number): Promise<ResumeVersion>
    import(): Promise<ResumeImportResult | null>
    open(id: number): Promise<void>
    update(id: number, input: UpdateResumeVersionInput): Promise<ResumeVersion>
    reorder(order: number[]): Promise<ResumeVersion[]>
    delete(id: number): Promise<void>
  }
  opportunities: {
    list(query: OpportunityQuery): Promise<Opportunity[]>
    get(id: number): Promise<Opportunity>
    statusFlow(id: number): Promise<OpportunityStatusFlow>
    create(input: CreateOpportunityInput): Promise<Opportunity>
    update(id: number, input: UpdateOpportunityInput): Promise<Opportunity>
    delete(id: number): Promise<void>
    changeStatus(id: number, statusId: number): Promise<Opportunity>
  }
  calendar: {
    list(range: CalendarRange): Promise<CalendarEvent[]>
    get(id: number): Promise<CalendarEvent>
    create(input: CreateCalendarEventInput): Promise<CalendarEvent>
    update(id: number, input: UpdateCalendarEventInput): Promise<CalendarEvent>
    delete(id: number): Promise<void>
    onReminderClick(listener: (notification: CalendarReminderNotification) => void): () => void
  }
  system: {
    openExternal(url: string): Promise<void>
    isDevelopment(): Promise<boolean>
  }
}

export interface VelopackApi {
  getVersion(): Promise<string>
  rendererHealthy(): Promise<boolean>
  checkForUpdates(): Promise<import('velopack').UpdateInfo | null>
  downloadUpdates(): Promise<boolean>
  applyUpdates(): Promise<boolean>
  uninstall(): Promise<'started' | 'development' | 'unavailable'>
}

export interface WindowControlsApi {
  minimize(): Promise<void>
  toggleMaximize(): Promise<boolean>
  close(): Promise<void>
}
