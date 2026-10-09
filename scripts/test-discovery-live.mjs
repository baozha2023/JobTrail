import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
const require = createRequire(import.meta.url)
const root = path.resolve(import.meta.dirname, '..')
const { build } = require(require.resolve('esbuild', { paths: [require.resolve('vite')] }))
const output = path.join(root, 'dist/qa/discovery-live-worker.cjs')
await build({
  entryPoints: [path.join(root, 'scripts/discovery-live-worker.ts')],
  outfile: output,
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'cjs',
  plugins: [
    {
      name: 'raw-assets',
      setup(builder) {
        builder.onResolve({ filter: /\?raw$/ }, (args) => ({
          path: path.resolve(args.resolveDir, args.path.slice(0, -4)),
          namespace: 'raw',
        }))
        builder.onLoad({ filter: /.*/, namespace: 'raw' }, (args) => ({
          contents: 'export default ' + JSON.stringify(fs.readFileSync(args.path, 'utf8')),
          loader: 'js',
        }))
      },
    },
  ],
})
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(require('electron'), [output, ...process.argv.slice(2)], {
  cwd: root,
  env,
  windowsHide: true,
  stdio: 'inherit',
})
child.on('exit', (code) => process.exit(code ?? 1))
child.on('error', (error) => {
  console.error(error)
  process.exitCode = 1
})
