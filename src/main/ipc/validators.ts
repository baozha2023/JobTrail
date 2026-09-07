import type {
  AppConfig,
  CalendarRange,
  CreateCalendarEventInput,
  CreateCompanyInput,
  CreateIndustryInput,
  CreateOpportunityInput,
  CreateStatusInput,
  OpportunityQuery,
  UpdateCalendarEventInput,
  UpdateCompanyInput,
  UpdateIndustryInput,
  UpdateOpportunityInput,
  UpdateResumeVersionInput,
  UpdateStatusInput,
} from '../../shared/types'
import { AppServiceError, assertNonEmptyUpdate } from '../services/errors'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertOnlyKeys(
  source: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  const unknownKey = Object.keys(source).find((key) => !allowed.includes(key))
  if (unknownKey)
    throw new AppServiceError('VALIDATION_ERROR', `${field}包含未知字段：${unknownKey}`)
}

export function record(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new AppServiceError('VALIDATION_ERROR', `${field}格式无效`)
  return value
}

export function stringValue(value: unknown, field: string): string
export function stringValue(value: unknown, field: string, required: true): string
export function stringValue(value: unknown, field: string, required: false): string | undefined
export function stringValue(value: unknown, field: string, required: boolean): string | undefined
export function stringValue(value: unknown, field: string, required = true): string | undefined {
  if (value === undefined && !required) return undefined
  if (typeof value !== 'string' || (required && value.trim() === ''))
    throw new AppServiceError('VALIDATION_ERROR', `${field}格式无效`)
  return value
}

export function nullableString(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined
  if (value !== null && typeof value !== 'string')
    throw new AppServiceError('VALIDATION_ERROR', `${field}格式无效`)
  return value
}

export function numberValue(value: unknown, field: string): number
export function numberValue(value: unknown, field: string, required: true): number
export function numberValue(value: unknown, field: string, required: false): number | undefined
export function numberValue(value: unknown, field: string, required: boolean): number | undefined
export function numberValue(value: unknown, field: string, required = true): number | undefined {
  if (value === undefined && !required) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new AppServiceError('VALIDATION_ERROR', `${field}格式无效`)
  return value
}

export function nullableInteger(value: unknown, field: string): number | null | undefined {
  if (value === undefined) return undefined
  if (value !== null && (typeof value !== 'number' || !Number.isSafeInteger(value)))
    throw new AppServiceError('VALIDATION_ERROR', `${field}格式无效`)
  return value
}

export function booleanValue(value: unknown, field: string): boolean
export function booleanValue(value: unknown, field: string, required: true): boolean
export function booleanValue(value: unknown, field: string, required: false): boolean | undefined
export function booleanValue(value: unknown, field: string, required: boolean): boolean | undefined
export function booleanValue(value: unknown, field: string, required = true): boolean | undefined {
  if (value === undefined && !required) return undefined
  if (typeof value !== 'boolean') throw new AppServiceError('VALIDATION_ERROR', `${field}格式无效`)
  return value
}

export function ids(value: unknown, field: string): number[] {
  if (!Array.isArray(value)) throw new AppServiceError('VALIDATION_ERROR', `${field}格式无效`)
  return value.map((item) => numberValue(item, field))
}

function aliases(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
    throw new AppServiceError('VALIDATION_ERROR', '公司别名格式无效')
  return value as string[]
}

export function parseStatus(value: unknown, partial: false): CreateStatusInput
export function parseStatus(value: unknown, partial: true): UpdateStatusInput
export function parseStatus(value: unknown, partial: boolean): CreateStatusInput | UpdateStatusInput
export function parseStatus(
  value: unknown,
  partial: boolean,
): CreateStatusInput | UpdateStatusInput {
  const source = record(value, '状态')
  assertOnlyKeys(source, ['label'], '状态')
  const label = stringValue(source.label, '状态名称', !partial)
  const input: UpdateStatusInput = label === undefined ? {} : { label }
  if (partial) assertNonEmptyUpdate(input, '状态')
  return input
}

