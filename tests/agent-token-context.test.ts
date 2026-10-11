import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  contextBudget,
  createContextBaseline,
  createCompactedContextBaseline,
  measureContext,
} from '../src/main/agent/context'
import { countMessageTokens } from '../src/main/agent/token-count'

const ai = { modelId: 'mock', baseUrl: 'http://127.0.0.1:12345/v1' }
const system = new SystemMessage('Help the user.')
const tools = [
  { name: 'read_file', description: 'Read a file', schema: z.object({ path: z.string() }) },
]
const messages = [new HumanMessage('Read the job description')]

describe('shared context accounting', () => {
  it('keeps cached input in the baseline and only adds new messages, not billed reasoning output', () => {
    const initial = measureContext(ai, system, messages, tools)
    const baseline = createContextBaseline(initial, {
      input_tokens: 8000,
      output_tokens: 5000,
      total_tokens: 13000,
      input_token_details: { cache_read: 7000 },
      output_token_details: { reasoning: 4900 },
    })!
    expect(measureContext(ai, system, messages, tools, baseline)).toMatchObject({
      tokens: 8000,
      estimated: false,
    })
    const reply = new AIMessage('Done.')
    const current = measureContext(ai, system, [...messages, reply], tools, baseline)
    expect(current.tokens).toBe(8000 + countMessageTokens(ai.modelId, [reply]).countPerMessage[0])
    expect(current.estimated).toBe(true)
    expect(measureContext(ai, system, [...messages, reply], tools, baseline).tokens).toBe(
      current.tokens,
    )
  })

  it('counts function arguments and results even when assistant text is empty', () => {
    const initial = measureContext(ai, system, messages, tools)
    const baseline = createContextBaseline(initial, {
      input_tokens: 100,
      output_tokens: 10,
      total_tokens: 110,
    })!
    const call = new AIMessage({
      content: '',
      tool_calls: [{ id: 'read-1', name: 'read_file', args: { path: 'work '.repeat(300) } }],
    })
    const result = new ToolMessage({ content: 'requirements '.repeat(500), tool_call_id: 'read-1' })
    const called = measureContext(ai, system, [...messages, call], tools, baseline)
    const completed = measureContext(ai, system, [...messages, call, result], tools, baseline)
    expect(called.tokens).toBeGreaterThan(400)
    expect(completed.tokens).toBeGreaterThan(called.tokens + 500)
  })

  it.each(['removed', 'replaced', 'summary', 'tools', 'model', 'endpoint', 'image'] as const)(
    'discards an actual baseline after the %s changes',
    (change) => {
      const baseline = createContextBaseline(measureContext(ai, system, messages, tools), {
        input_tokens: 100000,
        output_tokens: 1,
        total_tokens: 100001,
      })!
      const nextAi = {
        ...ai,
        ...(change === 'model' ? { modelId: 'gpt-4o' } : {}),
        ...(change === 'endpoint' ? { baseUrl: 'http://localhost:12346/v1' } : {}),
      }
      const nextSystem = change === 'summary' ? new SystemMessage('A compacted summary') : system
      const nextMessages =
        change === 'removed'
          ? []
          : change === 'replaced'
            ? [new HumanMessage('Replaced input')]
            : change === 'image'
              ? [
                  new HumanMessage({
                    content: [
                      { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
                    ],
                  }),
                ]
              : messages
      const nextTools = change === 'tools' ? [] : tools
      const current = measureContext(nextAi, nextSystem, nextMessages, nextTools, baseline)
      expect(current.tokens).toBe(
        measureContext(nextAi, nextSystem, nextMessages, nextTools).tokens,
      )
      expect(current.estimated).toBe(true)
    },
  )

  it('does not invalidate a baseline when only archive metadata changes', () => {
    const baseline = createContextBaseline(measureContext(ai, system, messages, tools), {
      input_tokens: 500,
      output_tokens: 0,
      total_tokens: 500,
    })!
    const copied = new HumanMessage({
      id: 'archived-id',
      content: messages[0].content,
      additional_kwargs: { jobtrailParts: [] },
    })
    expect(measureContext(ai, system, [copied], tools, baseline)).toMatchObject({
      tokens: 500,
      estimated: false,
    })
  })

  it('falls back to local counts when input usage is missing or invalid', () => {
    const context = measureContext(ai, system, messages, tools)
    expect(createContextBaseline(context)).toBeNull()
    for (const input_tokens of [NaN, Infinity, -1, 1.5])
      expect(
        createContextBaseline(context, { input_tokens, output_tokens: 0, total_tokens: 0 }),
      ).toBeNull()
    expect(context.estimated).toBe(true)
    expect(context.tokens).toBeGreaterThan(0)
  })

  it('preserves calibration across compaction when the fallback tokenizer overcounts', () => {
    const long = [new HumanMessage('旧消息内容 '.repeat(500)), ...messages]
    const initial = measureContext(ai, system, long, tools)
    const actual = createContextBaseline(initial, {
      input_tokens: 500,
      output_tokens: 10,
      total_tokens: 510,
    })!
    const before = measureContext(ai, system, long, tools, actual)
    const summary = new SystemMessage('此前内容的摘要 '.repeat(50))
    const localAfter = measureContext(ai, summary, messages, tools)
    expect(localAfter.tokens).toBeGreaterThan(before.tokens)
    const projected = createCompactedContextBaseline(before, localAfter)
    const after = measureContext(ai, summary, messages, tools, projected)
    expect(after.tokens).toBeLessThan(before.tokens)
    expect(after.estimated).toBe(true)
    expect(
      measureContext(ai, summary, messages, tools, JSON.parse(JSON.stringify(projected))),
    ).toEqual(after)
    const next = createContextBaseline(after, {
      input_tokens: 400,
      output_tokens: 10,
      total_tokens: 410,
    })!
    expect(measureContext(ai, summary, messages, tools, next)).toMatchObject({
      tokens: 400,
      estimated: false,
    })
    expect(
      measureContext({ ...ai, modelId: 'gpt-4o' }, summary, messages, tools, projected).tokens,
    ).toBe(measureContext({ ...ai, modelId: 'gpt-4o' }, summary, messages, tools).tokens)
  })

  it.each([8, 32, 256, 2048])('reserves response space within a %sk window', (contextWindowK) => {
    const budget = contextBudget({ contextWindowK, compactThresholdPercent: 90 })
    expect(budget.inputTokens + budget.outputTokens).toBe(contextWindowK * 1000)
    expect(budget.outputTokens).toBeGreaterThan(0)
    expect(budget.outputTokens).toBeLessThanOrEqual(8192)
    expect(budget.compactTokens).toBeLessThanOrEqual(budget.inputTokens)
  })
})
