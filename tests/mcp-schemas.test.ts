import { describe, expect, it } from 'vitest'
import { MCP_TOOLS } from '../src/main/mcp-contracts'

function schema(name: string) {
  const tool = MCP_TOOLS.find((item) => item.name === name)
  if (!tool) throw new Error(`Missing MCP tool ${name}`)
  return tool.inputSchema
}

describe('MCP input schemas', () => {
  it('rejects invalid identifiers, empty updates and unknown fields', () => {
    expect(schema('get_status').safeParse({ id: 0 }).success).toBe(false)
    expect(schema('update_status').safeParse({ id: 1, input: {} }).success).toBe(false)
    expect(
      schema('create_company').safeParse({ input: { name: 'Acme', unexpected: true } }).success,
    ).toBe(false)
  })

  it('rejects invalid time ranges and order arrays', () => {
    expect(
      schema('list_calendar_events').safeParse({ range: { startAt: 20, endAt: 10 } }).success,
    ).toBe(false)
    expect(schema('reorder_statuses').safeParse({ order: [1, 1] }).success).toBe(false)
    expect(schema('reorder_statuses').safeParse({ order: [] }).success).toBe(false)
  })
})
