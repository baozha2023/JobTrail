import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppPaths } from '../src/main/config'
import { ConfigLoadError, ConfigService, DEFAULT_CONFIG } from '../src/main/config'
import { updateFreezePath } from '../src/main/update-freeze'

describe('config service', () => {
  const roots: string[] = []
  afterEach(() => {
    vi.restoreAllMocks()
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  })
  function createPaths(): AppPaths {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zhiji-config-'))
    roots.push(root)
    return {
      root,
      config: path.join(root, 'config.json'),
      data: path.join(root, 'data'),
      database: path.join(root, 'data', 'zhiji.db'),
      resumes: path.join(root, 'resumes'),
      chatUploads: path.join(root, 'chat-uploads'),
    }
  }

  it('writes defaults atomically and preserves unknown fields', () => {
    const paths = createPaths()
    const config = new ConfigService(paths)
    expect(config.get()).toMatchObject(DEFAULT_CONFIG)
    expect(config.get().companyReadValidityMonths).toBe(3)
    expect(config.get().ai.contextWindowK).toBe(256)
    expect(config.get().ai.compactThresholdPercent).toBe(80)
    fs.writeFileSync(
      paths.config,
      JSON.stringify({ ...config.get(), customExtension: { enabled: true } }),
    )
    const loaded = new ConfigService(paths)
    expect(loaded.get().customExtension).toEqual({ enabled: true })
    expect(loaded.update({ locale: 'en-US' }).locale).toBe('en-US')
    expect(loaded.update({ companyReadValidityMonths: 6 }).companyReadValidityMonths).toBe(6)
    expect(loaded.update({ statusFlowTheme: 'ocean' }).statusFlowTheme).toBe('ocean')
    expect(new ConfigService(paths).get().statusFlowTheme).toBe('ocean')
    expect(JSON.parse(fs.readFileSync(paths.config, 'utf8')).customExtension).toEqual({
      enabled: true,
    })
  })

  it('preserves config while an update snapshot is being prepared', () => {
    const paths = createPaths()
    const config = new ConfigService(paths)
    const original = fs.readFileSync(paths.config)
    const freeze = updateFreezePath(paths.root)
    fs.mkdirSync(path.dirname(freeze), { recursive: true })
    fs.writeFileSync(freeze, '')
    expect(() => config.update({ locale: 'en-US' })).toThrow('应用正在更新')
    expect(fs.readFileSync(paths.config)).toEqual(original)
  })

  it('preserves malformed and unsupported-version config files without resetting settings', () => {
    const paths = createPaths()
    const malformed = '{ broken'
    fs.writeFileSync(paths.config, malformed)
    expect(() => new ConfigService(paths)).toThrow(ConfigLoadError)
    expect(fs.readFileSync(paths.config, 'utf8')).toBe(malformed)
    expect(fs.readdirSync(paths.root)).toEqual(['config.json'])

    const future = JSON.stringify({ configVersion: 2, ai: { apiKey: 'preserve-me' } })
    fs.writeFileSync(paths.config, future)
    expect(() => new ConfigService(paths)).toThrow('CONFIG_VERSION_UNSUPPORTED')
    expect(fs.readFileSync(paths.config, 'utf8')).toBe(future)
    expect(fs.readdirSync(paths.root)).toEqual(['config.json'])
  })

  it('preserves configuration with an invalid known field', () => {
    const paths = createPaths()
    const invalid = JSON.stringify({ configVersion: 1, locale: 'fr-FR' })
    fs.writeFileSync(paths.config, invalid)
    expect(() => new ConfigService(paths)).toThrow('CONFIG_INVALID')
    expect(fs.readFileSync(paths.config, 'utf8')).toBe(invalid)
  })

  it('rejects an invalid company read validity period', () => {
    const paths = createPaths()
    fs.writeFileSync(
      paths.config,
      JSON.stringify({ configVersion: 1, companyReadValidityMonths: 0 }),
    )
    const original = fs.readFileSync(paths.config, 'utf8')
    expect(() => new ConfigService(paths)).toThrow('CONFIG_INVALID')
    expect(fs.readFileSync(paths.config, 'utf8')).toBe(original)
  })
  it('rejects an invalid status flow theme', () => {
    const paths = createPaths()
    fs.writeFileSync(paths.config, JSON.stringify({ ...DEFAULT_CONFIG, statusFlowTheme: 'neon' }))
    const original = fs.readFileSync(paths.config, 'utf8')
    expect(() => new ConfigService(paths)).toThrow('CONFIG_INVALID')
    expect(fs.readFileSync(paths.config, 'utf8')).toBe(original)
  })
  it('accepts only HTTPS or loopback AI endpoints and stores the API key in config', () => {
    const paths = createPaths()
    const config = new ConfigService(paths)
    expect(() => config.update({ ai: { ...config.get().ai, contextWindowK: 4 } })).toThrow(
      '上下文窗口',
    )
    expect(() =>
      config.update({ ai: { ...config.get().ai, compactThresholdPercent: 95 } }),
    ).toThrow('压缩阈值')
    expect(() =>
      config.update({
        ai: {
          baseUrl: 'http://example.com/v1',
          modelId: 'm',
          apiKey: '',
          multimodal: false,
          contextWindowK: 256,
          compactThresholdPercent: 80,
        },
      }),
    ).toThrow()
    expect(() =>
      config.update({
        ai: {
          baseUrl: 'https://user:pass@example.com/v1',
          modelId: 'm',
          apiKey: '',
          multimodal: false,
          contextWindowK: 256,
          compactThresholdPercent: 80,
        },
      }),
    ).toThrow()
    const local = config.update({
      ai: {
        baseUrl: 'http://127.0.0.1:1234/v1',
        modelId: 'm',
        apiKey: 'sk-local',
        multimodal: true,
        contextWindowK: 256,
        compactThresholdPercent: 80,
      },
    })
    expect(local.ai.multimodal).toBe(true)
    expect(local.ai.apiKey).toBe('sk-local')
    expect(JSON.parse(fs.readFileSync(paths.config, 'utf8')).ai.apiKey).toBe('sk-local')
  })
  it('preserves configuration on filesystem read failure', () => {
    const paths = createPaths()
    fs.writeFileSync(paths.config, JSON.stringify(DEFAULT_CONFIG))
    const read = vi.spyOn(fs, 'readFileSync').mockImplementationOnce(() => {
      throw new Error('access denied')
    })
    expect(() => new ConfigService(paths)).toThrow('access denied')
    read.mockRestore()
    expect(fs.readdirSync(paths.root)).toEqual(['config.json'])
    expect(JSON.parse(fs.readFileSync(paths.config, 'utf8'))).toEqual(DEFAULT_CONFIG)
  })
  it('keeps memory and disk unchanged when atomic replacement fails', () => {
    const paths = createPaths()
    const config = new ConfigService(paths)
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('locked')
    })
    expect(() => config.update({ locale: 'en-US' })).toThrow('locked')
    expect(config.get().locale).toBe('zh-CN')
    expect(JSON.parse(fs.readFileSync(paths.config, 'utf8')).locale).toBe('zh-CN')
    expect(fs.readdirSync(paths.root)).toEqual(['config.json'])
  })
})
