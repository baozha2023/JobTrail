import type {
  AppConfig,
  CalendarEvent,
  CalendarRange,
  Company,
  CreateCalendarEventInput,
  CreateCompanyInput,
  CreateIndustryInput,
  CreateOpportunityInput,
  CreateStatusInput,
  Industry,
  Opportunity,
  OpportunityQuery,
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
} from './types'

export interface IpcChannelMap {
  'config:get': { args: []; result: AppConfig }
  'config:update': { args: [input: Partial<AppConfig>]; result: AppConfig }

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
  'industries:reorder': { args: [order: number[]]; result: Industry[] }

  'companies:search': { args: [keyword: string]; result: Company[] }
  'companies:list': { args: []; result: Company[] }
  'companies:get': { args: [id: number]; result: Company }
  'companies:mark-read': { args: [id: number]; result: Company }
  'companies:create': { args: [input: CreateCompanyInput]; result: Company }
  'companies:update': { args: [id: number, input: UpdateCompanyInput]; result: Company }
  'companies:delete': { args: [id: number]; result: void }

  'resumes:list': { args: []; result: ResumeVersion[] }
  'resumes:get': { args: [id: number]; result: ResumeVersion }
  'resumes:import': { args: []; result: ResumeImportResult | null }
  'resumes:open': { args: [id: number]; result: void }
  'resumes:update': { args: [id: number, input: UpdateResumeVersionInput]; result: ResumeVersion }
  'resumes:reorder': { args: [order: number[]]; result: ResumeVersion[] }
  'resumes:delete': { args: [id: number]; result: void }

  'opportunities:list': { args: [query: OpportunityQuery]; result: Opportunity[] }
  'opportunities:get': { args: [id: number]; result: Opportunity }
  'opportunities:create': { args: [input: CreateOpportunityInput]; result: Opportunity }
  'opportunities:update': { args: [id: number, input: UpdateOpportunityInput]; result: Opportunity }
  'opportunities:delete': { args: [id: number]; result: void }
  'opportunities:change-status': { args: [id: number, statusId: number]; result: Opportunity }

  'calendar:list': { args: [range: CalendarRange]; result: CalendarEvent[] }
  'calendar:get': { args: [id: number]; result: CalendarEvent }
  'calendar:create': { args: [input: CreateCalendarEventInput]; result: CalendarEvent }
  'calendar:update': { args: [id: number, input: UpdateCalendarEventInput]; result: CalendarEvent }
  'calendar:delete': { args: [id: number]; result: void }
  'calendar:complete': { args: [id: number, completed: boolean]; result: CalendarEvent }

  'system:open-external': { args: [url: string]; result: void }
  'system:is-development': { args: []; result: boolean }
  'window:minimize': { args: []; result: void }
  'window:toggle-maximize': { args: []; result: boolean }
  'window:close': { args: []; result: void }

  'velopack:get-version': { args: []; result: string }
  'velopack:check-for-update': { args: []; result: import('velopack').UpdateInfo | null }
  'velopack:download-update': { args: []; result: boolean }
  'velopack:apply-update': { args: []; result: boolean }
  'velopack:uninstall': { args: []; result: 'started' | 'development' | 'unavailable' }
}

export type IpcChannel = keyof IpcChannelMap
export type IpcArgs<K extends IpcChannel> = IpcChannelMap[K]['args']
export type IpcResult<K extends IpcChannel> = IpcChannelMap[K]['result']

export type IpcResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: AppErrorShape }
