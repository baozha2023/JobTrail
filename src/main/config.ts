import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { resolveStorageRoot } from './installation-paths'
import path from 'node:path'
import { z } from 'zod'
import type { AppConfig, AppConfigUpdate } from '../shared/types'
import { AppServiceError } from './services/errors'
import { assertUpdateWritable } from './update-freeze'
import { encryptConfig, decryptConfig } from './config-crypto'

export const DEFAULT_CONFIG: AppConfig = {
  configVersion: 1,
  themeMode: 'system',
  statusFlowTheme: 'violet',
  locale: 'zh-CN',
  closeBehavior: 'quit',
  launchAtStartup: false,
  companyReadValidityMonths: 3,
  mcp: {
    enabled: true,
    requireWriteConfirmation: true,
  },
  ai: {
    baseUrl: 'https://api.openai.com/v1',
    modelId: '',
    apiKey: '',
    multimodal: false,
    contextWindowK: 256,
    compactThresholdPercent: 80,
  },
}

export class ConfigLoadError extends Error {
  readonly code: 'CONFIG_INVALID' | 'CONFIG_VERSION_UNSUPPORTED'

  constructor(code: 'CONFIG_INVALID' | 'CONFIG_VERSION_UNSUPPORTED') {
    super(code)
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

const aiSchema = z.strictObject({
  baseUrl: z
    .string()
    .trim()
    .refine((value) => {
      try {
        const endpoint = new URL(value)
        const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
        return (
          (endpoint.protocol === 'https:' || (endpoint.protocol === 'http:' && loopback)) &&
          !endpoint.username &&
          !endpoint.password
        )
      } catch {
        return false
      }
    }, 'AI Base URL 必须是 HTTPS 或本机回环 HTTP 地址'),
  modelId: z.string().trim(),
  apiKey: z.string().trim().max(8192, 'AI API Key 无效'),
  multimodal: z.boolean(),
  contextWindowK: z
    .number()
    .int()
    .min(8, 'AI 上下文窗口须为 8–2048k')
    .max(2048, 'AI 上下文窗口须为 8–2048k'),
  compactThresholdPercent: z
    .number()
    .int()
    .min(50, 'AI 自动压缩阈值须为 50%–90%')
    .max(90, 'AI 自动压缩阈值须为 50%–90%'),
})
const mcpSchema = z.strictObject({
  enabled: z.boolean(),
  requireWriteConfirmation: z.boolean(),
})
const settingsSchema = z.strictObject({
  themeMode: z.enum(['light', 'dark', 'system']),
  statusFlowTheme: z.enum(['violet', 'ocean', 'gold']),
  locale: z.enum(['zh-CN', 'en-US']),
  closeBehavior: z.enum(['tray', 'quit']),
  launchAtStartup: z.boolean(),
  companyReadValidityMonths: z.number().int().positive(),
  mcp: mcpSchema,
  ai: aiSchema,
})
const configSchema = settingsSchema.extend({
  configVersion: z.literal(DEFAULT_CONFIG.configVersion),
})
const versionSchema = z.object({ configVersion: z.number().int().positive() })

function hasDefinedFields(value: object): boolean {
  const values = Object.values(value)
  return values.length > 0 && values.every((item) => item !== undefined)
}
const updateSchema = settingsSchema
  .partial()
  .extend({
    mcp: mcpSchema.partial().refine(hasDefinedFields, 'MCP 配置没有有效更新字段').optional(),
    ai: aiSchema.partial().refine(hasDefinedFields, 'AI 配置没有有效更新字段').optional(),
  })
  .refine(hasDefinedFields, '配置没有有效更新字段')

export function validateConfig(value: unknown): AppConfig {
  const version = versionSchema.safeParse(value)
  if (version.success && version.data.configVersion !== DEFAULT_CONFIG.configVersion)
    throw new ConfigLoadError('CONFIG_VERSION_UNSUPPORTED')
  const parsed = configSchema.safeParse(value)
  if (!parsed.success) throw new ConfigLoadError('CONFIG_INVALID')
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
      this.write(DEFAULT_CONFIG)
      return structuredClone(DEFAULT_CONFIG)
    }

    const contents = fs.readFileSync(this.paths.config, 'utf8')
    try {
      return validateConfig(decryptConfig(contents))
    } catch (error) {
      if (error instanceof ConfigLoadError) throw error
      throw new ConfigLoadError('CONFIG_INVALID')
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
