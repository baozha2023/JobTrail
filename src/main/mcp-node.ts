import path from 'node:path'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio'
import { ConfigLoadError, ConfigService, type AppPaths } from './config'
import { createJobTrailMcpServer } from './mcp/server'
import { createServiceContainer } from './service-container'
import { DatabaseVersionError, INCOMPATIBLE_DATA_EXIT_CODE } from './database'
import { mcpSessionDirectory, updateFreezePath } from './update-freeze'

function requiredEnvironment(name: 'JOBTRAIL_MCP_ROOT' | 'JOBTRAIL_MCP_VERSION'): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing required MCP environment: ${name}`)
  return value
}

function appPaths(root: string): AppPaths {
  return {
    root,
    config: path.join(root, 'config.json'),
    data: path.join(root, 'data'),
    database: path.join(root, 'data', 'zhiji.db'),
    resumes: path.join(root, 'resumes'),
    chatUploads: path.join(root, 'chat-uploads'),
  }
}

const version = requiredEnvironment('JOBTRAIL_MCP_VERSION')
const paths = appPaths(path.resolve(requiredEnvironment('JOBTRAIL_MCP_ROOT')))
const freezePath = updateFreezePath(paths.root)
if (fs.existsSync(freezePath)) process.exit(75)
const leaseDirectory = mcpSessionDirectory(paths.root)
fs.mkdirSync(leaseDirectory, { recursive: true })
const leasePath = path.join(leaseDirectory, `${process.pid}-${randomUUID()}`)
fs.writeFileSync(leasePath, '', { flag: 'wx' })
process.once('exit', () => fs.rmSync(leasePath, { force: true }))
if (fs.existsSync(freezePath)) process.exit(75)
let config: ConfigService
let container: ReturnType<typeof createServiceContainer>
try {
  config = new ConfigService(paths)
  container = createServiceContainer(paths, false)
} catch (error) {
  if (error instanceof ConfigLoadError || error instanceof DatabaseVersionError)
    process.exit(INCOMPATIBLE_DATA_EXIT_CODE)
  throw error
}
let handle: StdioServerHandle | undefined
let closing = false
let freezeTimer: ReturnType<typeof setInterval> | undefined

async function close(exitCode = 0): Promise<void> {
  if (closing) return
  closing = true
  if (freezeTimer) clearInterval(freezeTimer)
  try {
    await handle?.close()
  } catch (error) {
    console.error('JobTrail MCP transport close failed', error)
    exitCode = 1
  }
  try {
    await container.services.web.dispose()
  } catch (error) {
    console.error('JobTrail web session close failed', error)
    exitCode = 1
  }
  container.database.close()
  fs.rmSync(leasePath, { force: true })
  process.exitCode = exitCode
}

try {
  handle = serveStdio(
    () =>
      createJobTrailMcpServer({
        version,
        unitOfWork: container.unitOfWork,
        services: container.services,
        config,
      }),
    {
      legacy: 'serve',
      onerror: (error) => console.error('JobTrail MCP protocol error', error),
    },
  )
} catch (error) {
  container.database.close()
  throw error
}

process.stdin.once('end', () => void close(0))
process.once('SIGINT', () => void close(0))
process.once('SIGTERM', () => void close(0))
process.once('uncaughtException', (error) => {
  console.error('JobTrail MCP uncaught exception', error)
  void close(1)
})
process.once('unhandledRejection', (error) => {
  console.error('JobTrail MCP unhandled rejection', error)
  void close(1)
})
freezeTimer = setInterval(() => {
  if (fs.existsSync(freezePath)) void close(75)
}, 500)
freezeTimer.unref?.()
console.error(`JobTrail MCP ${version} running on stdio`)
