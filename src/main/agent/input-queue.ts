import { AppServiceError } from '../services/errors'

export interface QueuedInput {
  jobId: string
  origin: 'internal' | 'external'
  editing: boolean
}

/** Main owns waiting inputs; selection reserves an execution slot, including its initialization. */
export class AgentInputQueue<T extends QueuedInput> {
  readonly internal: T[] = []
  readonly external: T[] = []
  readonly failed: T[] = []
  blocked: T | null = null
  revision = 0

  push(item: T): void {
    if (item.origin === 'external' && this.external.length >= 3)
      throw new AppServiceError('AGENT_QUEUE_FULL', '最多排队三条消息')
    this[item.origin].push(item)
  }

  peek(): T | undefined {
    if (this.blocked) return undefined
    return this.internal[0] ?? (this.external[0]?.editing ? undefined : this.external[0])
  }

  take(): T | undefined {
    const item = this.peek()
    if (item) this[item.origin].shift()
    return item
  }

  find(id: string): T | undefined {
    return [...this.internal, ...this.external, ...this.failed].find((item) => item.jobId === id)
  }

  remove(item: T): void {
    for (const items of [this.internal, this.external, this.failed]) {
      const index = items.indexOf(item)
      if (index >= 0) items.splice(index, 1)
    }
  }

  all(): T[] {
    return [
      ...this.internal,
      ...this.external,
      ...this.failed,
      ...(this.blocked ? [this.blocked] : []),
    ]
  }
}
