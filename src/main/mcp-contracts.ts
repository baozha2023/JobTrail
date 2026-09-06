/**
 * 首版只登记 MCP 合同，不启动协议服务、不引入 MCP 运行时依赖。
 * 每个工具都映射到一个现有 Service 的领域方法，未来 stdio Server 只需接入此注册表。
 */
type ServiceOperationMap = {
  StatusService: 'list' | 'get' | 'create' | 'update' | 'delete' | 'reorder'
  IndustryService: 'list' | 'get' | 'create' | 'update' | 'delete' | 'reorder'
  CompanyService: 'search' | 'list' | 'get' | 'markRead' | 'create' | 'update' | 'delete'
  ResumeService: 'list' | 'get' | 'importFromPath' | 'update' | 'reorder' | 'delete'
  OpportunityService: 'list' | 'get' | 'create' | 'update' | 'delete' | 'changeStatus'
  CalendarEventService: 'list' | 'get' | 'create' | 'update' | 'delete' | 'complete'
}

type McpServiceName = keyof ServiceOperationMap

export interface McpToolDescriptor<S extends McpServiceName = McpServiceName> {
  name: string
  description: string
  readOnly: boolean
  destructive: boolean
  service: S
  operation: ServiceOperationMap[S]
  inputSchema: Readonly<Record<string, string>>
  outputDto: string
}

