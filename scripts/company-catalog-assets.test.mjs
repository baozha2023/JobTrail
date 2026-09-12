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
      formatVersion: 1,
      catalogVersion: 2,
      minimumAppVersion: '0.4.0',
      companies: [
        {
          builtinKey: '3ee1b335-f3be-47ed-982c-8ab740d65f46',
          name: '测试公司',
          industryIds: [1],
          careerUrl: 'https://example.com/careers',
          aliases: ['Test Company'],
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
