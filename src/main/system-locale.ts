import type { AppConfig } from '../shared/types'
import { captureError } from './diagnostics'

function readSystemLanguages(): string[] {
  // Only desktop Main has Electron's system UI language API; headless entries use Chinese.
  if (process.type !== 'browser') return []
  const { app } = require('electron') as typeof import('electron')
  return app.getPreferredSystemLanguages()
}

export function detectInitialLocale(readLanguages = readSystemLanguages): AppConfig['locale'] {
  try {
    const primary = readLanguages()[0]
    return primary && /^en(?:-|$)/i.test(primary) ? 'en-US' : 'zh-CN'
  } catch (error) {
    captureError(error, { operation: 'config.detect-locale' })
    return 'zh-CN'
  }
}
