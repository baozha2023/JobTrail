import type {
  AgentDraftPart,
  AgentEvent,
  AgentEventErrorCode,
  McpConnectionInfo,
} from '../../shared/types'
import type { AppPaths } from '../config'
import type { AgentRuntimeInfo } from './runtime'

export type AgentWorkerRequest =
  | {
      kind: 'init'
      paths: AppPaths
      runtime: AgentRuntimeInfo
      mcpConnection: McpConnectionInfo
    }
  | {
      kind: 'run'
      jobId: string
      conversationId: string
      operation: 'send' | 'compact' | 'resume'
      parts?: AgentDraftPart[]
      attachmentIds?: string[]
      answer?: string[] | boolean
    }
  | { kind: 'cancel'; jobId: string }
  | { kind: 'close' }

export type AgentWorkerResponse =
  | { kind: 'ready' }
  | { kind: 'event'; jobId: string; event: AgentEvent }
  | { kind: 'finished'; jobId: string; errorCode?: AgentEventErrorCode }
  | { kind: 'init-error'; errorCode: AgentEventErrorCode }
  | { kind: 'closed' }
