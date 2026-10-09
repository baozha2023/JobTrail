import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

export async function waitFor(predicate, description, timeout = 15_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out waiting for ${description}`)
}

// Redirect discovery only in test child processes; never modify the installed Edge.
export function withoutSystemEdge(environment, root) {
  const redirected = new Set(['LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'HOMEDRIVE'])
  const env = Object.fromEntries(
    Object.entries(environment).filter(([key]) => !redirected.has(key.toUpperCase())),
  )
  for (const key of redirected) env[key] = root
  env.PLAYWRIGHT_BROWSERS_PATH = path.join(root, 'empty-browser-cache')
  return env
}

// Only immutable program files may be shared with an isolated installation.
// These names are excluded at the installation root, not inside dependencies.
const MUTABLE_ROOT_ENTRIES = new Set([
  'config.json',
  'data',
  'resumes',
  'chat-uploads',
  'browser-sessions',
  '.runtime',
  'logs',
])

export function linkPackagedProgram(source, destination) {
  assert.ok(!fs.lstatSync(source).isSymbolicLink(), 'Packaged program must not contain links')
  function visit(from, to, root) {
    fs.mkdirSync(to, { recursive: true })
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      if (root && MUTABLE_ROOT_ENTRIES.has(entry.name)) continue
      assert.ok(!entry.isSymbolicLink(), 'Packaged program must not contain links')
      const input = path.join(from, entry.name),
        output = path.join(to, entry.name)
      if (entry.isDirectory()) visit(input, output, false)
      else {
        assert.ok(entry.isFile(), 'Packaged program must contain only files and directories')
        fs.linkSync(input, output)
      }
    }
  }
  visit(source, destination, true)
}
