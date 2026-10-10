import { describe, expect, it } from 'vitest'
import { rankRelevance } from '../src/main/discovery/relevance'

const document = (id: string, title: string, company = '', jd = '') => ({ id, title, company, jd })
const scores = (keyword: string, documents: ReturnType<typeof document>[]) =>
  Object.fromEntries(rankRelevance(keyword, documents).map(({ id, score }) => [id, score]))

describe('general-purpose discovery relevance', () => {
  it.each(['产品经理', '财务分析', '物流运营', '平面设计', 'Quality Engineer'])(
    'prioritizes complete titles and ordered phrases for %s',
    (keyword) => {
      const result = scores(keyword, [
        document('exact', keyword),
        document('phrase', `高级 ${keyword}`),
        document('company', '助理', `${keyword}公司`),
        document('description', '助理', '', `负责 ${keyword}`),
        document('unrelated', '保安'),
      ])
      expect(result.exact).toBeGreaterThan(result.phrase)
      expect(result.phrase).toBeGreaterThan(result.company)
      expect(result.phrase).toBeGreaterThan(result.description)
      expect(result.company).toBeGreaterThan(0)
      expect(result.description).toBeGreaterThan(0)
      expect(result.unrelated).toBe(0)
    },
  )

  it('learns distinctive terms from the result set instead of a role dictionary', () => {
    const result = scores('设计 工程师', [
      document('complete', '设计工程师'),
      document('distinctive', '设计顾问'),
      ...Array.from({ length: 12 }, (_, index) => document(`common${index}`, '质量工程师')),
    ])
    expect(result.complete).toBeGreaterThan(result.distinctive)
    expect(result.distinctive).toBeGreaterThan(result.common0)
  })

  it('rewards multi-word coverage and phrase order across different roles', () => {
    const result = scores('Senior Product Designer', [
      document('ordered', 'Senior Product Designer'),
      document('reversed', 'Designer Product Senior'),
      document('partial', 'Product Designer'),
      document('one', 'Designer'),
    ])
    expect(result.ordered).toBeGreaterThan(result.reversed)
    expect(result.reversed).toBeGreaterThan(result.partial)
    expect(result.partial).toBeGreaterThan(result.one)
  })

  it.each([
    ['Sales', 'Salesforce'],
    ['Art', 'Artist'],
    ['R', 'HR'],
    ['Java', 'JavaScript'],
    ['C', 'C++'],
    ['C#', 'C'],
    ['.NET', 'Internet'],
  ])('keeps lexical boundaries between %s and %s', (keyword, other) => {
    const result = scores(keyword, [document('match', `${keyword} 专员`), document('other', other)])
    expect(result.match).toBeGreaterThan(0)
    expect(result.other).toBe(0)
  })

  it('handles Chinese compounds without requiring spaces in the search', () => {
    const documents = [
      document('complete', '供应链管理'),
      document('partial', '供应链运营'),
      document('unrelated', '财务会计'),
    ]
    const joined = scores('供应链管理', documents)
    const spaced = scores('供应链 管理', documents)
    expect(joined.complete).toBeGreaterThan(joined.partial)
    expect(spaced.complete).toBeGreaterThan(spaced.partial)
    expect(joined.partial).toBeGreaterThan(0)
    expect(joined.unrelated).toBe(0)
  })

  it('recovers Chinese words inside compounds when generic segmentation chooses a longer word', () => {
    const result = scores('行政', [
      document('exact', '行政'),
      document('compound', '行政管理'),
      document('unrelated', '财务会计'),
    ])
    expect(result.exact).toBeGreaterThan(result.compound)
    expect(result.compound).toBeGreaterThan(0)
    expect(result.unrelated).toBe(0)
  })

  it('uses company names and descriptions to resolve additional query intent', () => {
    const companies = scores('星海 设计', [
      document('complete', '设计专员', '星海'),
      document('titleOnly', '设计专员', '其他公司'),
    ])
    expect(companies.complete).toBeGreaterThan(companies.titleOnly)
    const descriptions = scores('直播 运营', [
      document('complete', '运营专员', '', '负责直播活动'),
      document('titleOnly', '运营专员', '', '负责仓库管理'),
    ])
    expect(descriptions.complete).toBeGreaterThan(descriptions.titleOnly)
  })

  it('normalizes case, width, separators and repeated query terms', () => {
    const documents = [document('exact', 'SALES MANAGER'), document('partial', 'Sales')]
    expect(scores('ｓａｌｅｓ　ｍａｎａｇｅｒ', documents)).toEqual(
      scores('sales manager', documents),
    )
    expect(scores(' sales, manager / sales ', documents)).toEqual(
      scores('sales manager', documents),
    )
  })

  it('saturates repeated words and normalizes verbose descriptions', () => {
    const result = scores('Accounting', [
      document('title', 'Accounting'),
      document('focused', '助理', '', 'Accounting'),
      document('stuffed', '助理', '', 'Accounting '.repeat(1000)),
    ])
    expect(result.title).toBeGreaterThan(result.focused)
    expect(result.focused).toBeGreaterThan(result.stuffed)
  })

  it('does not reward reading an unrelated description or manufacture matches from missing fields', () => {
    const result = scores('采购', [
      document('unread', '采购经理'),
      document('read', '采购经理', '', '制定计划，协调内部团队'),
      document('missing', ''),
    ])
    expect(result.unread).toBe(result.read)
    expect(result.missing).toBe(0)
  })

  it.each(['', '   ', '！ / --'])('keeps empty/non-word query %j scores at zero', (keyword) => {
    expect(scores(keyword, [document('job', '招聘专员')])).toEqual({ job: 0 })
  })

  it('produces deterministic nonnegative integer scores independent of input order', () => {
    const documents = [document('a', '数据分析'), document('b', '数据统计'), document('c', '')]
    const result = scores('数据 分析', documents)
    expect(result).toEqual(scores('数据 分析', [...documents].reverse()))
    for (const score of Object.values(result)) {
      expect(Number.isSafeInteger(score)).toBe(true)
      expect(score).toBeGreaterThanOrEqual(0)
    }
  })
})
