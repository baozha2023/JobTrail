import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const electronExecutable = require('electron')
const vitestEntrypoint = fileURLToPath(new URL('./vitest-electron-entry.mjs', import.meta.url))
const result = spawnSync(electronExecutable, ['--runAsNode', vitestEntrypoint], {
  stdio: 'inherit',
  shell: false,
  env: { ...process.env, ZHIJI_VITEST_ARGS: JSON.stringify(['run', ...process.argv.slice(2)]) },
})

if (result.error) throw result.error
process.exit(result.status ?? 1)
