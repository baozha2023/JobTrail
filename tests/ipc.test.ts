import { describe, expect, it } from 'vitest'
import { parseCalendarRange, parseCompany, parseUrl } from '../src/main/ipc/validators'
import { AppServiceError, errorShape } from '../src/main/services/errors'

describe('typed IPC validation', () => {
  it('rejects malformed DTO values instead of coercing them', () => {
    expect(() => parseCalendarRange({ startAt: '0', endAt: 1 })).toThrowError(AppServiceError)
    expect(() => parseCompany({ name: '公司', aliases: ['有效', 1] }, false)).toThrowError(AppServiceError)
    expect(() => parseCompany({ name: '公司', industryIds: [1, '2'] }, false)).toThrowError(AppServiceError)
    expect(() => parseCompany({ name: '公司', industryId: 1 }, false)).toThrowError(AppServiceError)
    expect(() => parseUrl('file:///tmp/private')).toThrowError(AppServiceError)
    expect(() => parseUrl('not a url')).toThrowError(AppServiceError)
  })

  it('accepts company industry IDs as an array', () => {
    expect(parseCompany({ name: '公司', industryIds: [1, 2] }, false)).toEqual({ name: '公司', industryIds: [1, 2] })
  })

  it('returns structured application errors', () => {
    const shape = errorShape(new AppServiceError('NOT_FOUND', '记录不存在', { id: 7 }))
    expect(shape).toEqual({ code: 'NOT_FOUND', message: '记录不存在', details: { id: 7 } })
  })
})
