import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  buildCompanyCatalogAssets,
  COMPANY_CATALOG_FILE_NAME,
  COMPANY_CATALOG_MANIFEST_FILE_NAME,
} from './company-catalog-assets.mjs'

test('copies the full catalog byte-for-byte and emits a verifiable manifest', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrail-catalog-assets-'))
  const output = path.join(root, 'dist')
  fs.mkdirSync(path.join(root, 'resource'))
  const source = Buffer.from(
    JSON.stringify({
      formatVersion: 2,
      catalogVersion: 4,
      minimumAppVersion: '1.5.0',
      industries: [
        {
          builtinKey: '00000000-0000-4000-8000-000000000001',
          parentKey: null,
          code: 'A',
          name: '一级',
        },
        {
          builtinKey: '00000000-0000-4000-8000-000000000002',
          parentKey: '00000000-0000-4000-8000-000000000001',
          code: '01',
          name: '二级',
        },
      ],
      companies: [
        {
          builtinKey: '3ee1b335-f3be-47ed-982c-8ab740d65f46',
          name: '测试公司',
          industryKeys: ['00000000-0000-4000-8000-000000000002'],
          careerUrl: 'https://example.com/careers',
          aliases: ['Test Company'],
          locations: ['上海', 'New York'],
        },
      ],
    }),
  )
  fs.writeFileSync(path.join(root, 'resource', COMPANY_CATALOG_FILE_NAME), source)
  try {
    const manifest = buildCompanyCatalogAssets(root, output)
    assert.deepEqual(fs.readFileSync(path.join(output, COMPANY_CATALOG_FILE_NAME)), source)
    assert.equal(manifest.size, source.length)
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(output, COMPANY_CATALOG_MANIFEST_FILE_NAME), 'utf8')),
      manifest,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('rejects missing or malformed catalog sources', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrail-catalog-assets-invalid-'))
  const output = path.join(root, 'dist')
  fs.mkdirSync(path.join(root, 'resource'))
  try {
    assert.throws(() => buildCompanyCatalogAssets(root, output), /ENOENT/)
    fs.writeFileSync(path.join(root, 'resource', COMPANY_CATALOG_FILE_NAME), '{}')
    assert.throws(() => buildCompanyCatalogAssets(root, output), /invalid root fields/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('rejects invalid location dictionaries in release assets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrail-catalog-locations-'))
  fs.mkdirSync(path.join(root, 'resource'))
  const original = JSON.parse(
    fs.readFileSync(new URL('../resource/jobtrail-company-catalog.json', import.meta.url), 'utf8'),
  )
  try {
    for (const locations of [
      undefined,
      null,
      [' '],
      [' 上海'],
      ['上海', '上海'],
      [1],
      ['x'.repeat(201)],
      Array(101).fill('上海'),
    ]) {
      const source = structuredClone(original)
      source.companies[0].locations = locations
      fs.writeFileSync(
        path.join(root, 'resource', COMPANY_CATALOG_FILE_NAME),
        JSON.stringify(source),
      )
      assert.throws(() => buildCompanyCatalogAssets(root, path.join(root, 'dist')))
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
