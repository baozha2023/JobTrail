import { registerDiagnosticSecrets } from '../shared/diagnostics'
import { CONFIG_V1_DEFAULTS, CONFIG_V1_SCHEMA } from './persistence/config-v1'
import { TARGET_CONFIG_VERSION } from './persistence/versions'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { resolveStorageRoot } from './installation-paths'
import path from 'node:path'
import { z } from 'zod'
import type { AppConfig, AppConfigUpdate } from '../shared/types'
import { AppServiceError } from './services/errors'
import { assertUpdateWritable } from './update-freeze'
import { encryptConfig, decryptConfig } from './config-crypto'

export const DEFAULT_CONFIG: AppConfig = CONFIG_V1_DEFAULTS

export class ConfigLoadError extends Error {
  readonly code: 'CONFIG_INVALID' | 'CONFIG_VERSION_UNSUPPORTED'

  constructor(code: 'CONFIG_INVALID' | 'CONFIG_VERSION_UNSUPPORTED', options?: ErrorOptions) {
    super(code, options)
    this.name = 'ConfigLoadError'
    this.code = code
  }
}

export interface AppPaths {
  root: string
  config: string
  data: string
  database: string
  resumes: string
  chatUploads: string
}

export function getStorageRoot(): string {
  const { app } = require('electron') as typeof import('electron')
  if (!app.isPackaged) return path.resolve(app.getAppPath())

  return resolveStorageRoot(process.execPath)
}

export function getAppPaths(): AppPaths {
  const root = getStorageRoot()
  return {
    root,
    config: path.join(root, 'config.json'),
    data: path.join(root, 'data'),
    database: path.join(root, 'data', 'zhiji.db'),
    resumes: path.join(root, 'resumes'),
    chatUploads: path.join(root, 'chat-uploads'),
  }
}

const settingsSchema = CONFIG_V1_SCHEMA.omit({ configVersion: true })
const versionSchema = z.object({ configVersion: z.number().int().positive() })

function hasDefinedFields(value: object): boolean {
  const values = Object.values(value)
  return values.length > 0 && values.every((item) => item !== undefined)
}
const updateSchema = settingsSchema
  .partial()
  .extend({
    mcp: settingsSchema.shape.mcp
      .partial()
      .refine(hasDefinedFields, 'MCP 配置没有有效更新字段')
      .optional(),
    ai: settingsSchema.shape.ai
      .partial()
      .refine(hasDefinedFields, 'AI 配置没有有效更新字段')
      .optional(),
  })
  .refine(hasDefinedFields, '配置没有有效更新字段')

export function validateConfig(value: unknown): AppConfig {
  const version = versionSchema.safeParse(value)
  if (version.success && version.data.configVersion !== TARGET_CONFIG_VERSION)
    throw new ConfigLoadError('CONFIG_VERSION_UNSUPPORTED')
  const parsed = CONFIG_V1_SCHEMA.safeParse(value)
  if (!parsed.success) throw new ConfigLoadError('CONFIG_INVALID', { cause: parsed.error })
  return parsed.data
}

export class ConfigService {
  private readonly paths: AppPaths
  private config: AppConfig

  constructor(paths = getAppPaths()) {
    this.paths = paths
    this.config = this.load()
  }

  get(): AppConfig {
    registerDiagnosticSecrets([this.config.ai.apiKey])
    return structuredClone(this.config)
  }

  reload(): AppConfig {
    this.config = this.load()
    return this.get()
  }

  update(input: AppConfigUpdate): AppConfig {
    assertUpdateWritable(this.paths.root)
    const parsed = updateSchema.safeParse(input)
    if (!parsed.success)
      throw new AppServiceError('VALIDATION_ERROR', parsed.error.issues[0].message)
    const patch = parsed.data
    const next: AppConfig = {
      ...this.config,
      ...patch,
      mcp: { ...this.config.mcp, ...patch.mcp },
      ai: { ...this.config.ai, ...patch.ai },
    }
    this.write(next)
    this.config = next
    return this.get()
  }

  private load(): AppConfig {
    fs.mkdirSync(this.paths.root, { recursive: true })
    if (!fs.existsSync(this.paths.config)) {
      const config = validateConfig(DEFAULT_CONFIG)
      this.write(config)
      return config
    }

    const contents = fs.readFileSync(this.paths.config, 'utf8')
    try {
      return validateConfig(decryptConfig(contents))
    } catch (error) {
      if (error instanceof ConfigLoadError) throw error
      throw new ConfigLoadError('CONFIG_INVALID', { cause: error })
    }
  }

  private write(config: AppConfig): void {
    fs.mkdirSync(this.paths.root, { recursive: true })
    const temporaryPath = `${this.paths.config}.${randomUUID()}.tmp`
    try {
      fs.writeFileSync(temporaryPath, encryptConfig(config), {
        encoding: 'utf8',
        flag: 'wx',
      })
      fs.renameSync(temporaryPath, this.paths.config)
    } finally {
      fs.rmSync(temporaryPath, { force: true })
    }
  }
}
