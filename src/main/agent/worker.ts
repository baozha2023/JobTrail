import { ConfigService } from '../config'
import { createServiceContainer } from '../service-container'
import { errorShape } from '../services/errors'
import { AgentService } from './service'
import type { AgentWorkerRequest, AgentWorkerResponse } from './worker-protocol'

let agent: AgentService | undefined
let database: ReturnType<typeof createServiceContainer>['database'] | undefined
let activeJobId: string | undefined
let activeConversationId: string | undefined
const parentPort = process.parentPort
if (!parentPort) throw new Error('智能体执行进程缺少父进程通信端口')

function post(message: AgentWorkerResponse): void {
  parentPort.postMessage(message)
}

async function run(request: Extract<AgentWorkerRequest, { kind: 'run' }>): Promise<void> {
  if (!agent || activeJobId) {
    post({ kind: 'finished', jobId: request.jobId, errorCode: 'AGENT_WORKER_UNAVAILABLE' })
    return
  }
  activeJobId = request.jobId
  activeConversationId = request.conversationId
  try {
    if (request.operation === 'send')
      await agent.send(
        request.conversationId,
        request.parts ?? [],
        request.attachmentIds ?? [],
        request.jobId,
      )
    else if (request.operation === 'compact') await agent.compact(request.conversationId)
    else await agent.resume(request.conversationId, request.answer ?? [])
    post({ kind: 'finished', jobId: request.jobId })
  } catch (cause) {
    post({
      kind: 'finished',
      jobId: request.jobId,
      errorCode: errorShape(cause).code,
    })
  } finally {
    activeJobId = undefined
    activeConversationId = undefined
  }
}

parentPort.on('message', (message) => {
  const request = message.data as AgentWorkerRequest
  if (request.kind === 'init') {
    try {
      const config = new ConfigService(request.paths)
      const container = createServiceContainer(request.paths, false, false)
      database = container.database
      agent = new AgentService(
        request.paths,
        container.database.db,
        config,
        container.services,
        () => request.mcpConnection,
        (event) => {
          if (activeJobId) post({ kind: 'event', jobId: activeJobId, event })
        },
        request.runtime,
      )
      post({ kind: 'ready' })
    } catch (cause) {
      post({
        kind: 'init-error',
        error: cause instanceof Error ? cause.message : String(cause),
      })
    }
  } else if (request.kind === 'run') void run(request)
  else if (request.kind === 'cancel') {
    if (activeJobId === request.jobId && activeConversationId) agent?.cancel(activeConversationId)
  } else if (request.kind === 'close') {
    void (async () => {
      try {
        await agent?.close()
      } finally {
        database?.close()
        post({ kind: 'closed' })
        process.exit(0)
      }
    })()
  }
})
