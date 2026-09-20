import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { resolveStorageRoot } from './installation-paths'
import path from 'node:path'
import type { AppConfig, CloseBehavior, Locale, StatusFlowTheme, ThemeMode } from '../shared/types'

export const DEFAULT_CONFIG: AppConfig = {
  configVersion: 1,
  themeMode: 'system',
  statusFlowTheme: 'violet',
  locale: 'zh-CN',
  closeBehavior: 'quit',
  launchAtStartup: false,
  companyReadValidityMonths: 3,
  velopack: {},
  mcp: {
    enabled: false,
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

function mergeConfig(value: unknown): AppConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('配置格式无效')
  const source = value as Record<string, unknown>
  if (source.configVersion !== DEFAULT_CONFIG.configVersion) throw new Error('不支持的配置版本')
  const velopack = source.velopack === undefined ? {} : asObject(source.velopack, 'velopack')
  const mcp = source.mcp === undefined ? {} : asObject(source.mcp, 'mcp')
  const ai = source.ai === undefined ? {} : asObject(source.ai, 'ai')
  if (
    Object.keys(ai).some(
      (key) =>
        ![
          'baseUrl',
          'modelId',
          'apiKey',
          'multimodal',
          'contextWindowK',
          'compactThresholdPercent',
        ].includes(key),
    )
  )
    throw new Error('AI 配置包含未知字段')

  if (
    source.themeMode !== undefined &&
    source.themeMode !== 'light' &&
    source.themeMode !== 'dark' &&
    source.themeMode !== 'system'
  )
    throw new Error('主题配置无效')
  if (
    source.statusFlowTheme !== undefined &&
    source.statusFlowTheme !== 'violet' &&
    source.statusFlowTheme !== 'ocean' &&
    source.statusFlowTheme !== 'gold'
  )
    throw new Error('状态流转图主题配置无效')
  if (source.locale !== undefined && source.locale !== 'zh-CN' && source.locale !== 'en-US')
    throw new Error('语言配置无效')
  if (
    source.closeBehavior !== undefined &&
    source.closeBehavior !== 'tray' &&
    source.closeBehavior !== 'quit'
  )
    throw new Error('关闭行为配置无效')
  if (source.launchAtStartup !== undefined && typeof source.launchAtStartup !== 'boolean')
    throw new Error('开机启动配置无效')
  if (
    source.companyReadValidityMonths !== undefined &&
    (typeof source.companyReadValidityMonths !== 'number' ||
      !Number.isSafeInteger(source.companyReadValidityMonths) ||
      source.companyReadValidityMonths <= 0)
  )
    throw new Error('公司链接已读有效期配置无效')
  if (mcp.enabled !== undefined && typeof mcp.enabled !== 'boolean') throw new Error('MCP 配置无效')
  if (ai.baseUrl !== undefined && typeof ai.baseUrl !== 'string')
    throw new Error('AI Base URL 无效')
  if (ai.modelId !== undefined && typeof ai.modelId !== 'string') throw new Error('AI 模型 ID 无效')
  if (ai.apiKey !== undefined && (typeof ai.apiKey !== 'string' || ai.apiKey.length > 8192))
    throw new Error('AI API Key 无效')
  if (ai.multimodal !== undefined && typeof ai.multimodal !== 'boolean')
    throw new Error('AI 多模态配置无效')
  if (
    ai.contextWindowK !== undefined &&
    (!Number.isSafeInteger(ai.contextWindowK) ||
      (ai.contextWindowK as number) < 8 ||
      (ai.contextWindowK as number) > 2048)
  )
    throw new Error('AI 上下文窗口须为 8–2048k')
  if (
    ai.compactThresholdPercent !== undefined &&
    (!Number.isSafeInteger(ai.compactThresholdPercent) ||
      (ai.compactThresholdPercent as number) < 50 ||
      (ai.compactThresholdPercent as number) > 90)
  )
    throw new Error('AI 自动压缩阈值须为 50%–90%')
  if (ai.baseUrl !== undefined) {
    const endpoint = new URL(ai.baseUrl)
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
    if (
      (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback)) ||
      endpoint.username ||
      endpoint.password
    )
      throw new Error('AI Base URL 必须是 HTTPS 或本机回环 HTTP 地址')
  }
  if (
    mcp.requireWriteConfirmation !== undefined &&
    typeof mcp.requireWriteConfirmation !== 'boolean'
  )
    throw new Error('MCP 配置无效')

  const themeMode: ThemeMode =
    source.themeMode === 'light' || source.themeMode === 'dark' || source.themeMode === 'system'
      ? source.themeMode
      : DEFAULT_CONFIG.themeMode
  const statusFlowTheme: StatusFlowTheme =
    source.statusFlowTheme === 'violet' ||
    source.statusFlowTheme === 'ocean' ||
    source.statusFlowTheme === 'gold'
      ? source.statusFlowTheme
      : DEFAULT_CONFIG.statusFlowTheme
  const locale: Locale =
    source.locale === 'zh-CN' || source.locale === 'en-US' ? source.locale : DEFAULT_CONFIG.locale
  const closeBehavior: CloseBehavior =
    source.closeBehavior === 'tray' || source.closeBehavior === 'quit'
      ? source.closeBehavior
      : DEFAULT_CONFIG.closeBehavior
  const companyReadValidityMonths =
    typeof source.companyReadValidityMonths === 'number' &&
    Number.isSafeInteger(source.companyReadValidityMonths) &&
    source.companyReadValidityMonths > 0
      ? source.companyReadValidityMonths
      : DEFAULT_CONFIG.companyReadValidityMonths

  return {
    ...DEFAULT_CONFIG,
    ...source,
    configVersion: DEFAULT_CONFIG.configVersion,
    themeMode,
    statusFlowTheme,
    locale,
    closeBehavior,
    launchAtStartup: source.launchAtStartup === true,
    companyReadValidityMonths,
    velopack: {
      ...DEFAULT_CONFIG.velopack,
      ...velopack,
    },
    mcp: {
      ...DEFAULT_CONFIG.mcp,
      ...mcp,
      enabled: mcp.enabled === true,
      requireWriteConfirmation: mcp.requireWriteConfirmation !== false,
    },
    ai: {
      baseUrl: typeof ai.baseUrl === 'string' ? ai.baseUrl.trim() : DEFAULT_CONFIG.ai.baseUrl,
      modelId: typeof ai.modelId === 'string' ? ai.modelId.trim() : DEFAULT_CONFIG.ai.modelId,
      apiKey: typeof ai.apiKey === 'string' ? ai.apiKey.trim() : DEFAULT_CONFIG.ai.apiKey,
      multimodal: ai.multimodal === true,
      contextWindowK:
        typeof ai.contextWindowK === 'number'
          ? ai.contextWindowK
          : DEFAULT_CONFIG.ai.contextWindowK,
      compactThresholdPercent:
        typeof ai.compactThresholdPercent === 'number'
          ? ai.compactThresholdPercent
          : DEFAULT_CONFIG.ai.compactThresholdPercent,
    },
  }
}

function asObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`${field}配置无效`)
  return value as Record<string, unknown>
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

  update(input: Partial<AppConfig>): AppConfig {
    const velopackInput = input.velopack === undefined ? {} : asObject(input.velopack, 'velopack')
    const mcpInput = input.mcp === undefined ? {} : asObject(input.mcp, 'mcp')
    const aiInput = input.ai === undefined ? {} : asObject(input.ai, 'ai')
    const next = mergeConfig({
      ...this.config,
      ...input,
      velopack: {
        ...this.config.velopack,
        ...velopackInput,
      },
      mcp: {
        ...this.config.mcp,
        ...mcpInput,
      },
      ai: {
        ...this.config.ai,
        ...aiInput,
      },
    })
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
      const content = JSON.parse(contents)
      return mergeConfig(content)
    } catch {
      const backup = `${this.paths.config}.broken-${randomUUID()}`
      fs.copyFileSync(this.paths.config, backup)
      this.write(DEFAULT_CONFIG)
      return structuredClone(DEFAULT_CONFIG)
    }
  }

  private write(config: AppConfig): void {
    fs.mkdirSync(this.paths.root, { recursive: true })
    const temporaryPath = `${this.paths.config}.${randomUUID()}.tmp`
    try {
      fs.writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      })
      fs.renameSync(temporaryPath, this.paths.config)
    } finally {
      fs.rmSync(temporaryPath, { force: true })
    }
  }
}
