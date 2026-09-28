import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import path from 'node:path'

const SAFE_PACKAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.nupkg$/

async function verifyPackage(outputDir, asset) {
  if (
    !asset ||
    asset.PackageId !== 'zhiji' ||
    !['Full', 'Delta'].includes(asset.Type) ||
    typeof asset.FileName !== 'string' ||
    !SAFE_PACKAGE_NAME.test(asset.FileName) ||
    !Number.isSafeInteger(asset.Size) ||
    asset.Size <= 0 ||
    typeof asset.SHA256 !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(asset.SHA256)
  )
    throw new Error('Invalid release asset metadata')
  const file = path.join(outputDir, asset.FileName)
  const stat = await fs.lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== asset.Size)
    throw new Error(`Invalid release asset: ${asset.FileName}`)
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  if (hash.digest('hex') !== asset.SHA256.toLowerCase())
    throw new Error(`Invalid release asset: ${asset.FileName}`)
}

export async function finalizeVelopackAssets(outputDir, targetVersion, baseline) {
  const feedFile = path.join(outputDir, 'releases.win.json')
  const feed = JSON.parse(await fs.readFile(feedFile, 'utf8'))
  if (!feed || !Array.isArray(feed.Assets)) throw new Error('Invalid release feed')
  const current = []
  const previous = []
  const filenames = new Set()
  for (const asset of feed.Assets) {
    await verifyPackage(outputDir, asset)
    if (filenames.has(asset.FileName)) throw new Error('Duplicate release asset')
    filenames.add(asset.FileName)
    if (asset.Version === targetVersion) current.push(asset)
    else previous.push(asset)
  }
  if (current.filter((asset) => asset.Type === 'Full').length !== 1)
    throw new Error(`Missing or duplicate Full package for ${targetVersion}`)
  if (current.filter((asset) => asset.Type === 'Delta').length !== Number(Boolean(baseline)))
    throw new Error(`Unexpected Delta packages for ${targetVersion}`)
  if (
    baseline
      ? previous.length !== 1 ||
        previous[0].Type !== 'Full' ||
        previous[0].Version !== baseline.version ||
        previous[0].FileName !== baseline.filename ||
        previous[0].Size !== baseline.size
      : previous.length !== 0
  )
    throw new Error('Unexpected baseline assets in release feed')
  const packageFiles = (await fs.readdir(outputDir)).filter((name) =>
    name.toLowerCase().endsWith('.nupkg'),
  )
  if (packageFiles.length !== filenames.size || packageFiles.some((name) => !filenames.has(name)))
    throw new Error('Unlisted package in release output')

  const temporaryFeed = path.join(outputDir, `.releases.win-${randomUUID()}.tmp`)
  try {
    await fs.writeFile(temporaryFeed, JSON.stringify({ ...feed, Assets: current }), { flag: 'wx' })
    await fs.rename(temporaryFeed, feedFile)
  } finally {
    await fs.rm(temporaryFeed, { force: true })
  }
  for (const asset of previous) await fs.unlink(path.join(outputDir, asset.FileName))
}
