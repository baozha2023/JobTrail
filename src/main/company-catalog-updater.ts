import type { CompanyCatalogProgress, CompanyCatalogUpdateResult } from '../shared/types'
import {
  COMPANY_CATALOG_ASSET_URL,
  COMPANY_CATALOG_MANIFEST_URL,
  MAX_COMPANY_CATALOG_BYTES,
  compareReleaseVersions,
  parseCompanyCatalogManifest,
  parseCompanyCatalogText,
  rawSha256,
} from './company-catalog'
import type { CompanyCatalogService } from './services/company-catalog-service'
import { AppServiceError } from './services/errors'

const MANIFEST_MAX_BYTES = 16 * 1024
const DOWNLOAD_TIMEOUT_MS = 30_000
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
])

export type CompanyCatalogFetcher = (
  input: string,
  init: { signal: AbortSignal; redirect: 'follow' },
) => Promise<Response>

export type CompanyCatalogProgressReporter = (progress: CompanyCatalogProgress) => void

const catalogUnavailableMessage = '暂时无法获取内置公司数据，请稍后重试'
const catalogInvalidMessage = '获取的内置公司数据有误，请稍后重试'

function catalogDownloadError(): AppServiceError {
  return new AppServiceError('CATALOG_DOWNLOAD_FAILED', catalogUnavailableMessage)
}

function validateResponse(response: Response): void {
  if (response.status !== 200) throw catalogDownloadError()
  let url: URL
  try {
    url = new URL(response.url)
  } catch {
    throw catalogDownloadError()
  }
  if (url.protocol !== 'https:' || !ALLOWED_DOWNLOAD_HOSTS.has(url.hostname))
    throw catalogDownloadError()
}

async function readResponse(
  response: Response,
  maximumBytes: number,
  onBytes?: (loaded: number) => void,
): Promise<Uint8Array> {
  validateResponse(response)
  if (!response.body) throw catalogDownloadError()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maximumBytes) throw new AppServiceError('CATALOG_TOO_LARGE', catalogInvalidMessage)
      chunks.push(value)
      onBytes?.(size)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
  const result = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

export class CompanyCatalogUpdater {
  private activeController: AbortController | undefined

  constructor(
    private readonly catalogService: CompanyCatalogService,
    private readonly fetcher: CompanyCatalogFetcher,
    private readonly appVersion: () => string,
  ) {}

  cancel(): void {
    this.activeController?.abort()
  }

  async update(report: CompanyCatalogProgressReporter): Promise<CompanyCatalogUpdateResult> {
    if (this.activeController)
      throw new AppServiceError('CATALOG_UPDATE_IN_PROGRESS', '内置公司数据正在更新')
    const controller = new AbortController()
    let timeout: ReturnType<typeof setTimeout> | undefined = setTimeout(
      () => controller.abort(),
      DOWNLOAD_TIMEOUT_MS,
    )
    this.activeController = controller
    try {
      report({ phase: 'metadata', progress: 0 })
      const manifestResponse = await this.fetcher(COMPANY_CATALOG_MANIFEST_URL, {
        signal: controller.signal,
        redirect: 'follow',
      })
      const manifestBytes = await readResponse(manifestResponse, MANIFEST_MAX_BYTES)
      const manifest = parseCompanyCatalogManifest(new TextDecoder().decode(manifestBytes))
      report({ phase: 'metadata', progress: 8 })
      report({ phase: 'download', progress: 8 })

      const catalogResponse = await this.fetcher(COMPANY_CATALOG_ASSET_URL, {
        signal: controller.signal,
        redirect: 'follow',
      })
      const catalogBytes = await readResponse(
        catalogResponse,
        MAX_COMPANY_CATALOG_BYTES,
        (loaded) => {
          if (loaded > manifest.size)
            throw new AppServiceError('CATALOG_TOO_LARGE', catalogInvalidMessage)
          report({ phase: 'download', progress: 8 + Math.floor((loaded / manifest.size) * 50) })
        },
      )
      clearTimeout(timeout)
      timeout = undefined
      if (catalogBytes.byteLength !== manifest.size)
        throw new AppServiceError('CATALOG_HASH_MISMATCH', catalogInvalidMessage)
      report({ phase: 'validation', progress: 58 })
      if (rawSha256(catalogBytes) !== manifest.sha256)
        throw new AppServiceError('CATALOG_HASH_MISMATCH', catalogInvalidMessage)
      const catalog = parseCompanyCatalogText(new TextDecoder().decode(catalogBytes))
      if (compareReleaseVersions(catalog.minimumAppVersion, this.appVersion()) > 0)
        throw new AppServiceError(
          'CATALOG_APP_UPDATE_REQUIRED',
          `请先将职迹更新至 ${catalog.minimumAppVersion} 或更高版本`,
        )
      report({ phase: 'sync', progress: 72 })
      const result = this.catalogService.synchronize(catalog, manifest.sha256)
      report({ phase: 'finalizing', progress: 96 })
      return result
    } catch (error) {
      if (error instanceof AppServiceError) throw error
      if (controller.signal.aborted) throw catalogDownloadError()
      throw catalogDownloadError()
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
      this.activeController = undefined
    }
  }
}
