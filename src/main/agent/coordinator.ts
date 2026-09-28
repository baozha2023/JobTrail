import path from 'node:path'
import { app, utilityProcess, type UtilityProcess } from 'electron'
import type {
  AgentAttachment,
  AgentConversation,
  AgentDraftPart,
  AgentEvent,
  AgentEventErrorCode,
  AgentHistory,
  AgentJobReceipt,
  AgentJobSnapshot,
  AppConfig,
  McpConnectionInfo,
} from '../../shared/types'
import type { AppPaths } from '../config'
import { AppServiceError } from '../services/errors'
import { AgentService } from './service'
import type { AgentRuntimeInfo } from './runtime'
import type { AgentWorkerRequest, AgentWorkerResponse } from './worker-protocol'

type JobOperation = 'send' | 'compact' | 'resume'
interface Job {
  jobId: string
  conversationId: string
  operation: JobOperation
  parts?: AgentDraftPart[]
  attachmentIds?: string[]
  answer?: string[] | boolean
  status: 'queued' | 'running'
  sequence: number
  liveText: string
  pendingToken: string
  tokenTimer?: ReturnType<typeof setTimeout>
  cancelTimer?: ReturnType<typeof setTimeout>
  slot?: WorkerSlot
  pendingSeen: boolean
  cancelRequested: boolean
  workerErrorCode?: AgentEventErrorCode
  finished: boolean
}
interface WorkerSlot {
  process: UtilityProcess
  ready: boolean
  job?: Job
  closed: boolean
}

const MAX_ACTIVE_JOBS = 3
const TOKEN_FLUSH_MS = 50
const MAX_WORKER_START_FAILURES = 3

export class AgentCoordinator {
  private readonly queue: Job[] = []
  private readonly jobsByConversation = new Map<string, Job>()
  private readonly receipts = new Map<string, AgentJobReceipt>()
  private readonly accepting = new Map<
    string,
    { conversationId: string; promise: Promise<AgentJobReceipt> }
  >()
  private readonly slots: WorkerSlot[] = []
  private suspended = false
  private closing = false
  private workerStartFailures = 0

  constructor(
    private readonly agent: AgentService,
    private readonly paths: AppPaths,
    private readonly mcpConnection: () => McpConnectionInfo,
    private readonly emit: (event: AgentEvent) => void,
  ) {}

  list(): AgentConversation[] {
    return this.agent.list().map((conversation) => {
      const job = this.jobsByConversation.get(conversation.id)
      return {
        ...conversation,
        activity: job?.status ?? 'idle',
        queuePosition: job?.status === 'queued' ? this.queue.indexOf(job) + 1 : undefined,
      }
    })
  }

  create(): AgentConversation {
    return this.agent.create()
  }

  rename(id: string, title: string): AgentConversation {
    return this.agent.rename(id, title)
  }

  async history(id: string): Promise<AgentHistory> {
    const history = await this.agent.history(id)
    const job = this.jobsByConversation.get(id)
    const includeInput =
      !!job &&
      job.operation === 'send' &&
      !history.messages.some((message) => message.role === 'user' && message.id === job.jobId)
    return {
      ...history,
      running: !!job,
      job: job ? this.snapshot(job, includeInput) : null,
    }
  }

  async delete(id: string): Promise<void> {
    this.assertConversationIdle(id)
    await this.agent.delete(id)
  }

  upload(id: string, sourcePath: string): AgentAttachment {
    return this.agent.upload(id, sourcePath)
  }

  uploadBytes(id: string, name: string, mimeType: string, bytes: Uint8Array): AgentAttachment {
    return this.agent.uploadBytes(id, name, mimeType, bytes)
  }

  preview(id: string, attachmentId: string): string | null {
    return this.agent.preview(id, attachmentId)
  }

  getAttachmentPath(id: string, attachmentId: string): string {
    return this.agent.getAttachmentPath(id, attachmentId)
  }

  async removeUpload(id: string, attachmentId: string): Promise<void> {
    this.assertConversationIdle(id)
    await this.agent.removeUpload(id, attachmentId)
  }

  saveSettings(ai: AppConfig['ai']): AppConfig {
    return this.agent.saveSettings(ai)
  }

  send(
    conversationId: string,
    parts: AgentDraftPart[],
    attachmentIds: string[],
    jobId: string,
  ): Promise<AgentJobReceipt> {
    return this.accept(
      conversationId,
      jobId,
      'send',
      () => this.agent.validateSend(conversationId, parts, attachmentIds),
      { parts, attachmentIds },
    )
  }

