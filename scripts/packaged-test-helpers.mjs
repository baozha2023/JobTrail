import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

// APPDATA only isolates files. Native launchers still see the real HKCU, so
// acceptance tests must also prove that this user's installation claim is untouched.
export function readInstallationRegistration() {
  return execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$ErrorActionPreference='Stop'
      $key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\zhiji')
      try {
        if ($null -eq $key) { 'null' } else {
          $values=@(foreach ($name in ($key.GetValueNames() | Sort-Object)) {
            [ordered]@{name=$name;kind=$key.GetValueKind($name).ToString();value=$key.GetValue($name,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)}
          })
          ConvertTo-Json -InputObject $values -Depth 10 -Compress
        }
      } finally { if ($null -ne $key) { $key.Dispose() } }`,
    ],
    { encoding: 'utf8', windowsHide: true },
  ).trim()
}

// Unrelated smoke tests use the public controls/settings, never a product test-mode bypass.
export async function skipToursForTest(page, locale = 'zh-CN') {
  await page.locator('.sidebar').waitFor()
  // Vue can mount before the first load finishes. Reloading then aborts Main's
  // initial loadFile promise and takes its fatal renderer-load failure path.
  await page.waitForLoadState('load')
  const config = await page.evaluate(() => window.zhijiApi.config.get())
  const changeLocale = locale !== null && config.locale !== locale
  const skipDiscovery = ['pending', 'inProgress'].includes(config.onboarding.discovery.status)
  if (changeLocale) {
    await page.evaluate((locale) => window.zhijiApi.config.update({ locale }), locale)
  }
  if (['pending', 'inProgress'].includes(config.onboarding.app.status)) {
    const skip = page.locator('.jobtrail-tour .driver-popover-close-btn')
    await skip.waitFor()
    await skip.click()
    await page.locator('.jobtrail-tour').waitFor({ state: 'hidden' })
  }
  if (skipDiscovery) {
    await page.evaluate(() =>
      window.zhijiApi.config.update({
        onboarding: { discovery: { status: 'skipped', stepId: null } },
      }),
    )
  }
  if (changeLocale || skipDiscovery) {
    await page.reload()
    await page.locator('.sidebar').waitFor()
  }
}

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
