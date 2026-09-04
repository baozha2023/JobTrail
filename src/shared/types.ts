export type ThemeMode = 'light' | 'dark' | 'system'
export type Locale = 'zh-CN' | 'en-US'
export type CloseBehavior = 'tray' | 'quit'

export interface AppConfig {
  configVersion: number
  themeMode: ThemeMode
  locale: Locale
  closeBehavior: CloseBehavior
  launchAtStartup: boolean
  velopack: {
    githubRepository: string
    includePrerelease: boolean
  }
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
  industryId: number | null
  industryName: string | null
  careerUrl: string | null
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

export interface CompanyAlias {
  id: number
  companyId: number
  alias: string
  createdAt: number
}

export interface ResumeVersion {
  id: number
  name: string
  relativePath: string
  sizeBytes: number | null
  sha256: string | null
  note: string | null
  isActive: boolean
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

export interface CreateCompanyInput {
  name: string
  industryId?: number | null
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

export interface CreateCompanyAliasInput {
  companyId: number
  alias: string
}

export type UpdateCompanyAliasInput = Partial<Pick<CreateCompanyAliasInput, 'alias'>>

export interface CreateStatusInput {
  label: string
}

export type UpdateStatusInput = Partial<CreateStatusInput>

export interface UpdateResumeVersionInput {
  name?: string
  note?: string | null
  isActive?: boolean
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
  code: string
  message: string
  details?: Record<string, unknown>
}

export interface JobTrailApi {
  config: {
    get(): Promise<AppConfig>
    update(input: Partial<AppConfig>): Promise<AppConfig>
  }
  statuses: {
    list(): Promise<Status[]>
    create(input: CreateStatusInput): Promise<Status>
    update(id: number, input: UpdateStatusInput): Promise<Status>
    delete(id: number): Promise<void>
    reorder(order: number[]): Promise<Status[]>
  }
  industries: {
    list(): Promise<Industry[]>
    create(input: CreateIndustryInput): Promise<Industry>
    update(id: number, input: UpdateIndustryInput): Promise<Industry>
    delete(id: number): Promise<void>
    reorder(order: number[]): Promise<Industry[]>
  }
  companies: {
    search(keyword: string): Promise<Company[]>
    recent(): Promise<Company[]>
    create(input: CreateCompanyInput): Promise<Company>
    update(id: number, input: UpdateCompanyInput): Promise<Company>
    delete(id: number): Promise<void>
    aliases: {
      list(companyId: number): Promise<CompanyAlias[]>
      create(input: CreateCompanyAliasInput): Promise<CompanyAlias>
      update(id: number, input: UpdateCompanyAliasInput): Promise<CompanyAlias>
      delete(id: number): Promise<void>
    }
  }
  resumes: {
    list(): Promise<ResumeVersion[]>
    import(): Promise<ResumeImportResult | null>
    open(id: number): Promise<void>
    update(id: number, input: UpdateResumeVersionInput): Promise<ResumeVersion>
    delete(id: number): Promise<void>
  }
  opportunities: {
    list(query: OpportunityQuery): Promise<Opportunity[]>
    create(input: CreateOpportunityInput): Promise<Opportunity>
    update(id: number, input: UpdateOpportunityInput): Promise<Opportunity>
    delete(id: number): Promise<void>
    changeStatus(id: number, statusId: number): Promise<Opportunity>
  }
  calendar: {
    list(range: CalendarRange): Promise<CalendarEvent[]>
    create(input: CreateCalendarEventInput): Promise<CalendarEvent>
    update(id: number, input: UpdateCalendarEventInput): Promise<CalendarEvent>
    delete(id: number): Promise<void>
    complete(id: number, completed: boolean): Promise<CalendarEvent>
  }
  system: {
    openExternal(url: string): Promise<void>
  }
}

export interface VelopackApi {
  getVersion(): Promise<string>
  checkForUpdates(): Promise<unknown | null>
  downloadUpdates(info: unknown): Promise<boolean>
  applyUpdates(info: unknown): Promise<boolean>
}

export interface WindowControlsApi {
  minimize(): Promise<void>
  toggleMaximize(): Promise<boolean>
  close(): Promise<void>
}
