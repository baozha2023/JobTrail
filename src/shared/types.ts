export type ThemeMode = 'light' | 'dark' | 'system'
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
  | 'INTERNAL_ERROR'

export interface VelopackConfig {
  [key: string]: unknown
}

export interface AppConfig {
  configVersion: number
  themeMode: ThemeMode
  locale: Locale
  closeBehavior: CloseBehavior
  launchAtStartup: boolean
  companyReadValidityMonths: number
  velopack: VelopackConfig
  mcp: {
    enabled: boolean
    requireWriteConfirmation: boolean
  }
  [key: string]: unknown
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
  config: {
    get(): Promise<AppConfig>
    update(input: Partial<AppConfig>): Promise<AppConfig>
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
    complete(id: number, completed: boolean): Promise<CalendarEvent>
    onReminderClick(listener: (notification: CalendarReminderNotification) => void): () => void
  }
  system: {
    openExternal(url: string): Promise<void>
    isDevelopment(): Promise<boolean>
  }
}

export interface VelopackApi {
  getVersion(): Promise<string>
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
