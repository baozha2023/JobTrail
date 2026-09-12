import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppPaths } from '../src/main/config'
import {
  BUNDLED_COMPANY_CATALOG,
  BUNDLED_COMPANY_CATALOG_HASH,
  COMPANY_CATALOG_ASSET_NAME,
  companyCatalogHash,
  parseCompanyCatalog,
  rawSha256,
  type CompanyCatalogDocument,
} from '../src/main/company-catalog'
import { CompanyCatalogUpdater } from '../src/main/company-catalog-updater'
import { DatabaseManager } from '../src/main/database'
import { FileStorageService } from '../src/main/file-storage'
import { createServices, type Services } from '../src/main/service-container'
import { AppServiceError } from '../src/main/services/errors'
import { UnitOfWork } from '../src/main/services/unit-of-work'

function response(bytes: Uint8Array, url = 'https://release-assets.githubusercontent.com/file') {
  const value = new Response(new Uint8Array(bytes).buffer)
  Object.defineProperty(value, 'url', { value: url })
  return value
}

function streamedResponse(chunks: Uint8Array[]) {
  const value = new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      },
    }),
  )
  Object.defineProperty(value, 'url', {
    value: 'https://release-assets.githubusercontent.com/file',
  })
  return value
}

function manifest(bytes: Uint8Array): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      fileName: COMPANY_CATALOG_ASSET_NAME,
      size: bytes.byteLength,
      sha256: rawSha256(bytes),
    }),
  )
}

function nextCatalog(): CompanyCatalogDocument {
  return parseCompanyCatalog({
    ...structuredClone(BUNDLED_COMPANY_CATALOG),
    catalogVersion: BUNDLED_COMPANY_CATALOG.catalogVersion + 1,
  })
}

