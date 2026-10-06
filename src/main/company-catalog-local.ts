import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  COMPANY_CATALOG_ASSET_NAME,
  COMPANY_CATALOG_MANIFEST_ASSET_NAME,
  MAX_COMPANY_CATALOG_BYTES,
  rawSha256,
} from './company-catalog'
import type { CompanyCatalogFetcher, CompanyCatalogUrls } from './company-catalog-updater'
import { AppServiceError } from './services/errors'

export function localCompanyCatalogSource(
  appPath: string,
): CompanyCatalogUrls & { fetcher: CompanyCatalogFetcher } {
  const catalogPath = path.join(appPath, 'resource', COMPANY_CATALOG_ASSET_NAME)
  const catalogUrl = pathToFileURL(catalogPath).href
  const manifestUrl = pathToFileURL(
    path.join(appPath, 'resource', COMPANY_CATALOG_MANIFEST_ASSET_NAME),
  ).href
  const fetcher: CompanyCatalogFetcher = async (url, { signal }) => {
    signal.throwIfAborted()
    if (url !== catalogUrl && url !== manifestUrl)
      throw new Error('Invalid local company catalog URL')
    let bytes: Buffer
    try {
      bytes = await readFile(catalogPath, { signal })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return new Response(null, { status: 404 })
      throw error
    }
    if (bytes.byteLength > MAX_COMPANY_CATALOG_BYTES)
      throw new AppServiceError('CATALOG_TOO_LARGE', '获取的内置公司数据有误，请稍后重试')
    // Development has only the source JSON; derive the release-style manifest
    // from its current bytes and let the shared updater validate both reads.
    return url === manifestUrl
      ? new Response(
          JSON.stringify({
            fileName: COMPANY_CATALOG_ASSET_NAME,
            size: bytes.byteLength,
            sha256: rawSha256(bytes),
          }),
        )
      : new Response(new Uint8Array(bytes).buffer)
  }
  return { catalogUrl, manifestUrl, fetcher }
}
