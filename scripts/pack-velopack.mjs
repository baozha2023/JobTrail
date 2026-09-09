import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { downloadPreviousVelopackFull } from './resolve-velopack-baseline.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const output = path.join(root, 'dist', 'velopack')
const manifest = path.join(root, 'native', 'bootstrap', 'Cargo.toml')
const binaries = path.join(root, 'native', 'bootstrap', 'target', 'release')
const cargo = path.join(os.homedir(), '.cargo', 'bin', 'cargo.exe')
const vpk = path.join(os.homedir(), '.dotnet', 'tools', 'vpk.exe')
function run(command, args, env = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, JOBTRAIL_VERSION: pkg.version, ...env },
    shell: false,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed (${result.status})`)
}
function directorySize(directory) {
  let size = 0
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    const metadata = fs.lstatSync(file)
    if (metadata.isSymbolicLink()) throw new Error(`Release input must not contain links: ${file}`)
    size += entry.isDirectory() ? directorySize(file) : metadata.size
  }
  return size
}
if (process.platform !== 'win32') throw new Error('Windows packaging requires Windows')
// This generated directory is owned exclusively by this release script.
if (path.relative(root, output) !== path.join('dist', 'velopack'))
  throw new Error('Invalid output directory')
if (fs.existsSync(output) && fs.lstatSync(output).isSymbolicLink())
  throw new Error('Output must not be a link')
fs.rmSync(output, { recursive: true, force: true })
fs.mkdirSync(output, { recursive: true })
await downloadPreviousVelopackFull({
  feedUrl: 'https://github.com/baozha2023/JobTrail/releases/latest/download',
  targetVersion: pkg.version,
  outputDir: output,
})
run(cargo, [
  'build',
  '--release',
  '--locked',
  '--manifest-path',
  manifest,
  '--bin',
  'launcher',
  '--bin',
  'uninstaller',
])
run(vpk, [
  'pack',
  '--outputDir',
  output,
  '--packId',
  'zhiji',
  '--packVersion',
  pkg.version,
  '--packDir',
  path.join(root, 'dist', 'win-unpacked'),
  '--packTitle',
  '职迹',
  '--channel',
  'win',
  '--mainExe',
  'zhiji.exe',
  '--shortcuts',
  'None',
  '--noPortable',
  '--icon',
  path.join(root, 'resource', 'icon.ico'),
])
const feed = JSON.parse(fs.readFileSync(path.join(output, 'releases.win.json'), 'utf8'))
const fullPackage = feed.Assets.find(
  (asset) => asset.Version === pkg.version && asset.Type === 'Full',
)
if (!fullPackage) throw new Error(`Missing Full package for ${pkg.version}`)
const requiredSpace =
  directorySize(path.join(root, 'dist', 'win-unpacked')) +
  fullPackage.Size +
  fs.statSync(path.join(binaries, 'launcher.exe')).size +
  fs.statSync(path.join(binaries, 'uninstaller.exe')).size
run(cargo, ['build', '--release', '--locked', '--manifest-path', manifest, '--bin', 'installer'], {
  JOBTRAIL_SETUP: path.join(output, 'zhiji-win-Setup.exe'),
  JOBTRAIL_LAUNCHER: path.join(binaries, 'launcher.exe'),
  JOBTRAIL_UNINSTALLER: path.join(binaries, 'uninstaller.exe'),
  JOBTRAIL_REQUIRED_SPACE_BYTES: String(requiredSpace),
})
fs.copyFileSync(
  path.join(binaries, 'installer.exe'),
  path.join(output, `JobTrail-Setup-${pkg.version}.exe`),
)
for (const asset of feed.Assets) {
  if (path.basename(asset.FileName) !== asset.FileName) throw new Error('Invalid asset filename')
  const data = fs.readFileSync(path.join(output, asset.FileName))
  if (
    data.length !== asset.Size ||
    createHash('sha256').update(data).digest('hex') !== asset.SHA256.toLowerCase()
  )
    throw new Error(`Invalid release asset: ${asset.FileName}`)
}
// Only publish the custom offline setup and the update feed/packages.
for (const name of ['zhiji-win-Setup.exe', 'RELEASES', 'assets.win.json'])
  fs.rmSync(path.join(output, name), { force: true })
console.log(`Release ready: ${output}`)
