import { describe, expect, it } from 'vitest'
import { MCP_TOOLS } from '../src/main/mcp-contracts'

describe('MCP tool contracts', () => {
  it('rejects unstructured exam output and limits the confirmation exception to four exam writes', () => {
    const exams = MCP_TOOLS.filter((tool) => tool.name.includes('exam_'))
    expect(exams).toHaveLength(5)
    for (const tool of exams)
      expect(tool.outputSchema.safeParse({ paper: { unexpected: true } }).success).toBe(false)
    expect(
      MCP_TOOLS.filter((tool) => tool.confirmation === 'never').map((tool) => tool.name),
    ).toEqual([
      'create_exam_paper',
      'update_exam_paper',
      'append_exam_question',
      'complete_exam_paper',
    ])
  })
  it('covers domain service methods without exposing SQL or standalone aliases', () => {
    const names = MCP_TOOLS.map((tool) => tool.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'update_exam_paper',
        'list_statuses',
        'get_status',
        'create_status',
        'update_status',
        'delete_status',
        'reorder_statuses',
        'list_industries',
        'get_industry',
        'create_industry',
        'update_industry',
        'delete_industry',
        'reorder_industries',
        'search_companies',
        'list_companies',
        'get_company',
        'read_web_page',
        'mark_company_read',
        'create_company',
        'update_company',
        'delete_company',
        'list_resume_versions',
        'get_resume_version',
        'import_resume_version',
        'update_resume_version',
        'reorder_resume_versions',
        'delete_resume_version',
        'search_opportunities',
        'get_opportunity',
        'create_opportunity',
        'update_opportunity',
        'delete_opportunity',
        'change_opportunity_status',
        'list_calendar_events',
        'get_calendar_event',
        'create_calendar_event',
        'update_calendar_event',
        'delete_calendar_event',
      ]),
    )
    expect(names.some((name) => name.includes('alias'))).toBe(false)
    expect(names).not.toContain('discover_web_jobs')
    expect(MCP_TOOLS.some((tool) => tool.description.toLowerCase().includes('sql'))).toBe(false)
    expect(MCP_TOOLS.filter((tool) => tool.destructive).every((tool) => !tool.readOnly)).toBe(true)
    expect(MCP_TOOLS).toHaveLength(42)
    expect(new Set(names)).toHaveProperty('size', 42)
    expect(MCP_TOOLS.filter((tool) => tool.readOnly)).toHaveLength(15)
    expect(MCP_TOOLS.filter((tool) => !tool.readOnly)).toHaveLength(27)
    expect(MCP_TOOLS.filter((tool) => !tool.readOnly).every((tool) => tool.preview)).toBe(true)
    expect(MCP_TOOLS.filter((tool) => tool.readOnly).every((tool) => !tool.preview)).toBe(true)
  })
})
