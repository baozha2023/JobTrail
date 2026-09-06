import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
const outputDir = path.join(projectRoot, 'dist', 'velopack')
const githubRepository = 'https://github.com/baozha2023/JobTrail'

fs.mkdirSync(outputDir, { recursive: true })
const downloadArgs = ['download', 'github', '--outputDir', outputDir, '--repoUrl', githubRepository]
if (process.env.GITHUB_TOKEN) downloadArgs.push('--token', process.env.GITHUB_TOKEN)
const previousRelease = spawnSync('vpk', downloadArgs, { cwd: projectRoot, stdio: 'inherit', shell: process.platform === 'win32' })
if (previousRelease.error && previousRelease.error.code === 'ENOENT') throw previousRelease.error
// A repository without a previous release is a valid first-release case. vpk
// will then emit only the full package during the pack step below.

// MSI is intentionally not part of the current distribution. Remove a stale
// artifact from older local packaging runs without touching Velopack packages
// needed for delta generation.
if (fs.existsSync(outputDir)) {
  for (const name of fs.readdirSync(outputDir)) {
    if (name.toLowerCase().endsWith('.msi')) fs.rmSync(path.join(outputDir, name), { force: true })
  }
}

const result = spawnSync('vpk', [
  'pack',
  '--outputDir', outputDir,
  '--packId', 'zhiji',
  '--packVersion', packageJson.version,
  '--packDir', path.join(projectRoot, 'dist', 'win-unpacked'),
  '--packTitle', '职迹',
  '--mainExe', 'zhiji.exe',
  '--icon', path.join(projectRoot, 'resource', 'icon.ico'),
], { cwd: projectRoot, stdio: 'inherit', shell: process.platform === 'win32' })

if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
