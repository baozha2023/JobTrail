import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { AppConfig, CloseBehavior, Locale, ThemeMode } from '../shared/types'

const DEFAULT_CONFIG: AppConfig = {
  configVersion: 1,
  themeMode: 'system',
  locale: 'zh-CN',
  closeBehavior: 'quit',
  launchAtStartup: false,
  velopack: {
    githubRepository: '',
    includePrerelease: false,
  },
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
  const base = app.isPackaged ? path.dirname(process.execPath) : app.getAppPath()
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
  const source = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  const velopack = typeof source.velopack === 'object' && source.velopack !== null
    ? source.velopack as Record<string, unknown>
    : {}
  const mcp = typeof source.mcp === 'object' && source.mcp !== null
    ? source.mcp as Record<string, unknown>
    : {}

  const themeMode: ThemeMode = source.themeMode === 'light' || source.themeMode === 'dark' || source.themeMode === 'system'
    ? source.themeMode
    : DEFAULT_CONFIG.themeMode
  const locale: Locale = source.locale === 'zh-CN' || source.locale === 'en-US'
    ? source.locale
    : DEFAULT_CONFIG.locale
  const closeBehavior: CloseBehavior = source.closeBehavior === 'tray' || source.closeBehavior === 'quit'
    ? source.closeBehavior
    : DEFAULT_CONFIG.closeBehavior

  return {
    ...DEFAULT_CONFIG,
    ...source,
    configVersion: typeof source.configVersion === 'number' ? source.configVersion : DEFAULT_CONFIG.configVersion,
    themeMode,
    locale,
    closeBehavior,
    launchAtStartup: source.launchAtStartup === true,
    velopack: {
      ...DEFAULT_CONFIG.velopack,
      ...velopack,
      githubRepository: typeof velopack.githubRepository === 'string' ? velopack.githubRepository : '',
      includePrerelease: velopack.includePrerelease === true,
    },
    mcp: {
      ...DEFAULT_CONFIG.mcp,
      ...mcp,
      enabled: mcp.enabled === true,
      requireWriteConfirmation: mcp.requireWriteConfirmation !== false,
    },
  }
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
    const next = mergeConfig({
      ...this.config,
      ...input,
      velopack: {
        ...this.config.velopack,
        ...(input.velopack ?? {}),
      },
      mcp: {
        ...this.config.mcp,
        ...(input.mcp ?? {}),
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