export function parseIndustry(value: unknown, partial: false): CreateIndustryInput
export function parseIndustry(value: unknown, partial: true): UpdateIndustryInput
export function parseIndustry(
  value: unknown,
  partial: boolean,
): CreateIndustryInput | UpdateIndustryInput
export function parseIndustry(
  value: unknown,
  partial: boolean,
): CreateIndustryInput | UpdateIndustryInput {
  const source = record(value, '行业分类')
  assertOnlyKeys(source, ['name'], '行业分类')
  const name = stringValue(source.name, '行业分类名称', !partial)
  const input: UpdateIndustryInput = name === undefined ? {} : { name }
  if (partial) assertNonEmptyUpdate(input, '行业分类')
  return input
}

export function parseCompany(value: unknown, partial: false): CreateCompanyInput
export function parseCompany(value: unknown, partial: true): UpdateCompanyInput
export function parseCompany(
  value: unknown,
  partial: boolean,
): CreateCompanyInput | UpdateCompanyInput
export function parseCompany(
  value: unknown,
  partial: boolean,
): CreateCompanyInput | UpdateCompanyInput {
  const source = record(value, '公司')
  assertOnlyKeys(source, ['name', 'industryIds', 'careerUrl', 'aliases', 'isFavorite'], '公司')
  const name = stringValue(source.name, '公司名称', !partial)
  const industryIds =
    source.industryIds === undefined ? undefined : ids(source.industryIds, '行业分类 ID')
  const careerUrl = nullableString(source.careerUrl, '招聘官网')
  const companyAliases = aliases(source.aliases)
  const input: UpdateCompanyInput = {
    ...(name === undefined ? {} : { name }),
    ...(industryIds === undefined ? {} : { industryIds }),
    ...(careerUrl === undefined ? {} : { careerUrl }),
    ...(companyAliases === undefined ? {} : { aliases: companyAliases }),
  }
  const favorite = booleanValue(source.isFavorite, '收藏状态', false)
  if (favorite !== undefined) input.isFavorite = favorite
  if (partial) assertNonEmptyUpdate(input, '公司')
  return input
}

export function parseOpportunity(value: unknown, partial: false): CreateOpportunityInput
export function parseOpportunity(value: unknown, partial: true): UpdateOpportunityInput
export function parseOpportunity(
  value: unknown,
  partial: boolean,
): CreateOpportunityInput | UpdateOpportunityInput
export function parseOpportunity(
  value: unknown,
  partial: boolean,
): CreateOpportunityInput | UpdateOpportunityInput {
  const source = record(value, '求职记录')
  assertOnlyKeys(
    source,
    [
      'companyId',
      'title',
      'department',
      'location',
      'source',
      'jobUrl',
      'description',
      'statusId',
      'resumeVersionId',
      'discoveredAt',
      'appliedAt',
      'deadlineAt',
      'notes',
    ],
    '求职记录',
  )
  const companyId = numberValue(source.companyId, '公司 ID', !partial)
  const title = stringValue(source.title, '岗位名称', !partial)
  const statusId = numberValue(source.statusId, '状态 ID', !partial)
  const input: UpdateOpportunityInput = {
    ...(companyId === undefined ? {} : { companyId }),
    ...(title === undefined ? {} : { title }),
    ...(statusId === undefined ? {} : { statusId }),
  }
  for (const [key, label] of [
    ['department', '部门'],
    ['location', '地点'],
    ['source', '来源'],
    ['jobUrl', '岗位链接'],
    ['description', 'JD 内容'],
    ['notes', '备注'],
  ] as const) {
    const valueForField = nullableString(source[key], label)
    if (valueForField !== undefined) input[key] = valueForField
  }
  for (const [key, label] of [
    ['resumeVersionId', '简历版本 ID'],
    ['discoveredAt', '发现时间'],
    ['appliedAt', '投递时间'],
    ['deadlineAt', '截止时间'],
  ] as const) {
    const valueForField = nullableInteger(source[key], label)
    if (valueForField !== undefined) input[key] = valueForField
  }
  if (partial) assertNonEmptyUpdate(input, '求职记录')
  return input
}

