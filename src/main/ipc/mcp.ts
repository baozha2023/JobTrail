import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { McpConnectionInfo } from '../../shared/types'
import { getStorageRoot } from '../config'
import { ROOT_LAUNCHER } from '../installation-paths'
import { AppServiceError } from '../services/errors'
import { registerChannel } from './register-channel'

export function getMcpConnectionInfo(): McpConnectionInfo {
  const root = getStorageRoot()
  const launcher = path.join(root, ROOT_LAUNCHER)
  if (app.isPackaged) {
    try {
      const metadata = fs.lstatSync(launcher)
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('invalid launcher')
    } catch {
      throw new AppServiceError('INTERNAL_ERROR', 'MCP 根启动器不可用')
    }
    return { command: launcher, args: ['--mcp'] }
  }
  return {
    command: process.execPath,
    args: [path.join(app.getAppPath(), 'out', 'main', 'mcp-node.js')],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      JOBTRAIL_MCP_ROOT: root,
      JOBTRAIL_MCP_VERSION: app.getVersion(),
    },
  }
}

export function registerMcpIpc(): void {
  registerChannel('mcp:get-connection-info', () => getMcpConnectionInfo())
}
