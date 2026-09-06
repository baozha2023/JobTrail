import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { AppConfig, CloseBehavior, Locale, ThemeMode } from '../shared/types'

export const DEFAULT_CONFIG: AppConfig = {
  configVersion: 1,
  themeMode: 'system',
  locale: 'zh-CN',
  closeBehavior: 'quit',
  launchAtStartup: false,
  companyReadValidityMonths: 3,
  velopack: {},
  mcp: {
    enabled: false,
    requireWriteConfirmation: true,
  },
}

export interface AppPaths {
  root: string
  config: string
  data: string
  database: string
  resumes: string
}

export function getStorageRoot(): string {
  if (!app.isPackaged) return path.resolve(app.getAppPath())

  const executableDir = path.dirname(process.execPath)
  const base = path.basename(executableDir).toLowerCase() === 'current'
    ? path.dirname(executableDir)
    : executableDir
  return path.resolve(base)
}

export function getAppPaths(): AppPaths {
  const root = getStorageRoot()
  return {
    root,
    config: path.join(root, 'config.json'),
    data: path.join(root, 'data'),
    database: path.join(root, 'data', 'zhiji.db'),
    resumes: path.join(root, 'resumes'),
  }
}

function mergeConfig(value: unknown): AppConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('配置格式无效')
  const source = value as Record<string, unknown>
  if (source.configVersion !== DEFAULT_CONFIG.configVersion) throw new Error('不支持的配置版本')
  const velopack = source.velopack === undefined
    ? {}
    : asObject(source.velopack, 'velopack')
  const mcp = source.mcp === undefined
    ? {}
    : asObject(source.mcp, 'mcp')

  if (source.themeMode !== undefined && source.themeMode !== 'light' && source.themeMode !== 'dark' && source.themeMode !== 'system') throw new Error('主题配置无效')
  if (source.locale !== undefined && source.locale !== 'zh-CN' && source.locale !== 'en-US') throw new Error('语言配置无效')
  if (source.closeBehavior !== undefined && source.closeBehavior !== 'tray' && source.closeBehavior !== 'quit') throw new Error('关闭行为配置无效')
  if (source.launchAtStartup !== undefined && typeof source.launchAtStartup !== 'boolean') throw new Error('开机启动配置无效')
  if (source.companyReadValidityMonths !== undefined && (typeof source.companyReadValidityMonths !== 'number' || !Number.isSafeInteger(source.companyReadValidityMonths) || source.companyReadValidityMonths <= 0)) throw new Error('公司链接已读有效期配置无效')
  if (mcp.enabled !== undefined && typeof mcp.enabled !== 'boolean') throw new Error('MCP 配置无效')
  if (mcp.requireWriteConfirmation !== undefined && typeof mcp.requireWriteConfirmation !== 'boolean') throw new Error('MCP 配置无效')

  const themeMode: ThemeMode = source.themeMode === 'light' || source.themeMode === 'dark' || source.themeMode === 'system'
    ? source.themeMode
    : DEFAULT_CONFIG.themeMode
  const locale: Locale = source.locale === 'zh-CN' || source.locale === 'en-US'
    ? source.locale
    : DEFAULT_CONFIG.locale
  const closeBehavior: CloseBehavior = source.closeBehavior === 'tray' || source.closeBehavior === 'quit'
    ? source.closeBehavior
    : DEFAULT_CONFIG.closeBehavior
  const companyReadValidityMonths = typeof source.companyReadValidityMonths === 'number' && Number.isSafeInteger(source.companyReadValidityMonths) && source.companyReadValidityMonths > 0
    ? source.companyReadValidityMonths
    : DEFAULT_CONFIG.companyReadValidityMonths

  return {
    ...DEFAULT_CONFIG,
    ...source,
    configVersion: DEFAULT_CONFIG.configVersion,
    themeMode,
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
  }
}

function asObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${field}配置无效`)
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

  update(input: Partial<AppConfig>): AppConfig {
    const velopackInput = input.velopack === undefined ? {} : asObject(input.velopack, 'velopack')
    const mcpInput = input.mcp === undefined ? {} : asObject(input.mcp, 'mcp')
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

    try {
      const content = JSON.parse(fs.readFileSync(this.paths.config, 'utf8'))
      return mergeConfig(content)
    } catch {
      const backup = `${this.paths.config}.broken-${Date.now()}`
      fs.copyFileSync(this.paths.config, backup)
      this.write(DEFAULT_CONFIG)
      return structuredClone(DEFAULT_CONFIG)
    }
  }

  private write(config: AppConfig): void {
    fs.mkdirSync(this.paths.root, { recursive: true })
    const temporaryPath = `${this.paths.config}.tmp`
    fs.writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
    fs.renameSync(temporaryPath, this.paths.config)
  }
}
