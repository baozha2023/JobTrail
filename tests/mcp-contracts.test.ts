import { describe, expect, it } from 'vitest'
import { RESERVED_MCP_TOOLS } from '../src/main/mcp-contracts'

describe('MCP reservation contracts', () => {
  it('covers domain service methods without exposing SQL or standalone aliases', () => {
    const names = RESERVED_MCP_TOOLS.map((tool) => tool.name)
    expect(names).toEqual(expect.arrayContaining([
      'list_statuses', 'get_status', 'create_status', 'update_status', 'delete_status', 'reorder_statuses',
      'list_industries', 'get_industry', 'create_industry', 'update_industry', 'delete_industry', 'reorder_industries',
      'search_companies', 'list_companies', 'get_company', 'mark_company_read', 'create_company', 'update_company', 'delete_company',
      'list_resume_versions', 'get_resume_version', 'import_resume_version', 'update_resume_version', 'reorder_resume_versions', 'delete_resume_version',
      'search_opportunities', 'get_opportunity', 'create_opportunity', 'update_opportunity', 'delete_opportunity', 'change_opportunity_status',
      'list_calendar_events', 'get_calendar_event', 'create_calendar_event', 'update_calendar_event', 'delete_calendar_event', 'complete_calendar_event',
    ]))
    expect(names.some((name) => name.includes('alias'))).toBe(false)
    expect(RESERVED_MCP_TOOLS.some((tool) => tool.description.toLowerCase().includes('sql'))).toBe(false)
    expect(RESERVED_MCP_TOOLS.filter((tool) => tool.destructive).every((tool) => !tool.readOnly)).toBe(true)
  })
})
