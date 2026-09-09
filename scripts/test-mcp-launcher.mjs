import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { smokeLauncher } from './test-packaged-mcp.mjs'

const homeCargo = process.env.USERPROFILE
  ? path.join(process.env.USERPROFILE, '.cargo', 'bin', 'cargo.exe')
  : ''
const cargo = process.env.CARGO ?? (homeCargo && fs.existsSync(homeCargo) ? homeCargo : 'cargo')
const build = spawnSync(
  cargo,
  ['build', '--manifest-path', 'native/bootstrap/Cargo.toml', '--bin', 'launcher'],
  { stdio: 'inherit', shell: false },
)
if (build.error) throw build.error
if (build.status !== 0) process.exit(build.status ?? 1)

await smokeLauncher(
  path.resolve('dist/win-unpacked/zhiji.exe'),
  path.resolve('native/bootstrap/target/debug/launcher.exe'),
)
