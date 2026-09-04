/**
 * MCP reservation only: the protocol server is intentionally not started in
 * the first release. These descriptors keep the future tool catalog aligned
 * with the JSON service layer without introducing an MCP runtime dependency.
 */
export interface McpToolDescriptor {
  name: string
  description: string
  readOnly: boolean
  destructive: boolean
  service: string
  operation: 'list' | 'get' | 'create' | 'update' | 'delete' | 'reorder'
}

export const RESERVED_MCP_TOOLS: readonly McpToolDescriptor[] = [
  { name: 'search_opportunities', description: 'Search job opportunities', readOnly: true, destructive: false, service: 'OpportunityService', operation: 'list' },
  { name: 'get_opportunity', description: 'Get one job opportunity', readOnly: true, destructive: false, service: 'OpportunityService', operation: 'get' },
  { name: 'create_opportunity', description: 'Create a job opportunity', readOnly: false, destructive: false, service: 'OpportunityService', operation: 'create' },
  { name: 'update_opportunity', description: 'Update a job opportunity', readOnly: false, destructive: false, service: 'OpportunityService', operation: 'update' },
  { name: 'delete_opportunity', description: 'Delete a job opportunity', readOnly: false, destructive: true, service: 'OpportunityService', operation: 'delete' },
  { name: 'list_statuses', description: 'List job statuses', readOnly: true, destructive: false, service: 'StatusService', operation: 'list' },
  { name: 'create_status', description: 'Create a job status', readOnly: false, destructive: false, service: 'StatusService', operation: 'create' },
  { name: 'delete_status', description: 'Delete a job status', readOnly: false, destructive: true, service: 'StatusService', operation: 'delete' },
  { name: 'list_industries', description: 'List industries', readOnly: true, destructive: false, service: 'IndustryService', operation: 'list' },
  { name: 'create_industry', description: 'Create an industry', readOnly: false, destructive: false, service: 'IndustryService', operation: 'create' },
  { name: 'update_industry', description: 'Update an industry', readOnly: false, destructive: false, service: 'IndustryService', operation: 'update' },
  { name: 'delete_industry', description: 'Delete an industry', readOnly: false, destructive: true, service: 'IndustryService', operation: 'delete' },
  { name: 'reorder_industries', description: 'Reorder industries', readOnly: false, destructive: false, service: 'IndustryService', operation: 'reorder' },
  { name: 'search_companies', description: 'Search companies', readOnly: true, destructive: false, service: 'CompanyService', operation: 'list' },
  { name: 'list_resume_versions', description: 'List resume versions', readOnly: true, destructive: false, service: 'ResumeVersionService', operation: 'list' },
  { name: 'list_calendar_events', description: 'List calendar events', readOnly: true, destructive: false, service: 'CalendarEventService', operation: 'list' },
  { name: 'create_calendar_event', description: 'Create a calendar event', readOnly: false, destructive: false, service: 'CalendarEventService', operation: 'create' },
  { name: 'update_calendar_event', description: 'Update a calendar event', readOnly: false, destructive: false, service: 'CalendarEventService', operation: 'update' },
  { name: 'delete_calendar_event', description: 'Delete a calendar event', readOnly: false, destructive: true, service: 'CalendarEventService', operation: 'delete' },
]
