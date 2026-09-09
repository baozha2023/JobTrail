import path from 'node:path'
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio'
import { ConfigService, type AppPaths } from './config'
import { createJobTrailMcpServer } from './mcp/server'
import { createServiceContainer } from './service-container'

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
  }
}

const version = requiredEnvironment('JOBTRAIL_MCP_VERSION')
const paths = appPaths(path.resolve(requiredEnvironment('JOBTRAIL_MCP_ROOT')))
const config = new ConfigService(paths)
const container = createServiceContainer(paths, false)
let handle: StdioServerHandle | undefined
let closing = false

async function close(exitCode = 0): Promise<void> {
  if (closing) return
  closing = true
  try {
    await handle?.close()
  } catch (error) {
    console.error('JobTrail MCP transport close failed', error)
    exitCode = 1
  }
  container.database.close()
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
console.error(`JobTrail MCP ${version} running on stdio`)
