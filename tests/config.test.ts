import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppPaths } from '../src/main/config'
import { ConfigService, DEFAULT_CONFIG } from '../src/main/config'

describe('config service', () => {
  const roots: string[] = []
  afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
  function createPaths(): AppPaths {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zhiji-config-'))
    roots.push(root)
    return { root, config: path.join(root, 'config.json'), data: path.join(root, 'data'), database: path.join(root, 'data', 'zhiji.db'), resumes: path.join(root, 'resumes') }
  }

  it('writes defaults atomically and preserves unknown fields', () => {
    const paths = createPaths()
    const config = new ConfigService(paths)
    expect(config.get()).toMatchObject(DEFAULT_CONFIG)
    expect(config.get().companyReadValidityMonths).toBe(3)
    fs.writeFileSync(paths.config, JSON.stringify({ ...config.get(), customExtension: { enabled: true } }))
    const loaded = new ConfigService(paths)
    expect(loaded.get().customExtension).toEqual({ enabled: true })
    expect(loaded.update({ locale: 'en-US' }).locale).toBe('en-US')
    expect(loaded.update({ companyReadValidityMonths: 6 }).companyReadValidityMonths).toBe(6)
    expect(JSON.parse(fs.readFileSync(paths.config, 'utf8')).customExtension).toEqual({ enabled: true })
  })

  it('backs up malformed and unsupported-version config files', () => {
    const paths = createPaths()
    fs.writeFileSync(paths.config, '{ broken')
    const recovered = new ConfigService(paths)
    expect(recovered.get()).toMatchObject(DEFAULT_CONFIG)
    expect(fs.readdirSync(paths.root).some((name) => name.startsWith('config.json.broken-'))).toBe(true)

    fs.writeFileSync(paths.config, JSON.stringify({ configVersion: 2 }))
    const reset = new ConfigService(paths)
    expect(reset.get().configVersion).toBe(1)
    expect(fs.readdirSync(paths.root).filter((name) => name.startsWith('config.json.broken-')).length).toBe(2)
  })

  it('backs up configuration with an invalid known field', () => {
    const paths = createPaths()
    fs.writeFileSync(paths.config, JSON.stringify({ configVersion: 1, locale: 'fr-FR' }))
    expect(new ConfigService(paths).get()).toMatchObject(DEFAULT_CONFIG)
    expect(fs.readdirSync(paths.root).some((name) => name.startsWith('config.json.broken-'))).toBe(true)
  })

  it('rejects an invalid company read validity period', () => {
    const paths = createPaths()
    fs.writeFileSync(paths.config, JSON.stringify({ configVersion: 1, companyReadValidityMonths: 0 }))
    expect(new ConfigService(paths).get().companyReadValidityMonths).toBe(3)
    expect(fs.readdirSync(paths.root).some((name) => name.startsWith('config.json.broken-'))).toBe(true)
  })
})