export function parseCalendarEvent(value: unknown, partial: false): CreateCalendarEventInput
export function parseCalendarEvent(value: unknown, partial: true): UpdateCalendarEventInput
export function parseCalendarEvent(
  value: unknown,
  partial: boolean,
): CreateCalendarEventInput | UpdateCalendarEventInput
export function parseCalendarEvent(
  value: unknown,
  partial: boolean,
): CreateCalendarEventInput | UpdateCalendarEventInput {
  const source = record(value, '日程')
  assertOnlyKeys(
    source,
    [
      'opportunityId',
      'title',
      'eventType',
      'startAt',
      'endAt',
      'isAllDay',
      'timezone',
      'location',
      'description',
      'reminderMinutes',
    ],
    '日程',
  )
  const title = stringValue(source.title, '日程标题', !partial)
  const eventType = stringValue(source.eventType, '日程类型', !partial)
  const startAt = numberValue(source.startAt, '开始时间', !partial)
  const endAt = numberValue(source.endAt, '结束时间', !partial)
  const input: UpdateCalendarEventInput = {
    ...(title === undefined ? {} : { title }),
    ...(eventType === undefined ? {} : { eventType }),
    ...(startAt === undefined ? {} : { startAt }),
    ...(endAt === undefined ? {} : { endAt }),
  }
  const opportunityId = nullableInteger(source.opportunityId, '求职记录 ID')
  const reminderMinutes = nullableInteger(source.reminderMinutes, '提醒分钟数')
  if (opportunityId !== undefined) input.opportunityId = opportunityId
  if (reminderMinutes !== undefined) input.reminderMinutes = reminderMinutes
  const isAllDay = booleanValue(source.isAllDay, '全天状态', false)
  if (isAllDay !== undefined) input.isAllDay = isAllDay
  const timezone = stringValue(source.timezone, '时区', false)
  if (timezone !== undefined) input.timezone = timezone
  for (const [key, label] of [
    ['location', '地点或会议链接'],
    ['description', '说明'],
  ] as const) {
    const valueForField = nullableString(source[key], label)
    if (valueForField !== undefined) input[key] = valueForField
  }
  if (partial) assertNonEmptyUpdate(input, '日程')
  return input
}

export function parseOpportunityQuery(value: unknown): OpportunityQuery {
  const source = record(value, '求职查询')
  assertOnlyKeys(source, ['search', 'statusId', 'companyId'], '求职查询')
  const query: OpportunityQuery = {}
  const search = stringValue(source.search, '搜索关键词', false)
  const statusId = nullableInteger(source.statusId, '状态 ID')
  const companyId = nullableInteger(source.companyId, '公司 ID')
  if (search !== undefined) query.search = search
  if (statusId !== undefined) query.statusId = statusId
  if (companyId !== undefined) query.companyId = companyId
  return query
}

export function parseResumeUpdate(value: unknown): UpdateResumeVersionInput {
  const source = record(value, '简历版本')
  assertOnlyKeys(source, ['name', 'note'], '简历版本')
  const name = stringValue(source.name, '简历版本名称', false)
  const note = nullableString(source.note, '备注')
  const input: UpdateResumeVersionInput = {
    ...(name === undefined ? {} : { name }),
    ...(note === undefined ? {} : { note }),
  }
  assertNonEmptyUpdate(input, '简历版本')
  return input
}

export function parseCalendarRange(value: unknown): CalendarRange {
  const source = record(value, '日历范围')
  assertOnlyKeys(source, ['startAt', 'endAt'], '日历范围')
  return {
    startAt: numberValue(source.startAt, '日历开始时间'),
    endAt: numberValue(source.endAt, '日历结束时间'),
  }
}

export function parseUrl(value: unknown): string {
  const url = stringValue(value, '链接')
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new AppServiceError('VALIDATION_ERROR', '链接格式无效')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
    throw new AppServiceError('VALIDATION_ERROR', '仅允许打开 HTTP(S) 链接')
  return parsed.toString()
}

export type ConfigUpdate = Partial<AppConfig>
