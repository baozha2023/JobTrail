import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import semver from 'semver'

const FEED_NAME = 'releases.win.json'
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
  try {
    for await (const chunk of Readable.fromWeb(response.body)) {
      size += chunk.length
      if (size > MAX_FEED_BYTES) throw new Error('feed_too_large')
      chunks.push(chunk)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('invalid_baseline_feed')
  }
}

// Selection, download and integrity verification share one feed snapshot. Never
// delegate a second "latest" selection to vpk after choosing a lower baseline.
export async function downloadPreviousVelopackFull({ feedUrl, targetVersion, outputDir }) {
  if (!stableVersion(targetVersion)) throw new Error('invalid_baseline_target_version')
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
  const response = await sourceRequest(sourceUrl(baseUrl, FEED_NAME), {})
  if (response.status === 404) {
    await response.body?.cancel()
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
    .filter((asset) => semver.lt(asset.Version, targetVersion))
    .sort((a, b) => semver.rcompare(a.Version, b.Version))
  const selected = candidates[0]
  if (!selected) return null
  if (candidates.filter((asset) => asset.Version === selected.Version).length !== 1)
    throw new Error('ambiguous_baseline_full')
  const packageUrl = sourceUrl(baseUrl, selected.FileName)
  const head = await sourceRequest(packageUrl, {
    method: 'HEAD',
  })
  if (head.status === 404) return null
  if (!head.ok) throw new Error('baseline_full_request_failed')
  const download = await sourceRequest(packageUrl, {
    timeout: 30 * 60 * 1000,
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
      Readable.fromWeb(download.body),
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
    if (error.message?.startsWith('baseline_')) throw error
    throw new Error('baseline_full_download_failed')
  } finally {
    await fs.rm(temporary, { force: true })
  }
}