describe('内置公司目录更新', () => {
  let root: string
  let database: DatabaseManager
  let services: Services

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'zhiji-catalog-'))
    const paths: AppPaths = {
      root,
      config: path.join(root, 'config.json'),
      data: path.join(root, 'data'),
      database: path.join(root, 'data', 'zhiji.db'),
      resumes: path.join(root, 'resumes'),
    }
    database = new DatabaseManager(paths)
    services = createServices(
      new UnitOfWork(database.db),
      database,
      new FileStorageService(paths),
      false,
    )
  })

  afterEach(() => {
    database.close()
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('updates, adopts, and retains omitted built-ins without changing local identity or preferences', () => {
    const source = nextCatalog()
    const original = services.companies.get(1)
    services.companies.update(original.id, { isFavorite: true })
    services.companies.markRead(original.id)
    const preserved = services.companies.get(original.id)
    const omitted = services.companies.get(2)
    const custom = services.companies.create({
      name: '待收录公司',
      industryIds: [1],
      careerUrl: 'https://local.example.com',
      aliases: ['本地别名'],
    })
    const opportunity = services.opportunities.create({
      companyId: custom.id,
      title: '保留岗位',
      statusId: 1,
    })

    source.companies[0] = {
      ...source.companies[0]!,
      name: `${source.companies[0]!.name}更新`,
      careerUrl: 'https://catalog.example.com/careers',
      industryIds: [2],
      aliases: ['目录别名'],
    }
    source.companies.splice(1, 1)
    source.companies.push({
      builtinKey: '3ee1b335-f3be-47ed-982c-8ab740d65f46',
      name: custom.name,
      industryIds: [3],
      careerUrl: 'https://adopted.example.com/careers',
      aliases: ['收录别名'],
    })

    const result = services.companyCatalog.synchronize(source, companyCatalogHash(source))
    expect(result).toEqual({
      status: 'updated',
      previousVersion: BUNDLED_COMPANY_CATALOG.catalogVersion,
      currentVersion: source.catalogVersion,
      added: 0,
      updated: 1,
      adopted: 1,
      unchanged: BUNDLED_COMPANY_CATALOG.companies.length - 2,
    })
    const updated = services.companies.get(original.id)
    expect(updated).toMatchObject({
      id: original.id,
      name: source.companies[0]!.name,
      careerUrl: 'https://catalog.example.com/careers',
      industryIds: [2],
      aliases: ['目录别名'],
      isBuiltin: true,
      isFavorite: true,
      lastReadAt: preserved.lastReadAt,
      createdAt: original.createdAt,
    })
    expect(services.companies.get(omitted.id)).toMatchObject({
      id: omitted.id,
      name: omitted.name,
      isBuiltin: true,
    })
    expect(services.companies.get(custom.id)).toMatchObject({
      id: custom.id,
      careerUrl: 'https://adopted.example.com/careers',
      industryIds: [3],
      aliases: ['收录别名'],
      isBuiltin: true,
      createdAt: custom.createdAt,
    })
    expect(services.opportunities.get(opportunity.id).companyId).toBe(custom.id)
    expect(services.companyCatalog.status().catalogVersion).toBe(source.catalogVersion)
  })

  it('rolls back every catalog change when a name conflicts', () => {
    const source = nextCatalog()
    const originalUrl = services.companies.get(1).careerUrl
    const custom = services.companies.create({ name: '本地冲突公司' })
    source.companies[0] = {
      ...source.companies[0]!,
      careerUrl: 'https://should-roll-back.example.com',
    }
    source.companies[source.companies.length - 1] = {
      ...source.companies.at(-1)!,
      name: custom.name,
    }
    expect(() => services.companyCatalog.synchronize(source, companyCatalogHash(source))).toThrow(
      AppServiceError,
    )
    expect(services.companies.get(1).name).toBe(BUNDLED_COMPANY_CATALOG.companies[0]!.name)
    expect(services.companies.get(1).careerUrl).toBe(originalUrl)
    expect(services.companies.get(custom.id).isBuiltin).toBe(false)
    expect(services.companyCatalog.status().catalogVersion).toBe(
      BUNDLED_COMPANY_CATALOG.catalogVersion,
    )
  })

  it('returns up-to-date without writing when version and content hash match', () => {
    expect(
      services.companyCatalog.synchronize(BUNDLED_COMPANY_CATALOG, BUNDLED_COMPANY_CATALOG_HASH),
    ).toEqual({
      status: 'up-to-date',
      previousVersion: BUNDLED_COMPANY_CATALOG.catalogVersion,
      currentVersion: BUNDLED_COMPANY_CATALOG.catalogVersion,
      added: 0,
      updated: 0,
      adopted: 0,
      unchanged: BUNDLED_COMPANY_CATALOG.companies.length,
    })
  })

  it('rejects invalid industries, version rollback, and changed content at the same version', () => {
    const invalidIndustry = nextCatalog()
    invalidIndustry.companies[0] = { ...invalidIndustry.companies[0]!, industryIds: [999] }
    expect(() =>
      services.companyCatalog.synchronize(invalidIndustry, companyCatalogHash(invalidIndustry)),
    ).toThrowError(expect.objectContaining({ code: 'CATALOG_INVALID' }))

    const rollback = { ...nextCatalog(), catalogVersion: 0 }
    expect(() =>
      services.companyCatalog.synchronize(rollback, companyCatalogHash(rollback)),
    ).toThrowError(expect.objectContaining({ code: 'CATALOG_VERSION_ROLLBACK' }))
    expect(() =>
      services.companyCatalog.synchronize(BUNDLED_COMPANY_CATALOG, '0'.repeat(64)),
    ).toThrowError(expect.objectContaining({ code: 'CATALOG_INVALID' }))
  })

  it('rejects a catalog key that is not a lowercase UUID v4', () => {
    const catalog = structuredClone(BUNDLED_COMPANY_CATALOG)
    catalog.companies[0]!.builtinKey = '5014db58-a37c-18ca-b129-f2516a5b8f8e'
    expect(() => parseCompanyCatalog(catalog)).toThrowError(
      expect.objectContaining({ code: 'CATALOG_INVALID' }),
    )
  })

  it('downloads, verifies, and reports bounded phase progress', async () => {
    const source = nextCatalog()
    const bytes = new TextEncoder().encode(JSON.stringify(source))
    const middle = Math.floor(bytes.length / 2)
    const responses = [
      response(manifest(bytes)),
      streamedResponse([bytes.slice(0, middle), bytes.slice(middle)]),
    ]
    const progress: Array<{ phase: string; progress: number }> = []
    const updater = new CompanyCatalogUpdater(
      services.companyCatalog,
      async () => responses.shift()!,
      () => '0.5.0',
    )

    const result = await updater.update((value) => progress.push(value))
    expect(result.status).toBe('updated')
    expect(progress[0]).toEqual({ phase: 'metadata', progress: 0 })
    expect(progress).toContainEqual({ phase: 'metadata', progress: 8 })
    expect(progress).toContainEqual({ phase: 'download', progress: 58 })
    expect(
      progress.some((item) => item.phase === 'download' && item.progress > 8 && item.progress < 58),
    ).toBe(true)
    expect(progress).toContainEqual({ phase: 'validation', progress: 58 })
    expect(progress).toContainEqual({ phase: 'sync', progress: 72 })
    expect(progress.at(-1)).toEqual({ phase: 'finalizing', progress: 96 })
  })

  it('rejects a download whose raw SHA-256 differs from the manifest', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(nextCatalog()))
    const badManifest = JSON.parse(new TextDecoder().decode(manifest(bytes))) as {
      sha256: string
    }
    badManifest.sha256 = '0'.repeat(64)
    const responses = [
      response(new TextEncoder().encode(JSON.stringify(badManifest))),
      response(bytes),
    ]
    const updater = new CompanyCatalogUpdater(
      services.companyCatalog,
      async () => responses.shift()!,
      () => '0.5.0',
    )
    await expect(updater.update(() => undefined)).rejects.toMatchObject({
      code: 'CATALOG_HASH_MISMATCH',
    })
    expect(services.companyCatalog.status().catalogVersion).toBe(
      BUNDLED_COMPANY_CATALOG.catalogVersion,
    )
  })

  it('rejects HTTP failures, invalid redirects, oversized data, malformed JSON, and newer app requirements', async () => {
    const failedResponse = new Response('', { status: 503 })
    Object.defineProperty(failedResponse, 'url', { value: 'https://github.com/file' })
    await expect(
      new CompanyCatalogUpdater(
        services.companyCatalog,
        async () => failedResponse,
        () => '0.5.0',
      ).update(() => undefined),
    ).rejects.toMatchObject({
      code: 'CATALOG_DOWNLOAD_FAILED',
      message: '暂时无法获取内置公司数据，请稍后重试',
    })

    await expect(
      new CompanyCatalogUpdater(
        services.companyCatalog,
        async () => response(new Uint8Array([1]), 'https://example.com/file'),
        () => '0.5.0',
      ).update(() => undefined),
    ).rejects.toMatchObject({ code: 'CATALOG_DOWNLOAD_FAILED' })

    const oneByteManifest = new TextEncoder().encode(
      JSON.stringify({
        fileName: COMPANY_CATALOG_ASSET_NAME,
        size: 1,
        sha256: '0'.repeat(64),
      }),
    )
    const oversizedResponses = [response(oneByteManifest), response(new Uint8Array([1, 2]))]
    await expect(
      new CompanyCatalogUpdater(
        services.companyCatalog,
        async () => oversizedResponses.shift()!,
        () => '0.5.0',
      ).update(() => undefined),
    ).rejects.toMatchObject({ code: 'CATALOG_TOO_LARGE' })

    const malformed = new TextEncoder().encode('{')
    const malformedResponses = [response(manifest(malformed)), response(malformed)]
    await expect(
      new CompanyCatalogUpdater(
        services.companyCatalog,
        async () => malformedResponses.shift()!,
        () => '0.5.0',
      ).update(() => undefined),
    ).rejects.toMatchObject({ code: 'CATALOG_INVALID' })

    const newer = { ...nextCatalog(), minimumAppVersion: '99.0.0' }
    const newerBytes = new TextEncoder().encode(JSON.stringify(newer))
    const newerResponses = [response(manifest(newerBytes)), response(newerBytes)]
    await expect(
      new CompanyCatalogUpdater(
        services.companyCatalog,
        async () => newerResponses.shift()!,
        () => '0.5.0',
      ).update(() => undefined),
    ).rejects.toMatchObject({ code: 'CATALOG_APP_UPDATE_REQUIRED' })
  })

  it('prevents concurrent updates and aborts the active download', async () => {
    const updater = new CompanyCatalogUpdater(
      services.companyCatalog,
      async (_url, { signal }) =>
        new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        }),
      () => '0.5.0',
    )
    const active = updater.update(() => undefined)
    await expect(updater.update(() => undefined)).rejects.toMatchObject({
      code: 'CATALOG_UPDATE_IN_PROGRESS',
    })
    updater.cancel()
    await expect(active).rejects.toMatchObject({ code: 'CATALOG_DOWNLOAD_FAILED' })
  })

  it('aborts a download after thirty seconds', async () => {
    vi.useFakeTimers()
    try {
      const updater = new CompanyCatalogUpdater(
        services.companyCatalog,
        async (_url, { signal }) =>
          new Promise<Response>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true })
          }),
        () => '0.5.0',
      )
      const update = updater.update(() => undefined)
      const rejection = expect(update).rejects.toMatchObject({
        code: 'CATALOG_DOWNLOAD_FAILED',
      })
      await vi.advanceTimersByTimeAsync(30_000)
      await rejection
    } finally {
      vi.useRealTimers()
    }
  })
})
