import { createHash } from 'node:crypto'
import { z } from 'zod'
import bundledCatalogText from '../../resource/jobtrail-company-catalog.json?raw'
import { AppServiceError } from './services/errors'

export const COMPANY_CATALOG_FORMAT_VERSION = 1
export const MAX_COMPANY_CATALOG_BYTES = 2 * 1024 * 1024
export const COMPANY_CATALOG_ASSET_NAME = 'jobtrail-company-catalog.json'
export const COMPANY_CATALOG_MANIFEST_ASSET_NAME = 'jobtrail-company-catalog.manifest.json'
export const COMPANY_CATALOG_ASSET_URL = `https://github.com/baozha2023/JobTrail/releases/latest/download/${COMPANY_CATALOG_ASSET_NAME}`
export const COMPANY_CATALOG_MANIFEST_URL = `https://github.com/baozha2023/JobTrail/releases/latest/download/${COMPANY_CATALOG_MANIFEST_ASSET_NAME}`
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const normalizedText = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => value === value.trim())

const catalogEntrySchema = z.strictObject({
  builtinKey: z.string().regex(UUID_V4),
  name: normalizedText(200),
  industryKeys: z.array(z.string().regex(UUID_V4)).min(1).max(1_000),
  careerUrl: z.string().max(2048).nullable(),
  aliases: z.array(normalizedText(200)).max(100),
})

const catalogIndustrySchema = z.strictObject({
  builtinKey: z.string().regex(UUID_V4),
  parentKey: z.string().regex(UUID_V4).nullable(),
  code: z.string().regex(/^(?:[A-T]|[0-9]{2})$/),
  name: normalizedText(200),
})

const catalogSchema = z.strictObject({
  industries: z.array(catalogIndustrySchema).min(1).max(1_000),
  formatVersion: z.literal(COMPANY_CATALOG_FORMAT_VERSION),
  catalogVersion: z.number().int().positive(),
  minimumAppVersion: z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/),
  companies: z.array(catalogEntrySchema).min(1).max(10_000),
})

const manifestSchema = z.strictObject({
  fileName: z.literal(COMPANY_CATALOG_ASSET_NAME),
  size: z.number().int().positive().max(MAX_COMPANY_CATALOG_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
})

export type CompanyCatalogEntry = z.infer<typeof catalogEntrySchema>
export type CompanyCatalogDocument = z.infer<typeof catalogSchema>
export type CompanyCatalogManifest = z.infer<typeof manifestSchema>

function invalidCatalog(cause?: unknown): AppServiceError {
  return new AppServiceError('CATALOG_INVALID', '获取的内置公司数据有误，请稍后重试', undefined, {
    cause,
  })
}

export function parseCompanyCatalog(value: unknown): CompanyCatalogDocument {
  const parsed = catalogSchema.safeParse(value)
  if (!parsed.success) throw invalidCatalog()

  const industryKeys = new Map(parsed.data.industries.map((item) => [item.builtinKey, item]))
  const codes = new Set(parsed.data.industries.map((item) => item.code))
  if (industryKeys.size !== parsed.data.industries.length || codes.size !== industryKeys.size)
    throw invalidCatalog()
  const siblingNames = new Set<string>()
  for (const industry of parsed.data.industries) {
    const siblingName = JSON.stringify([industry.parentKey, industry.name])
    if (siblingNames.has(siblingName)) throw invalidCatalog()
    siblingNames.add(siblingName)
    if (industry.parentKey === null) {
      if (!/^[A-T]$/.test(industry.code)) throw invalidCatalog()
    } else {
      const parent = industryKeys.get(industry.parentKey)
      if (!parent || parent.parentKey !== null || !/^[0-9]{2}$/.test(industry.code))
        throw invalidCatalog()
    }
  }
  const keys = new Set<string>()
  const names = new Set<string>()
  for (const company of parsed.data.companies) {
    if (keys.has(company.builtinKey)) throw invalidCatalog()
    if (names.has(company.name)) throw invalidCatalog()
    keys.add(company.builtinKey)
    names.add(company.name)
    if (
      new Set(company.industryKeys).size !== company.industryKeys.length ||
      company.industryKeys.some(
        (key) => !industryKeys.has(key) || industryKeys.get(key)!.parentKey === null,
      )
    )
      throw invalidCatalog()
    if (new Set(company.aliases).size !== company.aliases.length) throw invalidCatalog()
    if (company.aliases.includes(company.name)) throw invalidCatalog()
    if (company.careerUrl !== null) {
      let url: URL
      try {
        url = new URL(company.careerUrl)
      } catch (error) {
        throw invalidCatalog(error)
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw invalidCatalog()
    }
  }
  return parsed.data
}

export function parseCompanyCatalogText(
  value: string,
  appVersion?: string,
): CompanyCatalogDocument {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (error) {
    throw invalidCatalog(error)
  }
  if (appVersion !== undefined && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const minimumAppVersion = (parsed as Record<string, unknown>).minimumAppVersion
    if (
      typeof minimumAppVersion === 'string' &&
      compareReleaseVersions(minimumAppVersion, appVersion) > 0
    )
      throw new AppServiceError(
        'CATALOG_APP_UPDATE_REQUIRED',
        `请先将职迹更新至 ${minimumAppVersion} 或更高版本`,
      )
  }
  return parseCompanyCatalog(parsed)
}

export function parseCompanyCatalogManifest(value: string): CompanyCatalogManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (error) {
    throw invalidCatalog(error)
  }
  const result = manifestSchema.safeParse(parsed)
  if (!result.success) throw invalidCatalog()
  return result.data
}

export function companyCatalogHash(catalog: CompanyCatalogDocument): string {
  return createHash('sha256').update(JSON.stringify(catalog)).digest('hex')
}

export function rawSha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

export function compareReleaseVersions(first: string, second: string): number {
  const parse = (value: string): [number, number, number] => {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value)
    if (!match) throw invalidCatalog()
    const parts = [Number(match[1]), Number(match[2]), Number(match[3])]
    if (parts.some((part) => !Number.isSafeInteger(part))) throw invalidCatalog()
    return parts as [number, number, number]
  }
  const left = parse(first)
  const right = parse(second)
  for (let index = 0; index < left.length; index += 1) {
    if (left[index]! > right[index]!) return 1
    if (left[index]! < right[index]!) return -1
  }
  return 0
}

export const BUNDLED_COMPANY_CATALOG = parseCompanyCatalogText(bundledCatalogText)
export const BUNDLED_COMPANY_CATALOG_HASH = rawSha256(new TextEncoder().encode(bundledCatalogText))
