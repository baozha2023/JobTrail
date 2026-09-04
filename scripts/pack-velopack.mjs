import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))

const result = spawnSync('vpk', [
  'pack',
  '--packId', 'zhiji',
  '--packVersion', packageJson.version,
  '--packDir', path.join(projectRoot, 'release', 'win-unpacked'),
  '--mainExe', 'zhiji.exe',
], { cwd: projectRoot, stdio: 'inherit', shell: process.platform === 'win32' })

if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)

