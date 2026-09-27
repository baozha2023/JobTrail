import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const COMPANY_CATALOG_FILE_NAME = 'jobtrail-company-catalog.json'
export const COMPANY_CATALOG_MANIFEST_FILE_NAME = 'jobtrail-company-catalog.manifest.json'
const MAX_CATALOG_BYTES = 2 * 1024 * 1024
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function validateReleaseCatalog(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Company catalog must be an object')
  const keys = Object.keys(value).sort()
  const expected = [
    'catalogVersion',
    'companies',
    'industries',
    'formatVersion',
    'minimumAppVersion',
  ].sort()
  if (JSON.stringify(keys) !== JSON.stringify(expected))
    throw new Error('Company catalog has invalid root fields')
  if (
    value.formatVersion !== 1 ||
    !Number.isSafeInteger(value.catalogVersion) ||
    value.catalogVersion < 1
  )
    throw new Error('Company catalog version is invalid')
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value.minimumAppVersion))
    throw new Error('Company catalog minimum app version is invalid')
  if (
    !Array.isArray(value.companies) ||
    value.companies.length === 0 ||
    value.companies.length > 10_000
  )
    throw new Error('Company catalog must contain companies')
  if (
    !Array.isArray(value.industries) ||
    !value.industries.length ||
    value.industries.length > 1_000
  )
    throw new Error('Invalid industry dictionary')
  const industryMap = new Map()
  const codes = new Set()
  const siblingNames = new Set()
  for (const industry of value.industries) {
    if (
      !industry ||
      JSON.stringify(Object.keys(industry).sort()) !==
        JSON.stringify(['builtinKey', 'code', 'name', 'parentKey']) ||
      !UUID_V4.test(industry.builtinKey) ||
      industryMap.has(industry.builtinKey) ||
      (industry.parentKey !== null && !UUID_V4.test(industry.parentKey)) ||
      typeof industry.code !== 'string' ||
      !/^(?:[A-T]|[0-9]{2})$/.test(industry.code) ||
      codes.has(industry.code) ||
      typeof industry.name !== 'string' ||
      !industry.name.length ||
      industry.name.length > 200 ||
      industry.name !== industry.name.trim()
    )
      throw new Error('Invalid industry dictionary entry')
    const siblingName = JSON.stringify([industry.parentKey, industry.name])
    if (siblingNames.has(siblingName)) throw new Error('Duplicate industry name')
    siblingNames.add(siblingName)
    codes.add(industry.code)
    industryMap.set(industry.builtinKey, industry)
  }
  for (const industry of value.industries) {
    if (
      industry.parentKey === null
        ? !/^[A-T]$/.test(industry.code)
        : !industryMap.has(industry.parentKey) ||
          industryMap.get(industry.parentKey).parentKey !== null ||
          !/^[0-9]{2}$/.test(industry.code)
    )
      throw new Error('Invalid industry parent')
  }
  const builtinKeys = new Set()
  const names = new Set()
  for (const company of value.companies) {
    if (!company || typeof company !== 'object' || Array.isArray(company))
      throw new Error('Company catalog entry must be an object')
    const companyKeys = Object.keys(company).sort()
    const expectedCompanyKeys = [
      'aliases',
      'builtinKey',
      'careerUrl',
      'industryKeys',
      'name',
    ].sort()
    if (JSON.stringify(companyKeys) !== JSON.stringify(expectedCompanyKeys))
      throw new Error('Company catalog entry has invalid fields')
    if (!UUID_V4.test(company.builtinKey) || builtinKeys.has(company.builtinKey))
      throw new Error('Company catalog contains an invalid or duplicate key')
    if (
      typeof company.name !== 'string' ||
      company.name.length === 0 ||
      company.name.length > 200 ||
      company.name !== company.name.trim() ||
      names.has(company.name)
    )
      throw new Error('Company catalog contains an invalid or duplicate name')
    if (
      !Array.isArray(company.industryKeys) ||
      company.industryKeys.length === 0 ||
      company.industryKeys.length > 1_000 ||
      new Set(company.industryKeys).size !== company.industryKeys.length ||
      company.industryKeys.some(
        (key) => !industryMap.has(key) || industryMap.get(key).parentKey === null,
      )
    )
      throw new Error('Company catalog contains invalid industries')
    if (company.careerUrl !== null) {
      if (typeof company.careerUrl !== 'string' || company.careerUrl.length > 2048)
        throw new Error('Company catalog contains an invalid career URL')
      let url
      try {
        url = new URL(company.careerUrl)
      } catch {
        throw new Error('Company catalog contains an invalid career URL')
      }
      if (!['http:', 'https:'].includes(url.protocol))
        throw new Error('Company catalog contains an invalid career URL')
    }
    if (
      !Array.isArray(company.aliases) ||
      company.aliases.length > 100 ||
      new Set(company.aliases).size !== company.aliases.length ||
      company.aliases.some(
        (alias) =>
          typeof alias !== 'string' ||
          alias.length === 0 ||
          alias.length > 200 ||
          alias !== alias.trim() ||
          alias === company.name,
      )
    )
      throw new Error('Company catalog contains invalid aliases')
    builtinKeys.add(company.builtinKey)
    names.add(company.name)
  }
}

export function buildCompanyCatalogAssets(root, output) {
  const source = path.join(root, 'resource', COMPANY_CATALOG_FILE_NAME)
  const bytes = fs.readFileSync(source)
  if (bytes.length > MAX_CATALOG_BYTES) throw new Error('Company catalog exceeds the size limit')
  let catalog
  try {
    catalog = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new Error('Company catalog is not valid JSON')
  }
  validateReleaseCatalog(catalog)
  fs.mkdirSync(output, { recursive: true })
  const asset = path.join(output, COMPANY_CATALOG_FILE_NAME)
  fs.copyFileSync(source, asset)
  const manifest = {
    fileName: COMPANY_CATALOG_FILE_NAME,
    size: bytes.length,
    sha256: sha256(bytes),
  }
  const manifestFile = path.join(output, COMPANY_CATALOG_MANIFEST_FILE_NAME)
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)

  const published = fs.readFileSync(asset)
  const publishedManifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  if (!published.equals(bytes)) throw new Error('Published company catalog differs from source')
  if (publishedManifest.size !== published.length || publishedManifest.sha256 !== sha256(published))
    throw new Error('Published company catalog manifest is invalid')
  return manifest
}