  compact(conversationId: string, jobId: string): Promise<AgentJobReceipt> {
    return this.accept(conversationId, jobId, 'compact', () =>
      this.agent.validateCompact(conversationId),
    )
  }

  resume(
    conversationId: string,
    answer: string[] | boolean,
    jobId: string,
  ): Promise<AgentJobReceipt> {
    return this.accept(
      conversationId,
      jobId,
      'resume',
      () => this.agent.validateResume(conversationId, answer),
      { answer },
    )
  }

  private accept(
    conversationId: string,
    jobId: string,
    operation: JobOperation,
    validate: () => Promise<void>,
    payload: Partial<Pick<Job, 'parts' | 'attachmentIds' | 'answer'>> = {},
  ): Promise<AgentJobReceipt> {
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(jobId))
      return Promise.reject(new AppServiceError('VALIDATION_ERROR', '任务 ID 无效'))
    const accepted = this.receipts.get(jobId)
    if (accepted) {
      if (accepted.conversationId !== conversationId)
        return Promise.reject(new AppServiceError('VALIDATION_ERROR', '任务 ID 已被使用'))
      return Promise.resolve(accepted)
    }
    const pending = this.accepting.get(jobId)
    if (pending) {
      if (pending.conversationId !== conversationId)
        return Promise.reject(new AppServiceError('VALIDATION_ERROR', '任务 ID 已被使用'))
      return pending.promise
    }
    if (this.closing || this.suspended)
      return Promise.reject(new AppServiceError('VALIDATION_ERROR', '智能体暂不可用'))
    if (this.jobsByConversation.has(conversationId))
      return Promise.reject(new AppServiceError('VALIDATION_ERROR', '对话正在回复或排队中'))

