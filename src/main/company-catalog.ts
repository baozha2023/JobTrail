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
  industryIds: z.array(z.number().int().min(1).max(83)).min(1).max(83),
  careerUrl: z.string().max(2048).nullable(),
  aliases: z.array(normalizedText(200)).max(100),
})

const catalogSchema = z.strictObject({
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

function invalidCatalog(): AppServiceError {
  return new AppServiceError('CATALOG_INVALID', '获取的内置公司数据有误，请稍后重试')
}

export function parseCompanyCatalog(value: unknown): CompanyCatalogDocument {
  const parsed = catalogSchema.safeParse(value)
  if (!parsed.success) throw invalidCatalog()

  const keys = new Set<string>()
  const names = new Set<string>()
  for (const company of parsed.data.companies) {
    if (keys.has(company.builtinKey)) throw invalidCatalog()
    if (names.has(company.name)) throw invalidCatalog()
    keys.add(company.builtinKey)
    names.add(company.name)
    if (new Set(company.industryIds).size !== company.industryIds.length) throw invalidCatalog()
    if (new Set(company.aliases).size !== company.aliases.length) throw invalidCatalog()
    if (company.aliases.includes(company.name)) throw invalidCatalog()
    if (company.careerUrl !== null) {
      let url: URL
      try {
        url = new URL(company.careerUrl)
      } catch {
        throw invalidCatalog()
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw invalidCatalog()
    }
  }
  return parsed.data
}

export function parseCompanyCatalogText(value: string): CompanyCatalogDocument {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw invalidCatalog()
  }
  return parseCompanyCatalog(parsed)
}

export function parseCompanyCatalogManifest(value: string): CompanyCatalogManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw invalidCatalog()
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
    return [Number(match[1]), Number(match[2]), Number(match[3])]
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
