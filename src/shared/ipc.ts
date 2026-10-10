import type { BrowserLoadingState, DiscoveryApi } from './job-discovery'
import type { ExamIdentity, ExamPaper, SaveExamAnswerInput } from './exams'
import type {
  ExamChangeEvent,
  AppConfig,
  AppConfigUpdate,
  CalendarEvent,
  CalendarRange,
  Company,
  CompanySummary,
  CompanyLocationQuery,
  CompanyQuery,
  CreateCalendarEventInput,
  CreateCompanyInput,
  CreateIndustryInput,
  CreateOpportunityInput,
  CreateStatusInput,
  Industry,
  ReorderIndustriesInput,
  Opportunity,
  OpportunityStatusFlow,
  OpportunityQuery,
  PageResult,
  ResumeImportResult,
  ResumeVersion,
  Status,
  UpdateCalendarEventInput,
  UpdateCompanyInput,
  UpdateIndustryInput,
  UpdateOpportunityInput,
  UpdateResumeVersionInput,
  UpdateStatusInput,
  AppErrorShape,
  CompanyCatalogStatus,
  CompanyCatalogProgress,
  CompanyCatalogUpdateResult,
  McpConnectionInfo,
  AgentConversation,
  AgentHistory,
  AgentAttachment,
  AgentEvent,
  AgentDraftPart,
  AgentJobReceipt,
  AppUpdateProgress,
  BackupImportConfirmation,
} from './types'

export interface IpcChannelMap {
  'discovery:status': {
    args: Parameters<DiscoveryApi['status']>
    result: Awaited<ReturnType<DiscoveryApi['status']>>
  }
  'discovery:start': {
    args: Parameters<DiscoveryApi['start']>
    result: Awaited<ReturnType<DiscoveryApi['start']>>
  }
  'discovery:run': {
    args: Parameters<DiscoveryApi['run']>
    result: Awaited<ReturnType<DiscoveryApi['run']>>
  }
  'discovery:list': {
    args: Parameters<DiscoveryApi['list']>
    result: Awaited<ReturnType<DiscoveryApi['list']>>
  }
  'discovery:continue': {
    args: Parameters<DiscoveryApi['continue']>
    result: Awaited<ReturnType<DiscoveryApi['continue']>>
  }
  'discovery:cancel': {
    args: Parameters<DiscoveryApi['cancel']>
    result: Awaited<ReturnType<DiscoveryApi['cancel']>>
  }
  'discovery:detail': {
    args: Parameters<DiscoveryApi['detail']>
    result: Awaited<ReturnType<DiscoveryApi['detail']>>
  }
  'discovery:history': {
    args: Parameters<DiscoveryApi['history']>
    result: Awaited<ReturnType<DiscoveryApi['history']>>
  }
  'discovery:removeHistory': {
    args: Parameters<DiscoveryApi['removeHistory']>
    result: Awaited<ReturnType<DiscoveryApi['removeHistory']>>
  }
  'discovery:save': {
    args: Parameters<DiscoveryApi['save']>
    result: Awaited<ReturnType<DiscoveryApi['save']>>
  }
  'discovery:browser': {
    args: Parameters<DiscoveryApi['browser']>
    result: Awaited<ReturnType<DiscoveryApi['browser']>>
  }
  'discovery:qrLogin': {
    args: Parameters<DiscoveryApi['qrLogin']>
    result: Awaited<ReturnType<DiscoveryApi['qrLogin']>>
  }
  'discovery:region': {
    args: Parameters<DiscoveryApi['region']>
    result: Awaited<ReturnType<DiscoveryApi['region']>>
  }
  'discovery:verification': {
    args: Parameters<DiscoveryApi['verification']>
    result: Awaited<ReturnType<DiscoveryApi['verification']>>
  }
  'diagnostics:open-directory': { args: []; result: void }
  'diagnostics:export': { args: []; result: 'cancelled' | 'exported' }
  'exams:get': { args: [input: ExamIdentity]; result: ExamPaper }
  'exams:save': { args: [input: SaveExamAnswerInput]; result: ExamPaper }
  'exams:submit': { args: [input: SaveExamAnswerInput]; result: ExamPaper }
  'exams:reset': { args: [input: ExamIdentity]; result: ExamPaper }
  'exams:grade': { args: [input: SaveExamAnswerInput]; result: ExamPaper }
  'backup:export': { args: []; result: 'cancelled' | 'exported' }
  'backup:import': { args: []; result: 'cancelled' | 'restarting' }
  'backup:confirm-import': { args: [requestId: string, confirmed: boolean]; result: void }
  'agent:list': { args: []; result: AgentConversation[] }
  'agent:create': { args: []; result: AgentConversation }
  'agent:history': { args: [id: string]; result: AgentHistory }
  'agent:rename': { args: [id: string, title: string]; result: AgentConversation }
  'agent:delete': { args: [id: string]; result: void }
  'agent:upload': { args: [id: string]; result: AgentAttachment | null }
  'agent:upload-bytes': {
    args: [id: string, name: string, mimeType: string, bytes: Uint8Array]
    result: AgentAttachment
  }
  'agent:preview': { args: [id: string, attachmentId: string]; result: string | null }
  'agent:open-attachment': { args: [id: string, attachmentId: string]; result: void }
  'agent:remove-upload': { args: [id: string, attachmentId: string]; result: void }
  'agent:send': {
    args: [id: string, parts: AgentDraftPart[], attachmentIds: string[], jobId: string]
    result: AgentJobReceipt
  }
  'agent:compact': { args: [id: string, jobId: string]; result: AgentJobReceipt }
  'agent:resume': {
    args: [id: string, answer: string[] | boolean, jobId: string]
    result: AgentJobReceipt
  }
  'agent:cancel': { args: [id: string]; result: void }
  'agent:save-settings': {
    args: [ai: AppConfig['ai']]
    result: AppConfig
  }
  'config:get': { args: []; result: AppConfig }
  'config:update': { args: [input: AppConfigUpdate]; result: AppConfig }
  'mcp:get-connection-info': { args: []; result: McpConnectionInfo }