    const work = (async () => {
      await validate()
      if (this.closing || this.suspended)
        throw new AppServiceError('VALIDATION_ERROR', '智能体暂不可用')
      if (this.jobsByConversation.has(conversationId))
        throw new AppServiceError('VALIDATION_ERROR', '对话正在回复或排队中')
      const job: Job = {
        jobId,
        conversationId,
        operation,
        ...payload,
        status: 'queued',
        sequence: 0,
        liveText: '',
        pendingToken: '',
        pendingSeen: false,
        cancelRequested: false,
        finished: false,
      }
      if (!this.queue.length) this.workerStartFailures = 0
      this.jobsByConversation.set(conversationId, job)
      this.queue.push(job)
      const receipt: AgentJobReceipt = { jobId, conversationId, status: 'queued' }
      this.receipts.set(jobId, receipt)
      this.notifyQueue()
      this.pump()
      return this.receipts.get(jobId)!
    })()
    this.accepting.set(jobId, { conversationId, promise: work })
    void work.finally(() => this.accepting.delete(jobId)).catch(() => undefined)
    return work
  }

  private assertConversationIdle(id: string): void {
    if (this.jobsByConversation.has(id))
      throw new AppServiceError('VALIDATION_ERROR', '请先停止当前回复')
  }

  private snapshot(job: Job, includeInput: boolean): AgentJobSnapshot {
    const submittedAttachments = (includeInput ? job.attachmentIds : undefined)?.map(
      (attachmentId) => {
        const attachment = this.agent.files.get(attachmentId, job.conversationId)
        return {
          id: attachment.id,
          conversationId: attachment.conversationId,
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
        }
      },
    )
    return {
      jobId: job.jobId,
      conversationId: job.conversationId,
      status: job.status,
      sequence: job.sequence,
      queuePosition: job.status === 'queued' ? this.queue.indexOf(job) + 1 : undefined,
      liveText: job.liveText,
      submittedParts: includeInput ? job.parts : undefined,
      submittedAttachments: includeInput ? submittedAttachments : undefined,
    }
  }

  private sendEvent(job: Job, event: AgentEvent): void {
    job.sequence++
    this.emit({
      ...event,
      conversationId: job.conversationId,
      jobId: job.jobId,
      sequence: job.sequence,
    })
  }

  private notifyQueue(): void {
    for (const [index, job] of this.queue.entries())
      this.sendEvent(job, {
        conversationId: job.conversationId,
        kind: 'state',
        state: 'queued',
        queuePosition: index + 1,
      })
  }

  private pump(): void {
    if (this.closing || this.suspended) return
    if (this.workerStartFailures >= MAX_WORKER_START_FAILURES) {
      const queued = this.queue.splice(0)
      for (const job of queued) void this.finishJob(job, 'AGENT_WORKER_START_FAILED')
      return
    }
    for (;;) {
      const idle = this.slots.find((slot) => slot.ready && !slot.job && !slot.closed)
      if (idle && this.queue.length) {
        const job = this.queue.shift()!
        job.status = 'running'
        job.slot = idle
        idle.job = job
        this.receipts.set(job.jobId, {
          jobId: job.jobId,
          conversationId: job.conversationId,
          status: 'running',
        })
        this.sendEvent(job, {
          conversationId: job.conversationId,
          kind: 'state',
          state: 'running',
        })
        try {
          idle.process.postMessage(this.runRequest(job))
        } catch (cause) {
          console.error('向智能体执行进程提交任务失败', cause)
          idle.process.kill()
        }
        this.notifyQueue()
        continue
      }
      const active = this.slots.filter((slot) => !!slot.job).length
      const target = Math.min(MAX_ACTIVE_JOBS, active + this.queue.length)
      if (this.slots.length < target) {
        try {
          this.createSlot()
        } catch (cause) {
          this.workerStartFailures = MAX_WORKER_START_FAILURES
          console.error('无法创建智能体执行进程', cause)
          this.pump()
          return
        }
        continue
      }
      break
    }
  }

  private runRequest(job: Job): AgentWorkerRequest {
    return {
      kind: 'run',
      jobId: job.jobId,
      conversationId: job.conversationId,
      operation: job.operation,
      parts: job.parts,
      attachmentIds: job.attachmentIds,
      answer: job.answer,
    }
  }

  private createSlot(): void {
    const executable = path.join(app.getAppPath(), 'out', 'main', 'agent-worker.js')
    const process = utilityProcess.fork(executable, [], {
      serviceName: 'JobTrail Agent',
      stdio: 'pipe',
    })
    const slot: WorkerSlot = { process, ready: false, closed: false }
    this.slots.push(slot)
    process.on('spawn', () => {
      const runtime: AgentRuntimeInfo = {
        packaged: app.isPackaged,
        appPath: app.getAppPath(),
        resourcesPath: globalThis.process.resourcesPath,
        appVersion: app.getVersion(),
      }
      try {
        process.postMessage({
          kind: 'init',
          paths: this.paths,
          runtime,
          mcpConnection: this.mcpConnection(),
        } satisfies AgentWorkerRequest)
      } catch (cause) {
        console.error('初始化智能体执行进程失败', cause)
        process.kill()
      }
    })
    process.on('message', (message: AgentWorkerResponse) => this.onWorkerMessage(slot, message))
    process.on('exit', (code) => {
      slot.closed = true
      const job = slot.job
      const slotIndex = this.slots.indexOf(slot)
      if (slotIndex >= 0) this.slots.splice(slotIndex, 1)
      if (!slot.ready && !this.closing && !this.suspended) this.workerStartFailures++
      if (job) {
        console.error('智能体执行进程意外退出', code)
        void this.finishJob(job, 'AGENT_WORKER_EXITED', true)
      } else this.pump()
    })
    process.on('error', (type, location, report) => {
      console.error('智能体执行进程错误', type, location, report)
    })
    process.stderr?.on('data', (chunk: Buffer) => console.error(String(chunk)))
  }

  private onWorkerMessage(slot: WorkerSlot, message: AgentWorkerResponse): void {
    if (message.kind === 'ready') {
      slot.ready = true
      this.workerStartFailures = 0
      this.pump()
    } else if (message.kind === 'init-error') {
      console.error('智能体执行进程启动失败', message.error)
      slot.process.kill()
    } else if (message.kind === 'event') {
      if (slot.job?.jobId === message.jobId) this.receiveWorkerEvent(slot.job, message.event)
    } else if (message.kind === 'finished') {
      if (slot.job?.jobId === message.jobId) void this.finishJob(slot.job, message.errorCode, false)
    }
  }

  private receiveWorkerEvent(job: Job, event: AgentEvent): void {
    if (job.finished) return
    if (event.kind === 'token' && event.text) {
      job.liveText += event.text
      job.pendingToken += event.text
      if (!job.tokenTimer)
        job.tokenTimer = setTimeout(() => {
          job.tokenTimer = undefined
          this.flushTokens(job)
        }, TOKEN_FLUSH_MS)
      return
    }
    this.flushTokens(job)
    if (event.kind === 'tool-start') job.liveText = ''
    if (event.kind === 'pending') job.pendingSeen = true
    if (event.kind === 'error') {
      job.workerErrorCode = event.errorCode ?? 'INTERNAL_ERROR'
      return
    }
    this.sendEvent(job, event)
  }

  private flushTokens(job: Job): void {
    if (job.tokenTimer) clearTimeout(job.tokenTimer)
    job.tokenTimer = undefined
    if (!job.pendingToken) return
    const text = job.pendingToken
    job.pendingToken = ''
    this.sendEvent(job, { conversationId: job.conversationId, kind: 'token', text })
  }

  private async finishJob(
    job: Job,
    errorCode?: AgentEventErrorCode,
    crashed = false,
  ): Promise<void> {
    if (job.finished) return
    job.finished = true
    this.flushTokens(job)
    if (job.cancelTimer) clearTimeout(job.cancelTimer)
    if (job.slot?.job === job) job.slot.job = undefined
    if (crashed) {
      try {
        await this.agent.recoverInterruptedRun(job.conversationId, job.liveText)
      } catch (cause) {
        console.error('恢复中断的智能体运行失败', cause)
      }
    }
    let submissionState: AgentEvent['submissionState']
    if (job.operation === 'send') {
      if (job.status === 'queued') submissionState = 'not-saved'
      else {
        try {
          submissionState = (await this.agent.hasUserMessage(job.conversationId, job.jobId))
            ? 'saved'
            : 'not-saved'
        } catch {
          submissionState = 'unknown'
        }
      }
    }
    const finalErrorCode = errorCode ?? job.workerErrorCode
    if (finalErrorCode)
      this.sendEvent(job, {
        conversationId: job.conversationId,
        kind: 'error',
        errorCode: finalErrorCode,
        submissionState,
      })
    this.jobsByConversation.delete(job.conversationId)
    this.receipts.set(job.jobId, {
      jobId: job.jobId,
      conversationId: job.conversationId,
      status: job.cancelRequested
        ? 'cancelled'
        : finalErrorCode
          ? 'failed'
          : job.pendingSeen
            ? 'waiting'
            : 'completed',
    })
    this.sendEvent(job, {
      conversationId: job.conversationId,
      kind: 'state',
      state: job.pendingSeen ? 'waiting' : 'idle',
      submissionState,
    })
    this.pump()
  }

  cancel(id: string): void {
    const job = this.jobsByConversation.get(id)
    if (!job) return
    if (job.status === 'queued') {
      job.cancelRequested = true
      this.queue.splice(this.queue.indexOf(job), 1)
      void this.finishJob(job, 'AGENT_CANCELLED')
      this.notifyQueue()
      return
    }
    job.cancelRequested = true
    try {
      job.slot?.process.postMessage({
        kind: 'cancel',
        jobId: job.jobId,
      } satisfies AgentWorkerRequest)
    } catch (cause) {
      console.error('取消智能体任务失败', cause)
      job.slot?.process.kill()
    }
    if (!job.cancelTimer)
      job.cancelTimer = setTimeout(() => {
        if (!job.finished) job.slot?.process.kill()
      }, 5000)
  }

  private async drain(): Promise<void> {
    for (const job of [...this.queue]) this.cancel(job.conversationId)
    for (const job of [...this.jobsByConversation.values()]) this.cancel(job.conversationId)
    const deadline = Date.now() + 15_000
    while (this.jobsByConversation.size && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 50))
    if (this.jobsByConversation.size) throw new Error('agent_operations_did_not_stop')
  }

  private async stopWorkers(): Promise<void> {
    const workers = [...this.slots]
    for (const slot of workers) {
      if (!slot.closed)
        try {
          slot.process.postMessage({ kind: 'close' } satisfies AgentWorkerRequest)
        } catch {
          slot.process.kill()
        }
    }
    const deadline = Date.now() + 5000
    while (workers.some((slot) => !slot.closed) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 50))
    for (const slot of workers) if (!slot.closed) slot.process.kill()
  }

  async suspendForUpdate(): Promise<void> {
    this.suspended = true
    await this.drain()
    await this.stopWorkers()
    await this.agent.suspendForUpdate()
  }

  resumeAfterUpdate(): void {
    this.agent.resumeAfterUpdate()
    this.suspended = false
  }

  async close(): Promise<void> {
    this.closing = true
    try {
      await this.drain()
    } finally {
      await this.stopWorkers()
      await this.agent.close()
    }
  }
}
