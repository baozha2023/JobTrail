import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { AppServiceError } from './services/errors'

export function updateFreezePath(root: string): string {
  return path.join(root, '.runtime', 'state', 'update-freeze')
}

export function mcpSessionDirectory(root: string): string {
  return path.join(root, '.runtime', 'state', 'mcp-sessions')
}

export function isUpdateFrozen(root: string): boolean {
  return fs.existsSync(updateFreezePath(root))
}

export function assertUpdateWritable(root: string): void {
  if (isUpdateFrozen(root))
    throw new AppServiceError('VALIDATION_ERROR', '应用正在更新，请稍后重试')
}

export async function waitForMcpSessions(root: string): Promise<void> {
  const directory = mcpSessionDirectory(root)
  const deadline = Date.now() + 15_000
  for (;;) {
    const entries = await fsp.readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    let active = false
    for (const entry of entries) {
      const match = /^(\d+)-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.exec(entry)
      if (!match) throw new Error('mcp_session_lease_invalid')
      const pid = Number(match[1])
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('mcp_session_lease_invalid')
      const file = path.join(directory, entry)
      const stat = await fsp.lstat(file).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (!stat) continue
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('mcp_session_lease_invalid')
      try {
        process.kill(pid, 0)
        active = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') await fsp.rm(file, { force: true })
        else active = true
      }
    }
    if (!active) return
    if (Date.now() >= deadline) throw new Error('mcp_sessions_did_not_close')
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}