export const RESERVED_MCP_TOOLS = [
  { name: 'list_statuses', description: 'List job statuses', readOnly: true, destructive: false, service: 'StatusService', operation: 'list', inputSchema: {}, outputDto: 'Status[]' },
  { name: 'get_status', description: 'Get one job status', readOnly: true, destructive: false, service: 'StatusService', operation: 'get', inputSchema: { id: 'number' }, outputDto: 'Status' },
  { name: 'create_status', description: 'Create a job status', readOnly: false, destructive: false, service: 'StatusService', operation: 'create', inputSchema: { input: 'CreateStatusInput' }, outputDto: 'Status' },
  { name: 'update_status', description: 'Update a job status', readOnly: false, destructive: false, service: 'StatusService', operation: 'update', inputSchema: { id: 'number', input: 'UpdateStatusInput' }, outputDto: 'Status' },
  { name: 'delete_status', description: 'Delete a job status', readOnly: false, destructive: true, service: 'StatusService', operation: 'delete', inputSchema: { id: 'number' }, outputDto: 'void' },
  { name: 'reorder_statuses', description: 'Reorder job statuses', readOnly: false, destructive: false, service: 'StatusService', operation: 'reorder', inputSchema: { order: 'number[]' }, outputDto: 'Status[]' },
  { name: 'list_industries', description: 'List industries', readOnly: true, destructive: false, service: 'IndustryService', operation: 'list', inputSchema: {}, outputDto: 'Industry[]' },
  { name: 'get_industry', description: 'Get one industry', readOnly: true, destructive: false, service: 'IndustryService', operation: 'get', inputSchema: { id: 'number' }, outputDto: 'Industry' },
  { name: 'create_industry', description: 'Create an industry', readOnly: false, destructive: false, service: 'IndustryService', operation: 'create', inputSchema: { input: 'CreateIndustryInput' }, outputDto: 'Industry' },
  { name: 'update_industry', description: 'Update an industry', readOnly: false, destructive: false, service: 'IndustryService', operation: 'update', inputSchema: { id: 'number', input: 'UpdateIndustryInput' }, outputDto: 'Industry' },
  { name: 'delete_industry', description: 'Delete an industry', readOnly: false, destructive: true, service: 'IndustryService', operation: 'delete', inputSchema: { id: 'number' }, outputDto: 'void' },
  { name: 'reorder_industries', description: 'Reorder industries', readOnly: false, destructive: false, service: 'IndustryService', operation: 'reorder', inputSchema: { order: 'number[]' }, outputDto: 'Industry[]' },
  { name: 'search_companies', description: 'Search companies by name, industry, or alias', readOnly: true, destructive: false, service: 'CompanyService', operation: 'search', inputSchema: { keyword: 'string' }, outputDto: 'Company[]' },
  { name: 'list_companies', description: 'List companies', readOnly: true, destructive: false, service: 'CompanyService', operation: 'list', inputSchema: {}, outputDto: 'Company[]' },
  { name: 'get_company', description: 'Get one company', readOnly: true, destructive: false, service: 'CompanyService', operation: 'get', inputSchema: { id: 'number' }, outputDto: 'Company' },
  { name: 'mark_company_read', description: 'Mark a company career site as read', readOnly: false, destructive: false, service: 'CompanyService', operation: 'markRead', inputSchema: { id: 'number' }, outputDto: 'Company' },
  { name: 'create_company', description: 'Create a company and its aliases', readOnly: false, destructive: false, service: 'CompanyService', operation: 'create', inputSchema: { input: 'CreateCompanyInput' }, outputDto: 'Company' },
  { name: 'update_company', description: 'Update a company and its aliases', readOnly: false, destructive: false, service: 'CompanyService', operation: 'update', inputSchema: { id: 'number', input: 'UpdateCompanyInput' }, outputDto: 'Company' },
  { name: 'delete_company', description: 'Delete a company', readOnly: false, destructive: true, service: 'CompanyService', operation: 'delete', inputSchema: { id: 'number' }, outputDto: 'void' },
  { name: 'list_resume_versions', description: 'List resume versions', readOnly: true, destructive: false, service: 'ResumeService', operation: 'list', inputSchema: {}, outputDto: 'ResumeVersion[]' },
  { name: 'get_resume_version', description: 'Get one resume version', readOnly: true, destructive: false, service: 'ResumeService', operation: 'get', inputSchema: { id: 'number' }, outputDto: 'ResumeVersion' },
  { name: 'import_resume_version', description: 'Import a resume version', readOnly: false, destructive: false, service: 'ResumeService', operation: 'importFromPath', inputSchema: { sourcePath: 'string' }, outputDto: 'ResumeImportResult' },
  { name: 'update_resume_version', description: 'Update a resume version', readOnly: false, destructive: false, service: 'ResumeService', operation: 'update', inputSchema: { id: 'number', input: 'UpdateResumeVersionInput' }, outputDto: 'ResumeVersion' },
  { name: 'reorder_resume_versions', description: 'Reorder resume versions', readOnly: false, destructive: false, service: 'ResumeService', operation: 'reorder', inputSchema: { order: 'number[]' }, outputDto: 'ResumeVersion[]' },
  { name: 'delete_resume_version', description: 'Delete a resume version', readOnly: false, destructive: true, service: 'ResumeService', operation: 'delete', inputSchema: { id: 'number' }, outputDto: 'void' },
  { name: 'search_opportunities', description: 'Search job opportunities', readOnly: true, destructive: false, service: 'OpportunityService', operation: 'list', inputSchema: { query: 'OpportunityQuery' }, outputDto: 'Opportunity[]' },
  { name: 'get_opportunity', description: 'Get one job opportunity', readOnly: true, destructive: false, service: 'OpportunityService', operation: 'get', inputSchema: { id: 'number' }, outputDto: 'Opportunity' },
  { name: 'create_opportunity', description: 'Create a job opportunity', readOnly: false, destructive: false, service: 'OpportunityService', operation: 'create', inputSchema: { input: 'CreateOpportunityInput' }, outputDto: 'Opportunity' },
  { name: 'update_opportunity', description: 'Update a job opportunity', readOnly: false, destructive: false, service: 'OpportunityService', operation: 'update', inputSchema: { id: 'number', input: 'UpdateOpportunityInput' }, outputDto: 'Opportunity' },
  { name: 'delete_opportunity', description: 'Delete a job opportunity', readOnly: false, destructive: true, service: 'OpportunityService', operation: 'delete', inputSchema: { id: 'number' }, outputDto: 'void' },
  { name: 'change_opportunity_status', description: 'Change a job opportunity status', readOnly: false, destructive: false, service: 'OpportunityService', operation: 'changeStatus', inputSchema: { id: 'number', statusId: 'number' }, outputDto: 'Opportunity' },
  { name: 'list_calendar_events', description: 'List calendar events in a range', readOnly: true, destructive: false, service: 'CalendarEventService', operation: 'list', inputSchema: { range: 'CalendarRange' }, outputDto: 'CalendarEvent[]' },
  { name: 'get_calendar_event', description: 'Get one calendar event', readOnly: true, destructive: false, service: 'CalendarEventService', operation: 'get', inputSchema: { id: 'number' }, outputDto: 'CalendarEvent' },
  { name: 'create_calendar_event', description: 'Create a calendar event', readOnly: false, destructive: false, service: 'CalendarEventService', operation: 'create', inputSchema: { input: 'CreateCalendarEventInput' }, outputDto: 'CalendarEvent' },
  { name: 'update_calendar_event', description: 'Update a calendar event', readOnly: false, destructive: false, service: 'CalendarEventService', operation: 'update', inputSchema: { id: 'number', input: 'UpdateCalendarEventInput' }, outputDto: 'CalendarEvent' },
  { name: 'delete_calendar_event', description: 'Delete a calendar event', readOnly: false, destructive: true, service: 'CalendarEventService', operation: 'delete', inputSchema: { id: 'number' }, outputDto: 'void' },
  { name: 'complete_calendar_event', description: 'Mark a calendar event complete', readOnly: false, destructive: false, service: 'CalendarEventService', operation: 'complete', inputSchema: { id: 'number', completed: 'boolean' }, outputDto: 'CalendarEvent' },
] as const satisfies readonly McpToolDescriptor[]
