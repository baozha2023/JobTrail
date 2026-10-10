import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { expect, it, vi } from 'vitest'
import { platformAdapter } from '../src/main/discovery/adapter-registry'
import { allowedPage, canonicalJob, jobIdentity } from '../src/main/discovery/platforms'
import {
  platforms,
  platformNames,
  platformSchema,
  searchQuerySchema,
} from '../src/shared/job-discovery'
import { canonicalUrl, identityFor } from '../src/main/discovery/identity'
import type { JobIdentityPolicy } from '../src/main/discovery/adapter'
import { runSourceTasks } from '../src/main/discovery/collection'

const directory = path.resolve('src/main/discovery')
const files = fs
  .readdirSync(directory, { recursive: true })
  .filter((file): file is string => typeof file === 'string' && file.endsWith('.ts'))
  .map((file) => path.join(directory, file))
function parse(file: string) {
  return ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
}
function imports(source: ts.SourceFile, includeTypes = false) {
  const result: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const typeOnly = ts.isImportDeclaration(node)
        ? node.importClause?.isTypeOnly ||
          (node.importClause?.namedBindings &&
            ts.isNamedImports(node.importClause.namedBindings) &&
            !node.importClause.name &&
            node.importClause.namedBindings.elements.every((binding) => binding.isTypeOnly))
        : node.isTypeOnly ||
          (node.exportClause &&
            ts.isNamedExports(node.exportClause) &&
            node.exportClause.elements.every((binding) => binding.isTypeOnly))
      if (
        (!typeOnly || includeTypes) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        result.push(node.moduleSpecifier.text)
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    )
      result.push(node.arguments[0].text)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return result
}
function resolveImport(file: string, name: string) {
  if (!name.startsWith('.')) return undefined
  const target = path.resolve(path.dirname(file), name)
  return [target + '.ts', target + '/index.ts', target].find(
    (candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile(),
  )
}
function adapterOwner(file: string) {
  const relative = path.relative(path.join(directory, 'adapters'), file).replaceAll('\\', '/')
  return relative.startsWith('../') ? undefined : relative.split('/')[0].replace(/\.ts$/, '')
}

it('registers every public platform exactly once with a complete adapter', () => {
  expect(new Set(platforms).size).toBe(platforms.length)
  expect(Object.keys(platformNames)).toEqual(platforms)
  expect(platformSchema.options).toEqual(platforms)
  expect(searchQuerySchema.parse({ keyword: 'Java', platforms }).platforms).toEqual(platforms)
  expect(() => searchQuerySchema.parse({ keyword: 'Java', platforms: ['unregistered'] })).toThrow()
  for (const id of platforms) {
    const adapter = platformAdapter(id)
    expect(adapter.id).toBe(id)
    expect(adapter.contractVersion).toBeGreaterThan(0)
    expect(allowedPage(id, adapter.accountCheckUrl)).toBe(true)
    expect(adapter.remoteFilters).toContain('keyword')
    expect(adapter.qr.scanHint['zh-CN']).toBeTruthy()
    expect(adapter.qr.scanHint['en-US']).toBeTruthy()
    expect(adapter.pageScript(false)).toBeTruthy()
    expect(adapter.checkSession).toBeTypeOf('function')
    expect(['operation', 'batch']).toContain(adapter.sessionCheck)
  }
})

it('keeps concrete platform IDs, endpoint domains and branches out of shared discovery modules', () => {
  const violations: string[] = []
  const domains = platforms.flatMap((platform) => platformAdapter(platform).domains)
  for (const file of files) {
    const relative = path.relative(directory, file).replaceAll('\\', '/')
    if (relative.startsWith('adapters/') || relative === 'adapter-registry.ts') continue
    const visit = (node: ts.Node) => {
      if (
        (ts.isStringLiteralLike(node) || ts.isRegularExpressionLiteral(node)) &&
        (platforms.includes(node.text as (typeof platforms)[number]) ||
          domains.some((domain) => node.text.replaceAll('\\.', '.').includes(domain)))
      )
        violations.push(`${relative}: ${node.getText()}`)
      ts.forEachChild(node, visit)
    }
    visit(parse(file))
  }
  expect(violations).toEqual([])
})

it('isolates each adapter and its helpers from other sites, registries and resource owners', () => {
  const violations: string[] = []
  for (const platform of platforms) {
    const visited = new Set<string>()
    const visit = (file: string) => {
      if (visited.has(file) || !file.endsWith('.ts')) return
      visited.add(file)
      for (const name of imports(parse(file), adapterOwner(file) === platform)) {
        const label = `${path.relative(directory, file)} imports ${name}`
        if (
          /(?:adapter-registry|platforms$|search-page$|runtime|repository|service|persistence|qr-login|qr-verification|account-session|platform-browser|discovery-cities$|^electron$|^(?:node:)?(?:fs|net|http|https|child_process)(?:\/|$))/.test(
            name,
          )
        )
          violations.push(label)
        const target = resolveImport(file, name)
        if (!target) continue
        const owner = adapterOwner(target)
        if (owner && owner !== platform) violations.push(label)
        if (
          target.startsWith(path.resolve('src/shared/discovery-cities') + path.sep) &&
          path.basename(target) !== `${platform}.json`
        )
          violations.push(label)
        if (
          target.startsWith(directory + path.sep) ||
          target.startsWith(path.resolve('src/shared') + path.sep)
        )
          visit(target)
      }
    }
    // Include submodules even when not currently imported by the entry point.
    files.filter((file) => adapterOwner(file) === platform).forEach(visit)
  }
  expect(violations).toEqual([])
})

it('allows only the registry to import concrete adapters from application code', () => {
  const sourceRoot = path.resolve('src')
  const violations: string[] = []
  for (const relative of fs.readdirSync(sourceRoot, { recursive: true })) {
    if (typeof relative !== 'string' || !/\.(?:ts|vue)$/.test(relative)) continue
    const file = path.join(sourceRoot, relative)
    if (adapterOwner(file) || file === path.join(directory, 'adapter-registry.ts')) continue
    const contents = fs.readFileSync(file, 'utf8')
    const script = file.endsWith('.vue')
      ? [...contents.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
          .map((match) => match[1])
          .join('\n')
      : contents
    for (const name of imports(
      ts.createSourceFile(file, script, ts.ScriptTarget.Latest, true),
      true,
    )) {
      const target = resolveImport(file, name)
      if (target && adapterOwner(target)) violations.push(`${relative}: ${name}`)
      if (file.startsWith(directory + path.sep) && /(?:^|\/)discovery-cities$/.test(name))
        violations.push(`${relative}: use adapter.cities`)
    }
  }
  expect(violations).toEqual([])
})

it('has no runtime dependency cycles inside discovery', () => {
  const graph = new Map(
    files.map((file) => [
      file,
      imports(parse(file))
        .filter((name) => name.startsWith('.'))
        .map((name) => resolveImport(file, name))
        .filter((target): target is string => !!target && files.includes(target)),
    ]),
  )
  const done = new Set<string>()
  function visit(file: string, stack: string[]) {
    expect(stack, `Runtime cycle through ${file}`).not.toContain(file)
    if (done.has(file)) return
    for (const next of graph.get(file) ?? []) visit(next, [...stack, file])
    done.add(file)
  }
  for (const file of files) visit(file, [])
})

it.each([
  ['boss', 'http://www.zhipin.com/job_detail/a~b.html?tracking=1', 'a~b'],
  ['liepin', 'https://www.liepin.com/lptjob/123?tracking=1', 'lptjob:123'],
  ['zhilian', 'https://jobs.zhaopin.com/CC123.htm?tracking=1', 'CC123'],
  ['wuyou', 'https://campus.51job.com/x/jobdetail?jobid=123&tracking=1', '123'],
] as const)(
  'routes %s identities through its adapter and retains stable normalization',
  (id, url, externalId) => {
    const normalized = canonicalJob(id, url)!
    expect(normalized.externalId).toBe(externalId)
    expect(normalized.url).not.toContain('tracking')
    expect(canonicalJob(id, normalized.url)).toEqual(normalized)
    expect(jobIdentity(id, url)).toEqual(jobIdentity(id, normalized.url, externalId))
    expect(canonicalJob(id, url.replace(new URL(url).hostname, 'evil.example'))).toBeNull()
    expect(() => jobIdentity(id, normalized.url, 'wrong')).toThrow('does not match')
  },
)

it('queues a fifth and sixth source without exceeding four concurrent collectors', async () => {
  const releases: (() => void)[] = [],
    started: number[] = []
  let active = 0,
    peak = 0
  const work = runSourceTasks([0, 1, 2, 3, 4, 5], async (value) => {
    started.push(value)
    peak = Math.max(peak, ++active)
    await new Promise<void>((resolve) => releases.push(resolve))
    active--
  })
  expect(started).toEqual([0, 1, 2, 3])
  releases[0]()
  releases[1]()
  await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3, 4, 5]))
  releases.forEach((release) => release())
  await work
  expect(peak).toBe(4)
  expect(active).toBe(0)
})

