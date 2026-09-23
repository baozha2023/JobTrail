import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'

const workspace = path.resolve('.')
const target = path.resolve('dist/browser-stage')
if (path.relative(workspace, target).startsWith('..') || target === workspace)
  throw new Error('Browser staging path must remain inside the workspace')

const browserRoot = path.dirname(path.dirname(chromium.executablePath()))
const revision = path.basename(browserRoot).replace(/^chromium-/, '')
const source = path.join(
  path.dirname(browserRoot),
  `chromium_headless_shell-${revision}`,
  'chrome-headless-shell-win64',
)
if (!fs.existsSync(path.join(source, 'chrome-headless-shell.exe')))
  throw new Error(
    'Playwright Chromium headless shell is missing; run pnpm exec playwright install --only-shell chromium',
  )

fs.mkdirSync(path.dirname(target), { recursive: true })
fs.rmSync(target, { recursive: true, force: true })
fs.cpSync(source, target, { recursive: true })
console.log(`Staged Playwright Chromium headless shell ${revision}`)
