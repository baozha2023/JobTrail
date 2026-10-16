import {
  newDiagnosticContext,
  type DiagnosticContext,
  type DiagnosticReference,
} from '../../shared/diagnostics'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { AgentInputQueue } from './input-queue'
import {
  discoveryRecoveryTargetSchema,
  type DiscoveryRecoveryTarget,
} from '../../shared/job-discovery'
import { app, utilityProcess, type UtilityProcess } from 'electron'
import type {
  AgentAttachment,
  AgentQueueEdit,
  AgentQueueItem,
  AgentQueueSnapshot,
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
import type { ExamGrader } from './exam-grader'
import type { AgentRuntimeInfo } from './runtime'
import type { AgentWorkerRequest, AgentWorkerResponse } from './worker-protocol'
import {
  forwardDiagnosticStderr,
  captureError,
  recordEvent,
  currentDiagnosticContext,
} from '../diagnostics'

type JobOperation = 'send' | 'compact' | 'resume'
interface Job {
  origin: 'internal' | 'external'
  editing: boolean
  notification?: DiscoveryRecoveryTarget
  errorCode?: AgentEventErrorCode
  recoveryFailed?: boolean
  context: DiagnosticContext
  diagnostic?: DiagnosticReference
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
  dispatched: boolean
  finished: boolean
}
interface WorkerSlot {
  process: UtilityProcess
  ready: boolean
  job?: Job
  closed: boolean
  reportedFailure?: boolean
}

const MAX_ACTIVE_JOBS = 3
const TOKEN_FLUSH_MS = 50
const MAX_WORKER_START_FAILURES = 3

export class AgentCoordinator {
  private readonly ready: string[] = []
  private readonly inputs = new Map<string, AgentInputQueue<Job>>()
  private readonly controls = new Map<string, Job>()
  private readonly waiting = new Set<string>()
  private readonly mutations = new Map<string, Promise<unknown>>()
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
    private readonly examGrader: ExamGrader,
  ) {}

  list(): AgentConversation[] {
    return this.agent.list().map((conversation) => {
      const job = this.jobsByConversation.get(conversation.id)
      return {
        ...conversation,
        activity: job
          ? 'running'
          : this.waiting.has(conversation.id)
            ? 'waiting'
            : this.ready.includes(conversation.id)
              ? 'queued'
              : 'idle',
        queuePosition: this.position(conversation.id),
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
    const job = this.jobsByConversation.get(id)
    // Capture the event cursor before the asynchronous checkpoint read. A late
    // history response must never claim to include newer worker events.
    const snapshot = job ? this.snapshot(job, job.operation === 'send') : null
    const queue = this.queueSnapshot(id)
    const history = await this.agent.history(id)
    if (
      snapshot &&
      history.messages.some((message) => message.role === 'user' && message.id === snapshot.jobId)
    ) {
      snapshot.submittedParts = undefined
      snapshot.submittedAttachments = undefined
    }
    return {
      ...history,
      running: !!snapshot,
      job: snapshot,
      queue,
    }
  }

  async delete(id: string): Promise<void> {
    return this.serial(id, async () => {
      this.assertConversationIdle(id)
      for (const item of this.input(id).all())
        this.receipts.set(item.jobId, {
          jobId: item.jobId,
          conversationId: id,
          status: 'cancelled',
        })
      this.inputs.delete(id)
      this.controls.delete(id)
      this.waiting.delete(id)
      this.unready(id)
      await this.agent.delete(id)
      this.examGrader.cancelInvalid()
    })
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
    return this.serial(id, async () => {
      const pinned = [
        ...this.input(id).all(),
        this.jobsByConversation.get(id),
        this.controls.get(id),
      ]
      if (pinned.some((item) => item?.attachmentIds?.includes(attachmentId)))
        throw new AppServiceError('VALIDATION_ERROR', '附件正在被消息引用')
      await this.agent.removeUpload(id, attachmentId)
    })
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
    return this.accept(
      conversationId,
      jobId,
      'compact',
      async () => this.agent.validateQueuedCompact(conversationId),
      { parts: [{ kind: 'command', name: 'compact' }] },
    )
  }

  async submission(id: string, jobId: string): Promise<AgentJobReceipt | null> {
    if (!z.string().uuid().safeParse(id).success || !z.string().uuid().safeParse(jobId).success)
      throw new AppServiceError('VALIDATION_ERROR', '任务或会话 ID 无效')
    const accepting = this.accepting.get(jobId)
    if (accepting && accepting.conversationId !== id)
      throw new AppServiceError('VALIDATION_ERROR', '任务 ID 已被使用')
    if (accepting) await accepting.promise.catch(() => undefined)
    const receipt = this.receipts.get(jobId)
    if (receipt && receipt.conversationId !== id)
      throw new AppServiceError('VALIDATION_ERROR', '任务 ID 已被使用')
    return receipt ?? null
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

  private input(id: string): AgentInputQueue<Job> {
    let queue = this.inputs.get(id)
    if (!queue) {
      queue = new AgentInputQueue<Job>()
      this.inputs.set(id, queue)
    }
    return queue
  }

  private serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    const promise = (this.mutations.get(id) ?? Promise.resolve()).catch(() => undefined).then(work)
    this.mutations.set(id, promise)
    void promise
      .finally(() => {
        if (this.mutations.get(id) === promise) this.mutations.delete(id)
      })
      .catch(() => undefined)
    return promise
  }

  private position(id: string): number | undefined {
    const index = this.ready.indexOf(id)
    return index < 0 ? undefined : index + 1
  }

  private unready(id: string): void {
    const index = this.ready.indexOf(id)
    if (index >= 0) this.ready.splice(index, 1)
  }

  private makeReady(id: string): void {
    const eligible =
      !this.closing &&
      !this.suspended &&
      !this.jobsByConversation.has(id) &&
      !this.input(id).blocked &&
      (this.controls.has(id) || (!this.waiting.has(id) && !!this.input(id).peek()))
    if (eligible && !this.ready.includes(id)) this.ready.push(id)
    else if (!eligible) this.unready(id)
  }

  private queueItem(job: Job): AgentQueueItem {
    return {
      id: job.jobId,
      origin: job.origin,
      operation: job.operation,
      parts: job.parts ?? [],
      attachments: (job.attachmentIds ?? []).map((id) => {
        const file = this.agent.files.get(id, job.conversationId)
        return {
          id: file.id,
          conversationId: file.conversationId,
          name: file.name,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
        }
      }),
      editing: job.editing,
      errorCode: job.errorCode,
    }
  }

  private queueSnapshot(id: string): AgentQueueSnapshot {
    const queue = this.input(id)
    return {
      revision: queue.revision,
      internal: queue.internal.map((job) => this.queueItem(job)),
      external: queue.external.map((job) => this.queueItem(job)),
      failed: queue.failed.map((job) => this.queueItem(job)),
      blocked: queue.blocked ? this.queueItem(queue.blocked) : null,
    }
  }

  private publish(id: string): void {
    this.input(id).revision++
    const job = this.jobsByConversation.get(id)
    this.emit({
      kind: 'queue',
      conversationId: id,
      queue: this.queueSnapshot(id),
      job: job ? this.snapshot(job, job.operation === 'send') : null,
      state: job
        ? 'running'
        : this.waiting.has(id)
          ? 'waiting'
          : this.ready.includes(id)
            ? 'queued'
            : 'idle',
      queuePosition: this.position(id),
    })
  }

  notifyDiscovery(
    id: string,
    target: DiscoveryRecoveryTarget,
    jobId: string,
  ): Promise<AgentJobReceipt> {
    const parsed = discoveryRecoveryTargetSchema.safeParse(target)
    if (!parsed.success)
      return Promise.reject(new AppServiceError('VALIDATION_ERROR', '验证通知格式无效'))
    target = parsed.data
    return this.accept(
      id,
      jobId,
      'send',
      async () => undefined,
      { notification: target },
      'internal',
    )
  }

  private accept(
    conversationId: string,
    jobId: string,
    operation: JobOperation,
    validate: () => Promise<void>,
    payload: Partial<Pick<Job, 'parts' | 'attachmentIds' | 'answer' | 'notification'>> = {},
    origin: Job['origin'] = 'external',
  ): Promise<AgentJobReceipt> {
    if (
      !z.string().uuid().safeParse(jobId).success ||
      !z.string().uuid().safeParse(conversationId).success
    )
      return Promise.reject(new AppServiceError('VALIDATION_ERROR', '任务或会话 ID 无效'))
    const accepted = this.receipts.get(jobId)
    const pending = this.accepting.get(jobId)
    if (accepted || pending) {
      if ((accepted ?? pending)!.conversationId !== conversationId)
        return Promise.reject(new AppServiceError('VALIDATION_ERROR', '任务 ID 已被使用'))
      return accepted ? Promise.resolve(accepted) : pending!.promise
    }
    const context = newDiagnosticContext(currentDiagnosticContext())
    const work = this.serial(conversationId, async () => {
      if (this.closing || this.suspended)
        throw new AppServiceError('VALIDATION_ERROR', '智能体暂不可用')
      await validate()
      if (this.closing || this.suspended)
        throw new AppServiceError('VALIDATION_ERROR', '智能体暂不可用')
      if (payload.notification) {
        payload.parts = await this.agent.discoveryContinuation(payload.notification)
        await this.agent.validateSend(conversationId, payload.parts, [])
      }
      const queue = this.input(conversationId)
      if (payload.notification) {
        const target = payload.notification
        const duplicate = [...queue.internal, this.jobsByConversation.get(conversationId)].find(
          (item) =>
            item?.notification?.platform === target.platform &&
            item.notification.runId === target.runId,
        )
        if (duplicate) {
          const receipt = this.receipts.get(duplicate.jobId)!
          this.receipts.set(jobId, receipt)
          return receipt
        }
      }
      const pending = !this.jobsByConversation.has(conversationId)
        ? await this.agent.rawPending(conversationId)
        : undefined
      if (
        operation === 'resume' &&
        (this.jobsByConversation.has(conversationId) || this.controls.has(conversationId))
      )
        throw new AppServiceError('VALIDATION_ERROR', '对话正在回复')
      if (this.closing || this.suspended)
        throw new AppServiceError('VALIDATION_ERROR', '智能体暂不可用')
      const job: Job = {
        context,
        jobId,
        conversationId,
        operation,
        ...structuredClone(payload),
        origin,
        editing: false,
        status: 'queued',
        sequence: 0,
        liveText: '',
        pendingToken: '',
        pendingSeen: false,
        cancelRequested: false,
        dispatched: false,
        finished: false,
      }
      if (operation === 'resume') this.controls.set(conversationId, job)
      else queue.push(job)
      this.receipts.set(jobId, { jobId, conversationId, status: 'queued' })
      if (!this.jobsByConversation.has(conversationId)) {
        if (pending) this.waiting.add(conversationId)
        else this.waiting.delete(conversationId)
      }
      this.workerStartFailures = 0
      this.makeReady(conversationId)
      this.pump([conversationId])
      return this.receipts.get(jobId)!
    })
    this.accepting.set(jobId, { conversationId, promise: work })
    void work.finally(() => this.accepting.delete(jobId)).catch(() => undefined)
    return work
  }

  editQueue(id: string, input: AgentQueueEdit): Promise<AgentQueueSnapshot> {
    return this.serial(id, async () => {
      const basic = z.strictObject({
        action: z.enum(['begin', 'cancel', 'delete', 'retry']),
        itemId: z.string().uuid(),
      })
      const save = z.strictObject({
        action: z.literal('save'),
        itemId: z.string().uuid(),
        parts: z.array(z.unknown()),
        attachmentIds: z.array(z.string().uuid()).max(5),
      })
      if (!z.union([basic, save]).safeParse(input).success)
        throw new AppServiceError('VALIDATION_ERROR', '队列操作无效')
      if (this.suspended || this.closing)
        throw new AppServiceError('VALIDATION_ERROR', '智能体暂不可用')
      const queue = this.input(id)
      const job = queue.find(input.itemId)
      if (!job || job.origin !== 'external')
        throw new AppServiceError('AGENT_QUEUE_CHANGED', '排队消息已变化')
      if (input.action === 'begin') {
        if (job.editing) throw new AppServiceError('AGENT_QUEUE_CHANGED', '排队消息正在编辑')
        job.editing = true
      } else if (input.action === 'cancel') job.editing = false
      else if (input.action === 'save') {
        if (!job.editing) throw new AppServiceError('AGENT_QUEUE_CHANGED', '排队消息未处于编辑状态')
        if (job.operation === 'compact') {
          if (
            !z
              .array(z.strictObject({ kind: z.literal('command'), name: z.literal('compact') }))
              .length(1)
              .safeParse(input.parts).success ||
            input.attachmentIds.length
          )
            throw new AppServiceError('VALIDATION_ERROR', '压缩指令须单独执行')
        } else await this.agent.validateSend(id, input.parts, input.attachmentIds)
        if (this.suspended || this.closing || queue.find(input.itemId) !== job || !job.editing)
          throw new AppServiceError('AGENT_QUEUE_CHANGED', '排队消息已变化')
        job.parts = structuredClone(input.parts)
        job.attachmentIds = [...input.attachmentIds]
        job.editing = false
      } else if (input.action === 'delete') {
        queue.remove(job)
        this.receipts.set(job.jobId, { jobId: job.jobId, conversationId: id, status: 'cancelled' })
      } else {
        if (!queue.failed.includes(job))
          throw new AppServiceError('AGENT_QUEUE_CHANGED', '该消息不能重试')
        const retry: Job = {
          ...job,
          jobId: randomUUID(),
          errorCode: undefined,
          editing: false,
          finished: false,
          cancelRequested: false,
          sequence: 0,
          status: 'queued',
          liveText: '',
          pendingToken: '',
          slot: undefined,
          tokenTimer: undefined,
          cancelTimer: undefined,
          context: newDiagnosticContext(currentDiagnosticContext()),
          diagnostic: undefined,
          workerErrorCode: undefined,
          recoveryFailed: false,
          pendingSeen: false,
          dispatched: false,
        }
        queue.push(retry)
        queue.remove(job)
        this.receipts.set(retry.jobId, { jobId: retry.jobId, conversationId: id, status: 'queued' })
      }
      this.makeReady(id)
      this.pump([id])
      return this.queueSnapshot(id)
    })
  }

  releaseQueueEdits(): void {
    const changed: string[] = []
    for (const [id, queue] of this.inputs) {
      if (!queue.all().some((job) => job.editing)) continue
      for (const job of queue.all()) job.editing = false
      this.makeReady(id)
      changed.push(id)
    }
    this.pump(changed)
  }

  async reconcileQueue(id: string): Promise<AgentQueueSnapshot> {
    return this.serial(id, async () => {
      const queue = this.input(id),
        job = queue.blocked
      if (job) {
        if (job.recoveryFailed) await this.agent.recoverInterruptedRun(id, job.liveText)
        const saved = job.operation !== 'send' || (await this.agent.hasUserMessage(id, job.jobId))
        const pending = await this.agent.rawPending(id)
        if (this.suspended || this.closing) return this.queueSnapshot(id)
        if (pending) this.waiting.add(id)
        else this.waiting.delete(id)
        queue.blocked = null
        if (job.origin === 'external' && (!saved || (job.operation === 'compact' && job.errorCode)))
          queue.failed.push(job)
        this.makeReady(id)
        this.pump([id])
      }
      return this.queueSnapshot(id)
    })
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
      queuePosition: this.position(job.conversationId),
      operation: job.operation,
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

  private pump(changedIds: Iterable<string> = []): void {
    const changed = new Set(changedIds)
    const starting: Job[] = []
    if (!this.closing && !this.suspended) {
      while (this.ready.length && this.workerStartFailures < MAX_WORKER_START_FAILURES) {
        let slot =
          this.slots.find((item) => item.ready && !item.job && !item.closed) ??
          this.slots.find((item) => !item.job && !item.closed)
        if (!slot && this.slots.length < MAX_ACTIVE_JOBS) {
          try {
            slot = this.createSlot()
          } catch (cause) {
            this.workerStartFailures = MAX_WORKER_START_FAILURES
            captureError(cause, { operation: 'agent.spawn' })
            break
          }
        }
        if (!slot) break
        const id = this.ready.shift()!
        const job = this.controls.get(id) ?? this.input(id).take()
        if (!job) continue
        this.controls.delete(id)
        job.status = 'running'
        job.slot = slot
        slot.job = job
        this.jobsByConversation.set(id, job)
        this.receipts.set(job.jobId, { jobId: job.jobId, conversationId: id, status: 'running' })
        changed.add(id)
        starting.push(job)
      }
    }
    if (!this.closing && !this.suspended && this.workerStartFailures >= MAX_WORKER_START_FAILURES) {
      const pending = this.ready.splice(0)
      for (const id of pending) {
        const queue = this.input(id)
        const control = this.controls.get(id)
        this.controls.delete(id)
        for (const job of [...queue.internal, ...queue.external, ...(control ? [control] : [])]) {
          queue.remove(job)
          job.errorCode = 'AGENT_WORKER_START_FAILED'
          if (job.origin === 'external' && job.operation !== 'resume') queue.failed.push(job)
          this.receipts.set(job.jobId, { jobId: job.jobId, conversationId: id, status: 'failed' })
          this.sendEvent(job, {
            kind: 'error',
            conversationId: id,
            errorCode: job.errorCode,
            submissionState: 'not-saved',
          })
        }
        changed.add(id)
      }
    }
    // Reserve all available execution slots before publishing. Initializing a
    // reserved worker is part of the current round, not a waiting queue item.
    for (const id of this.ready) changed.add(id)
    for (const id of changed) this.publish(id)
    for (const job of starting) {
      this.sendEvent(job, { conversationId: job.conversationId, kind: 'state', state: 'running' })
      if (job.slot!.ready) void this.startJob(job, job.slot!)
    }
  }

  private async startJob(job: Job, slot: WorkerSlot): Promise<void> {
    try {
      if (job.notification) job.parts = await this.agent.discoveryContinuation(job.notification)
      if (job.operation === 'send')
        await this.agent.validateSend(job.conversationId, job.parts ?? [], job.attachmentIds ?? [])
      if (job.operation === 'compact') await this.agent.validateCompact(job.conversationId)
      if (job.finished || slot.closed || slot.job !== job) return
      if (job.cancelRequested || this.suspended || this.closing) {
        await this.finishJob(job, 'AGENT_CANCELLED')
        return
      }
      if (job.notification) this.publish(job.conversationId)
      slot.process.postMessage(this.runRequest(job))
      job.dispatched = true
    } catch (cause) {
      job.diagnostic = captureError(cause, { operation: 'agent.submit', ...job.context })
      const errorCode = cause instanceof AppServiceError ? cause.code : 'INTERNAL_ERROR'
      await this.finishJob(job, errorCode)
    }
  }

  private runRequest(job: Job): AgentWorkerRequest {
    return {
      kind: 'run',
      context: job.context,
      jobId: job.jobId,
      conversationId: job.conversationId,
      operation: job.operation,
      parts: job.parts,
      attachmentIds: job.attachmentIds,
      answer: job.answer,
    }
  }

  private createSlot(): WorkerSlot {
    const executable = path.join(app.getAppPath(), 'out', 'main', 'agent-worker.js')
    const process = utilityProcess.fork(executable, [], {
      serviceName: 'JobTrail Agent',
      stdio: 'pipe',
      env: {
        ...globalThis.process.env,
        JOBTRAIL_LOG_ROOT: this.paths.root,
        JOBTRAIL_LOG_VERSION: app.getVersion(),
        JOBTRAIL_LOG_PACKAGED: app.isPackaged ? '1' : '0',
      },
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
        captureError(cause, { operation: 'agent.initialize' })
        slot.reportedFailure = true
        process.kill()
      }
    })
    process.on('message', (message: AgentWorkerResponse) => this.onWorkerMessage(slot, message))
    process.on('exit', () => {
      slot.closed = true
      const job = slot.job
      const slotIndex = this.slots.indexOf(slot)
      if (slotIndex >= 0) this.slots.splice(slotIndex, 1)
      if (!slot.ready && !this.closing && !this.suspended) this.workerStartFailures++
      if (!this.closing && !this.suspended && !slot.reportedFailure) {
        const diagnostic = captureError(
          {
            code: job ? 'AGENT_WORKER_EXITED' : 'PROCESS_EXITED',
            message: 'Agent process exited unexpectedly',
          },
          { operation: 'agent.exit', ...job?.context },
        )
        if (job) job.diagnostic = diagnostic
      }
      if (
        job &&
        !slot.ready &&
        !job.dispatched &&
        !job.finished &&
        !this.closing &&
        !this.suspended
      ) {
        slot.job = undefined
        if (this.workerStartFailures < MAX_WORKER_START_FAILURES) {
          try {
            const replacement = this.createSlot()
            replacement.job = job
            job.slot = replacement
            this.pump()
            return
          } catch (cause) {
            this.workerStartFailures = MAX_WORKER_START_FAILURES
            captureError(cause, { operation: 'agent.spawn' })
          }
        }
        void this.finishJob(job, 'AGENT_WORKER_START_FAILED')
      } else if (job) {
        void this.finishJob(job, 'AGENT_WORKER_EXITED', job.dispatched)
      } else this.pump()
    })
    process.on('error', (cause) => {
      slot.reportedFailure = true
      const diagnostic = captureError(
        { code: 'PROCESS_ERROR', message: 'Agent process failed', cause },
        { operation: 'agent.process-error', ...slot.job?.context },
      )
      if (slot.job) slot.job.diagnostic = diagnostic
    })
    forwardDiagnosticStderr(process.stderr)
    return slot
  }

  private onWorkerMessage(slot: WorkerSlot, message: AgentWorkerResponse): void {
    if (message.kind === 'ready') {
      slot.ready = true
      this.workerStartFailures = 0
      if (slot.job && !slot.job.finished) void this.startJob(slot.job, slot)
      this.pump()
    } else if (message.kind === 'init-error') {
      slot.reportedFailure = true
      recordEvent({
        operation: 'agent.startup',
        outcome: 'failed',
        attributes: message.diagnostic ? { relatedEventId: message.diagnostic.eventId } : undefined,
      })
      slot.process.kill()
    } else if (message.kind === 'event') {
      if (slot.job?.jobId === message.jobId) this.receiveWorkerEvent(slot.job, message.event)
    } else if (message.kind === 'finished') {
      if (slot.job?.jobId === message.jobId) {
        slot.job.diagnostic = message.diagnostic
        void this.finishJob(slot.job, message.errorCode, false)
      }
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
    if (crashed) {
      try {
        await this.agent.recoverInterruptedRun(job.conversationId, job.liveText)
      } catch (cause) {
        job.recoveryFailed = true
        captureError(cause, { operation: 'agent.recover' })
      }
    }
    let submissionState: AgentEvent['submissionState']
    if (job.operation === 'send') {
      if (!job.dispatched) submissionState = 'not-saved'
      else {
        try {
          submissionState = (await this.agent.hasUserMessage(job.conversationId, job.jobId))
            ? 'saved'
            : 'not-saved'
        } catch (error) {
          captureError(error, { operation: 'agent.submission-state' })
          submissionState = 'unknown'
        }
      }
    }
    const finalErrorCode = errorCode ?? job.workerErrorCode
    if (finalErrorCode && finalErrorCode !== 'AGENT_CANCELLED' && !job.diagnostic)
      job.diagnostic = captureError(
        { code: finalErrorCode, message: 'Agent task failed' },
        { operation: 'agent.task', ...job.context },
      )
    if (finalErrorCode)
      this.sendEvent(job, {
        conversationId: job.conversationId,
        kind: 'error',
        errorCode: finalErrorCode,
        diagnostic: job.diagnostic,
        submissionState,
      })
    const id = job.conversationId
    const queue = this.input(id)
    job.errorCode = finalErrorCode
    let pending = job.pendingSeen
    let pendingReadFailed = false
    try {
      pending = !!(await this.agent.rawPending(id))
    } catch (cause) {
      pendingReadFailed = true
      captureError(cause, { operation: 'agent.pending-state' })
    }
    if (pending) this.waiting.add(id)
    else this.waiting.delete(id)
    if (submissionState === 'unknown' || job.recoveryFailed || pendingReadFailed)
      queue.blocked = job
    else if (
      job.origin === 'external' &&
      (submissionState === 'not-saved' || (job.operation === 'compact' && finalErrorCode))
    )
      queue.failed.push(job)
    if (job.slot?.job === job) job.slot.job = undefined
    this.jobsByConversation.delete(id)
    this.receipts.set(job.jobId, {
      jobId: job.jobId,
      conversationId: id,
      status: job.cancelRequested
        ? 'cancelled'
        : finalErrorCode
          ? 'failed'
          : pending
            ? 'waiting'
            : 'completed',
    })
    this.sendEvent(job, {
      conversationId: id,
      kind: 'state',
      state: pending ? 'waiting' : 'idle',
      submissionState,
    })
    this.makeReady(id)
    this.pump([id])
  }

  cancel(id: string, expectedJobId?: string): void {
    const job = this.jobsByConversation.get(id)
    if (!job) {
      const queued = this.controls.get(id) ?? this.input(id).peek()
      if (!queued || (expectedJobId && queued.jobId !== expectedJobId)) return
      this.controls.delete(id)
      this.input(id).remove(queued)
      this.receipts.set(queued.jobId, {
        jobId: queued.jobId,
        conversationId: id,
        status: 'cancelled',
      })
      if (queued.origin === 'external' && queued.operation !== 'resume')
        this.input(id).failed.push(queued)
      this.makeReady(id)
      this.pump([id])
      return
    }
    if (expectedJobId && expectedJobId !== job.jobId) return
    job.cancelRequested = true
    if (!job.dispatched) {
      void this.finishJob(job, 'AGENT_CANCELLED')
      return
    }
    try {
      job.slot?.process.postMessage({
        kind: 'cancel',
        jobId: job.jobId,
      } satisfies AgentWorkerRequest)
    } catch (cause) {
      captureError(cause, { operation: 'agent.cancel' })
      job.slot?.process.kill()
    }
    if (!job.cancelTimer)
      job.cancelTimer = setTimeout(() => {
        if (!job.finished) job.slot?.process.kill()
      }, 5000)
  }

  private async drain(): Promise<void> {
    this.ready.splice(0)
    for (const [id, queue] of this.inputs) {
      for (const job of [
        ...queue.all(),
        ...(this.controls.has(id) ? [this.controls.get(id)!] : []),
      ])
        this.receipts.set(job.jobId, { jobId: job.jobId, conversationId: id, status: 'cancelled' })
      queue.internal.splice(0)
      queue.external.splice(0)
      queue.failed.splice(0)
      queue.blocked = null
      this.publish(id)
    }
    this.controls.clear()
    for (const job of [...this.jobsByConversation.values()])
      this.cancel(job.conversationId, job.jobId)
    await Promise.allSettled([...this.mutations.values()])
    const deadline = Date.now() + 15_000
    while (this.jobsByConversation.size && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 50))
    if (this.jobsByConversation.size) throw new Error('agent_operations_did_not_stop')
    for (const [id, queue] of this.inputs) {
      queue.failed.splice(0)
      queue.blocked = null
      this.publish(id)
    }
  }

  private async stopWorkers(): Promise<void> {
    const workers = [...this.slots]
    for (const slot of workers) {
      if (!slot.closed)
        try {
          slot.process.postMessage({ kind: 'close' } satisfies AgentWorkerRequest)
        } catch (error) {
          captureError(error, { operation: 'agent.worker-close' })
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
    this.examGrader.suspend()
    await this.drain()
    await this.stopWorkers()
    await this.agent.suspendForUpdate()
  }

  resumeAfterUpdate(): void {
    this.agent.resumeAfterUpdate()
    this.examGrader.resume()
    this.suspended = false
  }

  async close(): Promise<void> {
    this.closing = true
    this.examGrader.suspend()
    try {
      await this.drain()
    } finally {
      await this.stopWorkers()
      await this.agent.close()
    }
  }
}