it('supports an adapter with canonical URL identity and rejects a normalizer that leaves its domains', () => {
  const policy: JobIdentityPolicy = {
    id: 'boss',
    domains: ['example.test'],
    canonicalJob(url) {
      if (!url.pathname.startsWith('/position/')) return null
      url.search = ''
      url.hash = ''
      return { url: url.href, externalId: null }
    },
  }
  const first = identityFor(policy, 'https://example.test/position/a?tracking=1')
  expect(first.identity).toBe('https://example.test/position/a')
  expect(identityFor(policy, first.url)).toEqual(first)
  expect(identityFor(policy, 'https://example.test/position/b').id).not.toBe(first.id)
  expect(
    canonicalUrl(
      { ...policy, canonicalJob: () => ({ url: 'https://evil.example/a', externalId: 'a' }) },
      first.url,
    ),
  ).toBeNull()
})

it('keeps native account requests and storage out of login orchestration and runtime', () => {
  for (const name of ['qr-login.ts', 'runtime.ts']) {
    const violations: string[] = []
    const visit = (node: ts.Node) => {
      if (
        ts.isPropertyAccessExpression(node) &&
        ['fetch', 'cookies', 'fromPath', 'clearData', 'clearCache', 'flushStorageData'].includes(
          node.name.text,
        )
      )
        violations.push(node.getText())
      ts.forEachChild(node, visit)
    }
    visit(parse(path.join(directory, name)))
    expect(violations, name).toEqual([])
  }
  expect(imports(parse(path.join(directory, 'account-session.ts')))).not.toContain('./search-page')
})