  'statuses:list': { args: []; result: Status[] }
  'statuses:get': { args: [id: number]; result: Status }
  'statuses:create': { args: [input: CreateStatusInput]; result: Status }
  'statuses:update': { args: [id: number, input: UpdateStatusInput]; result: Status }
  'statuses:delete': { args: [id: number]; result: void }
  'statuses:reorder': { args: [order: number[]]; result: Status[] }

  'industries:list': { args: []; result: Industry[] }
  'industries:get': { args: [id: number]; result: Industry }
  'industries:create': { args: [input: CreateIndustryInput]; result: Industry }
  'industries:update': { args: [id: number, input: UpdateIndustryInput]; result: Industry }
  'industries:delete': { args: [id: number]; result: void }
  'industries:reorder': { args: [input: ReorderIndustriesInput]; result: Industry[] }

  'companies:search': { args: [query: CompanyQuery]; result: PageResult<Company> }
  'companies:list': { args: []; result: CompanySummary[] }
  'companies:search-locations': { args: [query: CompanyLocationQuery]; result: PageResult<string> }
  'companies:get': { args: [id: number]; result: Company }
  'companies:mark-read': { args: [id: number]; result: Company }
  'companies:create': { args: [input: CreateCompanyInput]; result: Company }
  'companies:update': { args: [id: number, input: UpdateCompanyInput]; result: Company }
  'companies:delete': { args: [id: number]; result: void }

  'company-catalog:get-status': { args: []; result: CompanyCatalogStatus }
  'company-catalog:update': { args: []; result: CompanyCatalogUpdateResult }

  'resumes:list': { args: []; result: ResumeVersion[] }
  'resumes:get': { args: [id: number]; result: ResumeVersion }
  'resumes:import': { args: []; result: ResumeImportResult | null }
  'resumes:open': { args: [id: number]; result: void }
  'resumes:update': { args: [id: number, input: UpdateResumeVersionInput]; result: ResumeVersion }
  'resumes:reorder': { args: [order: number[]]; result: ResumeVersion[] }
  'resumes:delete': { args: [id: number]; result: void }

  'opportunities:search': {
    args: [query: OpportunityQuery]
    result: PageResult<Opportunity>
  }
  'opportunities:list': { args: []; result: Opportunity[] }
  'opportunities:get': { args: [id: number]; result: Opportunity }
  'opportunities:status-flow': { args: [id: number]; result: OpportunityStatusFlow }
  'opportunities:create': { args: [input: CreateOpportunityInput]; result: Opportunity }
  'opportunities:update': { args: [id: number, input: UpdateOpportunityInput]; result: Opportunity }
  'opportunities:delete': { args: [id: number]; result: void }
  'opportunities:change-status': { args: [id: number, statusId: number]; result: Opportunity }

  'calendar:list': { args: [range: CalendarRange]; result: CalendarEvent[] }
  'calendar:get': { args: [id: number]; result: CalendarEvent }
  'calendar:create': { args: [input: CreateCalendarEventInput]; result: CalendarEvent }
  'calendar:update': { args: [id: number, input: UpdateCalendarEventInput]; result: CalendarEvent }
  'calendar:delete': { args: [id: number]; result: void }

  'system:open-external': { args: [url: string]; result: void }
  'system:is-development': { args: []; result: boolean }
  'window:minimize': { args: []; result: void }
  'window:toggle-maximize': { args: []; result: boolean }
  'window:close': { args: []; result: void }

  'velopack:get-version': { args: []; result: string }
  'velopack:renderer-healthy': { args: []; result: boolean }
  'velopack:check-for-update': { args: []; result: import('velopack').UpdateInfo | null }
  'velopack:download-update': { args: [attemptId: number]; result: boolean }
  'velopack:apply-update': { args: [attemptId: number]; result: boolean }
  'velopack:uninstall': { args: []; result: 'started' | 'development' | 'unavailable' }
}

export type IpcChannel = keyof IpcChannelMap
export type IpcArgs<K extends IpcChannel> = IpcChannelMap[K]['args']
export type IpcResult<K extends IpcChannel> = IpcChannelMap[K]['result']

export interface AppEventMap {
  'discovery:browser-loading': BrowserLoadingState
  'backup:import-confirmation': BackupImportConfirmation
  'exams:changed': ExamChangeEvent
  'company-catalog:progress': CompanyCatalogProgress
  'agent:event': AgentEvent
  'velopack:progress': AppUpdateProgress
}

export type AppEventChannel = keyof AppEventMap

export type IpcResponse<T> = { ok: true; data: T } | { ok: false; error: AppErrorShape }
