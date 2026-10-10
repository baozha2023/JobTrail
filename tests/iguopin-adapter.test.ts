import { expect, it, vi } from 'vitest'
import { IguopinSearch, iguopinResponse } from '../src/main/discovery/adapters/iguopin'
import type { SearchTransport } from '../src/main/discovery/adapter'

const response = (list: unknown, total: unknown = 0) => ({
  code: 200,
  data: { page: 1, page_size: 20, total, list },
})

it.each([
  ['北京', ['全北京']],
  ['成都', ['成都', '全成都']],
  ['三沙', ['三沙', '全三沙']],
])('submits the whole city after drilling into the official %s picker', async (city, leaves) => {
  const click = vi.fn<SearchTransport['click']>(async () => {})
  const transport: SearchTransport = {
    click,
    fill: vi.fn(),
    load: vi.fn(),
    guard: vi.fn(),
    enter: vi.fn(),
    evaluate: vi.fn(),
    until: vi.fn().mockResolvedValue('all'),
    async response(reader, action) {
      await action()
      return reader.response(response([], 0))
    },
  }
  await new IguopinSearch(transport, { keyword: '销售', city }).read(new AbortController().signal)
  expect(
    click.mock.calls
      .filter(([selector]) => selector === '.ant-modal .flat-right .leaf-item')
      .map(([, label]) => label),
  ).toEqual(leaves)
})

it('accepts the official null list only when the response confirms zero results', () => {
  for (const list of [null, []]) {
    expect(iguopinResponse(response(list), 1)).toMatchObject({
      jobs: [],
      rawCount: 0,
      hasMore: false,
      page: 1,
    })
  }
})

it('does not turn missing, malformed or nonempty responses into successful empty results', () => {
  for (const value of [
    response(undefined),
    response({}),
    response(''),
    response(null, 20),
    response(null, '0'),
    { code: 401, data: { page: 1, page_size: 20, total: 0, list: null } },
    { code: 403, data: { page: 1, page_size: 20, total: 0, list: null } },
  ]) {
    expect(() => iguopinResponse(value, 1)).toThrow()
  }
  expect(() => iguopinResponse(response(null), 2)).toThrow()
})
