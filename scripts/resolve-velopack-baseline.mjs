import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import semver from 'semver'

const FEED_NAME = 'releases.win.json'
const FIRST_FORMAL_VERSION = '1.0.0'
const SAFE_PACKAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.nupkg$/
const MAX_FEED_BYTES = 1024 * 1024

function stableVersion(value) {
  return (
    typeof value === 'string' && semver.valid(value) === value && semver.prerelease(value) === null
  )
}
function sourceUrl(baseUrl, filename) {
  const url = new URL(baseUrl)
  url.pathname = `${url.pathname.replace(/\/$/, '')}/${encodeURIComponent(filename)}`
  return url
}
async function sourceRequest(url, { timeout = 15_000, ...options }) {
  try {
    return await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeout),
      ...options,
    })
  } catch {
    throw new Error('baseline_source_request_failed')
  }
}
async function readFeed(response) {
  let size = 0
  const chunks = []
  for await (const chunk of sourceChunks(response)) {
    size += chunk.length
    if (size > MAX_FEED_BYTES) throw new Error('invalid_baseline_feed')
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('invalid_baseline_feed')
  }
}
async function* sourceChunks(response) {
  try {
    yield* Readable.fromWeb(response.body)
  } catch {
    throw new Error('baseline_source_request_failed')
  }
}

export async function downloadPreviousVelopackFull(options) {
  try {
    return await downloadVerifiedPreviousFull(options)
  } catch (error) {
    if (
      ![
        'baseline_source_request_failed',
        'baseline_feed_request_failed',
        'baseline_full_request_failed',
        'baseline_full_download_failed',
      ].includes(error.message)
    )
      throw error
    console.warn(
      `[Velopack] 无法获取上一版完整包（${error.message}），跳过 Delta，继续构建完整包。`,
    )
    return null
  }
}

// Selection, download and integrity verification share one feed snapshot. Never
// delegate a second "latest" selection to vpk after choosing a lower baseline.
async function downloadVerifiedPreviousFull({ feedUrl, targetVersion, outputDir, dispatcher }) {
  if (!stableVersion(targetVersion)) throw new Error('invalid_baseline_target_version')
  if (semver.lte(targetVersion, FIRST_FORMAL_VERSION)) return null
  let baseUrl
  try {
    baseUrl = new URL(feedUrl)
  } catch {
    throw new Error('invalid_baseline_feed_url')
  }
  if (
    !['http:', 'https:'].includes(baseUrl.protocol) ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash
  )
    throw new Error('invalid_baseline_feed_url')
  const response = await sourceRequest(sourceUrl(baseUrl, FEED_NAME), { dispatcher })
  if (response.status === 404) {
    await response.body?.cancel()
    console.log('[Velopack] 未找到上一版 Feed，跳过 Delta，继续构建完整包。')
    return null
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error('baseline_feed_request_failed')
  }
  const feed = await readFeed(response)
  if (!feed || !Array.isArray(feed.Assets)) throw new Error('invalid_baseline_feed')
  const fulls = feed.Assets.filter((asset) => asset?.Type === 'Full')
  if (
    fulls.some(
      (asset) =>
        !stableVersion(asset.Version) ||
        typeof asset.FileName !== 'string' ||
        !SAFE_PACKAGE_NAME.test(asset.FileName) ||
        asset.PackageId !== 'zhiji' ||
        !Number.isSafeInteger(asset.Size) ||
        asset.Size <= 0 ||
        typeof asset.SHA256 !== 'string' ||
        !/^[a-f0-9]{64}$/i.test(asset.SHA256),
    )
  )
    throw new Error('invalid_baseline_feed')
  const candidates = fulls
    .filter(
      (asset) =>
        semver.gte(asset.Version, FIRST_FORMAL_VERSION) && semver.lt(asset.Version, targetVersion),
    )
    .sort((a, b) => semver.rcompare(a.Version, b.Version))
  const selected = candidates[0]
  if (!selected) {
    console.log('[Velopack] 未找到合适的上一版完整包，跳过 Delta，继续构建完整包。')
    return null
  }
  if (candidates.filter((asset) => asset.Version === selected.Version).length !== 1)
    throw new Error('ambiguous_baseline_full')
  const packageUrl = sourceUrl(baseUrl, selected.FileName)
  const head = await sourceRequest(packageUrl, {
    method: 'HEAD',
    dispatcher,
  })
  if (!head.ok) {
    await head.body?.cancel()
    throw new Error('baseline_full_request_failed')
  }
  const download = await sourceRequest(packageUrl, {
    timeout: 30 * 60 * 1000,
    dispatcher,
  })
  if (!download.ok) {
    await download.body?.cancel()
    throw new Error('baseline_full_download_failed')
  }
  const root = path.resolve(outputDir)
  await fs.mkdir(root, { recursive: true })
  const temporary = path.join(root, `.baseline-${randomUUID()}.tmp`)
  let publishedPackage = false
  let size = 0
  const hash = createHash('sha256')
  const sha1 = createHash('sha1')
  try {
    await pipeline(
      sourceChunks(download),
      new Transform({
        transform(chunk, _encoding, done) {
          size += chunk.length
          if (size > selected.Size) {
            done(new Error('baseline_full_size_mismatch'))
            return
          }
          hash.update(chunk)
          sha1.update(chunk)
          done(null, chunk)
        },
      }),
      createWriteStream(temporary, { flags: 'wx' }),
    )
    if (size !== selected.Size || hash.digest('hex') !== selected.SHA256.toLowerCase())
      throw new Error('baseline_full_integrity_failed')
    // Exclusive hard-link publication keeps an existing output file intact.
    await fs.link(temporary, path.join(root, selected.FileName))
    publishedPackage = true
    await fs.writeFile(
      path.join(root, FEED_NAME),
      JSON.stringify({
        Assets: [{ ...selected, SHA1: sha1.digest('hex').toUpperCase() }],
      }),
      { flag: 'wx' },
    )
    return { version: selected.Version, filename: selected.FileName, size }
  } catch (error) {
    if (publishedPackage) await fs.rm(path.join(root, selected.FileName), { force: true })
    throw error
  } finally {
    await fs.rm(temporary, { force: true })
  }
}
