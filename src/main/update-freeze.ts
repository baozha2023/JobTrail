import fs from 'node:fs'
import path from 'node:path'
import { AppServiceError } from './services/errors'

export function updateFreezePath(root: string): string {
  return path.join(root, '.runtime', 'state', 'update-freeze')
}

export function mcpSessionDirectory(root: string): string {
  return path.join(root, '.runtime', 'state', 'mcp-sessions')
}

export function assertUpdateWritable(root: string): void {
  if (fs.existsSync(updateFreezePath(root)))
    throw new AppServiceError('VALIDATION_ERROR', '应用正在更新，请稍后重试')
}
