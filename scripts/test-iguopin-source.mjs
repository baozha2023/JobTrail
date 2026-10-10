import path from 'node:path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
const require = createRequire(import.meta.url)
const { build } = require(require.resolve('esbuild', { paths: [require.resolve('vite')] }))
const output = path.resolve('dist/qa/iguopin-source-worker.cjs')
await build({
  entryPoints: ['scripts/iguopin-source-worker.ts'],
  outfile: output,
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'cjs',
  supported: { 'top-level-await': true },
})
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(require('electron'), [output], { env, windowsHide: true, stdio: 'inherit' })
child.on('exit', (code) => process.exit(code ?? 1))
child.on('error', () => {
  process.exitCode = 1
})
