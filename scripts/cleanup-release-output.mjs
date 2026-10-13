import fs from 'node:fs'
import path from 'node:path'

const GENERATED_DIRECTORIES = ['win-unpacked', 'qa', 'compatibility']
const GENERATED_TEST_DIRECTORY =
  /^\.(?:discovery-dialogs|discovery-mcp|session-restart|onboarding)-[A-Za-z0-9]{6}$/
const GENERATED_FILES = [
  'builder-debug.yml',
  'builder-effective-config.yaml',
  'exam-smoke.png',
  'exam-smoke-failure.png',
]

// Run only after release validation succeeds, so failed builds retain their evidence.
export function cleanupReleaseOutput(projectRoot) {
  const dist = path.join(fs.realpathSync(projectRoot), 'dist')
  const metadata = fs.lstatSync(dist, { throwIfNoEntry: false })
  if (!metadata) return []
  if (!metadata.isDirectory()) throw new Error('Release dist must be a regular directory')

  const directories = [
    ...GENERATED_DIRECTORIES,
    ...fs.readdirSync(dist).filter((name) => GENERATED_TEST_DIRECTORY.test(name)),
  ]
  const targets = []
  // Validate the whole allowlist before deleting anything; never follow a linked target.
  for (const name of [...directories, ...GENERATED_FILES]) {
    const target = path.resolve(dist, name)
    if (path.dirname(target) !== dist) throw new Error(`Invalid release cleanup path: ${name}`)
    const stat = fs.lstatSync(target, { throwIfNoEntry: false })
    if (!stat) continue
    const valid = directories.includes(name) ? stat.isDirectory() : stat.isFile()
    if (!valid) throw new Error(`Invalid release cleanup target: ${name}`)
    targets.push({ name, target })
  }
  for (const { target } of targets)
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 })
  return targets.map(({ name }) => name)
}
