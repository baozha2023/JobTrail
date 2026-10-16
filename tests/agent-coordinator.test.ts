import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, AgentHistory } from '../src/shared/types'
import type { AppPaths } from '../src/main/config'
import type { AgentService } from '../src/main/agent/service'
import type { ExamGrader } from '../src/main/agent/exam-grader'
import { AgentCoordinator } from '../src/main/agent/coordinator'
import type { AgentWorkerRequest } from '../src/main/agent/worker-protocol'
import { newDiagnosticContext } from '../src/shared/diagnostics'
import { findDiagnosticReference, withDiagnosticContext } from '../src/main/diagnostics'

const mocks = vi.hoisted(() => ({ fork: vi.fn() }))
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => 'F:/JobTrail',
    getVersion: () => '1.0.0',
  },
  utilityProcess: { fork: mocks.fork },
}))

const ids = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
  '00000000-0000-4000-8000-000000000004',
]
const jobIds = [
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
  '10000000-0000-4000-8000-000000000004',
]
const usage: AgentHistory['usage'] = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: null,
  contextTokens: null,
  contextEstimated: true,
  contextWindowTokens: 256000,
}

class FakeWorker extends EventEmitter {
  requests: AgentWorkerRequest[] = []
  exited = false
  constructor(
    private readonly failInit = false,
    private readonly autoReady = true,
  ) {
    super()
    queueMicrotask(() => this.emit('spawn'))
  }
  postMessage(request: AgentWorkerRequest): void {
    this.requests.push(request)
    if (request.kind === 'init')
      queueMicrotask(() => {
        if (this.failInit) {
          this.emit('message', { kind: 'init-error', error: 'native module unavailable' })
        } else if (this.autoReady) this.ready()
      })
    if (request.kind === 'close') queueMicrotask(() => this.kill())
  }
  ready(): void {
    this.emit('message', { kind: 'ready' })
  }
  kill(): void {
    if (this.exited) return
    this.exited = true
    queueMicrotask(() => this.emit('exit', 1))
  }
  runJobIds(): string[] {
    return this.requests
      .filter(
        (request): request is Extract<AgentWorkerRequest, { kind: 'run' }> =>
          request.kind === 'run',
      )
      .map((request) => request.jobId)
  }
  event(jobId: string, event: AgentEvent): void {
    this.emit('message', { kind: 'event', jobId, event })
  }
  finish(jobId: string): void {
    this.emit('message', { kind: 'finished', jobId })
  }
}

function fixture(failInit = false, autoReady = true) {
  const workers: FakeWorker[] = []
  mocks.fork.mockImplementation(() => {
    const worker = new FakeWorker(failInit, autoReady)
    workers.push(worker)
    return worker
  })
  const events: AgentEvent[] = []
  const recoverInterruptedRun = vi.fn().mockResolvedValue(undefined)
  const suspendForUpdate = vi.fn().mockResolvedValue(undefined)
  const resumeAfterUpdate = vi.fn()
  const agent = {
    list: () => ids.map((id) => ({ id, title: id, createdAt: 1, updatedAt: 1 })),
    history: async () => ({ messages: [], pending: null, usage, running: false }),
    validateSend: async () => undefined,
    validateQueuedCompact: () => undefined,
    rawPending: async () => null,
    discoveryContinuation: async () => [{ kind: 'text', text: 'verification completed' }],
    validateCompact: async () => undefined,
    validateResume: async () => undefined,
    hasUserMessage: () => false,
    recoverInterruptedRun,
    suspendForUpdate,
    resumeAfterUpdate,
    files: {
      get: () => {
        throw new Error('unexpected attachment')
      },
    },
    close: async () => undefined,
  } as unknown as AgentService
  const paths = {
    root: 'F:/JobTrail',
    config: 'F:/JobTrail/config.json',
    data: 'F:/JobTrail/data',
    database: 'F:/JobTrail/data/jobtrail.db',
    resumes: 'F:/JobTrail/resumes',
    chatUploads: 'F:/JobTrail/uploads',
  } satisfies AppPaths
  const coordinator = new AgentCoordinator(
    agent,
    paths,
    () => ({ command: 'mcp', args: [] }),
    (event) => events.push(event),
    { cancelInvalid: vi.fn(), suspend: vi.fn(), resume: vi.fn() } as unknown as ExamGrader,
  )
  return {
    agent,
    coordinator,
    workers,
    events,
    recoverInterruptedRun,
    suspendForUpdate,
    resumeAfterUpdate,
  }
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => mocks.fork.mockReset())

describe('agent coordinator', () => {
  it('reserves a cold worker outside the waiting capacity and cancels it without dispatching the old input', async () => {
    const original = FakeWorker.prototype.postMessage
    const post = vi.spyOn(FakeWorker.prototype, 'postMessage').mockImplementation(function (
      this: FakeWorker,
      request,
    ) {
      if (request.kind === 'init') this.requests.push(request)
      else original.call(this, request)
    })
    const f = fixture()
    const saved = vi.spyOn(f.agent, 'hasUserMessage')
    try {
      for (const [index, jobId] of jobIds.entries())
        await f.coordinator.send(ids[0], [{ kind: 'text', text: `input-${index}` }], [], jobId)
      const history = await f.coordinator.history(ids[0])
      expect(history.job?.jobId).toBe(jobIds[0])
      expect(history.queue!.external).toHaveLength(3)
      expect(f.workers[0].runJobIds()).toEqual([])
      await expect(
        f.coordinator.send(
          ids[0],
          [{ kind: 'text', text: 'full' }],
          [],
          '10000000-0000-4000-8000-000000000005',
        ),
      ).rejects.toMatchObject({ code: 'AGENT_QUEUE_FULL' })
      f.coordinator.cancel(ids[0], jobIds[0])
      await tick()
      expect(saved).not.toHaveBeenCalled()
      f.workers[0].emit('message', { kind: 'ready' })
      await tick()
      expect(f.workers[0].runJobIds()).toEqual([jobIds[1]])
      for (const jobId of jobIds.slice(1)) {
        f.workers[0].finish(jobId)
        await tick()
      }
      expect(f.recoverInterruptedRun).not.toHaveBeenCalled()
    } finally {
      await f.coordinator.close()
      post.mockRestore()
    }
  })

  it('reserves a cold execution slot before publishing and counts only the next three inputs as waiting', async () => {
    const f = fixture(false, false)
    const receipt = await f.coordinator.send(
      ids[0],
      [{ kind: 'text', text: 'direct' }],
      [],
      jobIds[0],
    )
    await tick()
    expect(receipt.status).toBe('running')
    expect(f.workers[0].runJobIds()).toEqual([])
    expect((await f.coordinator.history(ids[0])).job?.submittedParts).toEqual([
      { kind: 'text', text: 'direct' },
    ])
    for (const jobId of jobIds.slice(1))
      await f.coordinator.send(ids[0], [{ kind: 'text', text: jobId }], [], jobId)
    await expect(
      f.coordinator.send(
        ids[0],
        [{ kind: 'text', text: 'overflow' }],
        [],
        '70000000-0000-4000-8000-000000000001',
      ),
    ).rejects.toMatchObject({ code: 'AGENT_QUEUE_FULL' })
    expect((await f.coordinator.history(ids[0])).queue!.external.map((item) => item.id)).toEqual(
      jobIds.slice(1),
    )
    expect(
      f.events
        .filter((event) => event.kind === 'queue')
        .every((event) => !event.queue!.external.some((item) => item.id === jobIds[0])),
    ).toBe(true)
    f.workers[0].ready()
    await tick()
    for (const jobId of jobIds) {
      f.workers[0].finish(jobId)
      await tick()
    }
    await f.coordinator.close()
  })

  it('publishes warm direct sends and internal notifications in the chat snapshot without a waiting snapshot', async () => {
    const f = fixture()
    vi.spyOn(f.agent, 'hasUserMessage').mockResolvedValue(true)
    await f.coordinator.send(ids[0], [{ kind: 'text', text: 'first' }], [], jobIds[0])
    await tick()
    f.workers[0].finish(jobIds[0])
    await tick()
    const firstEvent = f.events.length
    await f.coordinator.send(ids[0], [{ kind: 'text', text: 'direct again' }], [], jobIds[1])
    await tick()
    expect(
      f.events
        .slice(firstEvent)
        .filter((event) => event.kind === 'queue')
        .every((event) => event.queue!.external.length === 0 && event.job?.jobId === jobIds[1]),
    ).toBe(true)
    f.workers[0].finish(jobIds[1])
    await tick()
    vi.spyOn(f.agent, 'discoveryContinuation')
      .mockResolvedValueOnce([{ kind: 'text', text: 'queued language' }])
      .mockResolvedValueOnce([{ kind: 'text', text: 'execution language' }])
    const notificationEvent = f.events.length
    await f.coordinator.notifyDiscovery(ids[0], { platform: 'boss' }, jobIds[2])
    await tick()
    expect(
      f.events
        .slice(notificationEvent)
        .filter((event) => event.kind === 'queue')
        .every((event) => event.queue!.internal.length === 0 && event.job?.jobId === jobIds[2]),
    ).toBe(true)
    expect(f.events.at(-1)?.job?.submittedParts).toEqual([
      { kind: 'text', text: 'execution language' },
    ])
    expect(f.workers[0].requests.at(-1)).toMatchObject({
      parts: [{ kind: 'text', text: 'execution language' }],
    })
    f.workers[0].finish(jobIds[2])
    await tick()
    await f.coordinator.close()
  })

  it('keeps an initialization retry attached to its reserved round without putting it in the waiting queue', async () => {
    const f = fixture(false, false)
    await f.coordinator.send(ids[0], [{ kind: 'text', text: 'direct' }], [], jobIds[0])
    await tick()
    f.workers[0].kill()
    await tick()
    expect(f.workers).toHaveLength(2)
    expect(f.recoverInterruptedRun).not.toHaveBeenCalled()
    expect((await f.coordinator.history(ids[0])).job?.jobId).toBe(jobIds[0])
    expect(
      f.events
        .filter((event) => event.kind === 'queue')
        .every((event) => event.queue!.external.length === 0),
    ).toBe(true)
    f.workers[1].ready()
    await tick()
    expect(f.workers[1].runJobIds()).toEqual([jobIds[0]])
    f.workers[1].finish(jobIds[0])
    await tick()
    await f.coordinator.close()
  })

  it('cancels a reserved round before worker readiness without dispatching it or stopping its successor', async () => {
    const f = fixture(false, false)
    await f.coordinator.send(ids[0], [{ kind: 'text', text: 'cancel before ready' }], [], jobIds[0])
    await f.coordinator.send(ids[0], [{ kind: 'text', text: 'next' }], [], jobIds[1])
    f.coordinator.cancel(ids[0], jobIds[0])
    await tick()
    expect(await f.coordinator.submission(ids[0], jobIds[0])).toMatchObject({ status: 'cancelled' })
    expect((await f.coordinator.history(ids[0])).job?.jobId).toBe(jobIds[1])
    f.workers[0].ready()
    await tick()
    expect(f.workers[0].runJobIds()).toEqual([jobIds[1]])
    f.workers[0].finish(jobIds[1])
    await tick()
    await f.coordinator.close()
  })

  it('queues only the fourth conversation while the first three workers are initializing', async () => {
    const f = fixture(false, false)
    for (let i = 0; i < ids.length; i++)
      await f.coordinator.send(ids[i], [{ kind: 'text', text: 'hello' }], [], jobIds[i])
    expect(f.workers).toHaveLength(3)
    expect(f.coordinator.list().map((item) => item.activity)).toEqual([
      'running',
      'running',
      'running',
      'queued',
    ])
    expect((await f.coordinator.history(ids[3])).queue!.external.map((item) => item.id)).toEqual([
      jobIds[3],
    ])
    for (const event of f.events.filter(
      (event) => event.kind === 'queue' && event.conversationId !== ids[3],
    ))
      expect(event.queue!.external).toEqual([])
    for (const worker of f.workers) worker.ready()
    await tick()
    f.workers[0].finish(jobIds[0])
    await tick()
    expect(f.workers[0].runJobIds()).toEqual([jobIds[0], jobIds[3]])
    for (const worker of f.workers) worker.finish(worker.runJobIds().at(-1)!)
    await tick()
    await f.coordinator.close()
  })

  it('never dispatches a cancelled round whose execution validation resolves after its successor starts', async () => {
    const f = fixture()
    let release!: () => void
    vi.spyOn(f.agent, 'validateSend')
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = resolve
          }),
      )
    await f.coordinator.send(
      ids[0],
      [{ kind: 'text', text: 'validate then cancel' }],
      [],
      jobIds[0],
    )
    await tick()
    await f.coordinator.send(ids[0], [{ kind: 'text', text: 'next' }], [], jobIds[1])
    f.coordinator.cancel(ids[0], jobIds[0])
    await tick()
    expect(f.workers[0].runJobIds()).toEqual([jobIds[1]])
    release()
    await tick()
    expect(f.workers[0].runJobIds()).toEqual([jobIds[1]])
    f.workers[0].finish(jobIds[1])
    await tick()
    await f.coordinator.close()
  })

  it('keeps a failed resume out of the external input queue so the pending interaction can be answered again', async () => {
    const f = fixture(true)
    vi.spyOn(f.agent, 'rawPending').mockResolvedValue({
      kind: 'question',
      questions: [{ question: 'which?' }],
    })
    await f.coordinator.resume(ids[0], ['answer'], jobIds[0])
    await tick()
    await tick()
    expect(await f.coordinator.submission(ids[0], jobIds[0])).toMatchObject({ status: 'failed' })
    expect((await f.coordinator.history(ids[0])).queue!.failed).toEqual([])
    expect(f.coordinator.list().find((item) => item.id === ids[0])?.activity).toBe('waiting')
    await f.coordinator.close()
  })

  it('retains a failed compact command after an uncertain pending-state read is reconciled', async () => {
    const f = fixture()
    await f.coordinator.compact(ids[0], jobIds[0])
    await tick()
    vi.spyOn(f.agent, 'rawPending')
      .mockRejectedValueOnce(new Error('read failed'))
      .mockResolvedValue(null)
    f.workers[0].event(jobIds[0], {
      conversationId: ids[0],
      kind: 'error',
      errorCode: 'INTERNAL_ERROR',
    })
    f.workers[0].finish(jobIds[0])
    await tick()
    expect((await f.coordinator.history(ids[0])).queue!.blocked?.id).toBe(jobIds[0])
    await f.coordinator.reconcileQueue(ids[0])
    expect((await f.coordinator.history(ids[0])).queue!.failed.map((item) => item.id)).toEqual([
      jobIds[0],
    ])
    await f.coordinator.close()
  })

  it('queues compact behind pending interactions, reserves capacity and releases an edit on reload', async () => {
    const f = fixture()
    let pending: AgentHistory['pending'] = {
      kind: 'confirmation',
      fingerprint: 'test',
      message: 'confirm',
    }
    vi.spyOn(f.agent, 'rawPending').mockImplementation(async () => pending)
    const validate = vi.spyOn(f.agent, 'validateCompact')
    await f.coordinator.compact(ids[0], jobIds[0])
    await f.coordinator.send(ids[0], [{ kind: 'text', text: 'second' }], [], jobIds[1])
    await f.coordinator.send(ids[0], [{ kind: 'text', text: 'third' }], [], jobIds[2])
    await expect(f.coordinator.compact(ids[0], jobIds[3])).rejects.toMatchObject({
      code: 'AGENT_QUEUE_FULL',
    })
    expect(validate).not.toHaveBeenCalled()
    expect((await f.coordinator.history(ids[0])).queue!.external[0].parts).toEqual([
      { kind: 'command', name: 'compact' },
    ])
    await f.coordinator.editQueue(ids[0], { action: 'begin', itemId: jobIds[0] })
    pending = null
    // The pending state is rechecked when another operation is admitted.
    await f.coordinator.notifyDiscovery(ids[0], { platform: 'boss' }, jobIds[3])
    await tick()
    f.workers[0].finish(jobIds[3])
    await tick()
    expect(f.workers[0].runJobIds()).toEqual([jobIds[3]])
    f.coordinator.releaseQueueEdits()
    await tick()
    expect(f.workers[0].requests.at(-1)).toMatchObject({ jobId: jobIds[0], operation: 'compact' })
    expect(validate).toHaveBeenCalledOnce()
    expect(await f.coordinator.submission(ids[0], jobIds[0])).toMatchObject({ status: 'running' })
    await expect(f.coordinator.submission(ids[1], jobIds[0])).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    })
    for (const jobId of jobIds.slice(0, 3)) {
      f.workers[0].finish(jobId)
      await tick()
    }
    expect(await f.coordinator.submission(ids[0], jobIds[0])).toMatchObject({ status: 'completed' })
    await f.coordinator.close()
  })

  it('rejects admissions that finish validation after maintenance has stopped admission', async () => {
    const f = fixture()
    let release!: () => void
    vi.spyOn(f.agent, 'rawPending').mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(null)
        }),
    )
    const admission = f.coordinator.send(
      ids[0],
      [{ kind: 'text', text: 'pending validation' }],
      [],
      jobIds[0],
    )
    const rejected = expect(admission).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await tick()
    const suspended = f.coordinator.suspendForUpdate()
    release()
    await rejected
    await suspended
    expect((await f.coordinator.history(ids[0])).queue!.external).toEqual([])
    expect(await f.coordinator.submission(ids[0], jobIds[0])).toBeNull()
    expect(f.workers).toEqual([])
    await f.coordinator.close()
  })

  it('uses a fresh lifecycle when retrying an unsaved failed message', async () => {
    const f = fixture()
    const saved = vi.spyOn(f.agent, 'hasUserMessage').mockResolvedValue(false)
    await f.coordinator.send(ids[0], [{ kind: 'text', text: 'retry me' }], [], jobIds[0])
    await tick()
    f.workers[0].event(jobIds[0], {
      conversationId: ids[0],
      kind: 'error',
      errorCode: 'INTERNAL_ERROR',
    })
    f.workers[0].finish(jobIds[0])
    await tick()
    await f.coordinator.editQueue(ids[0], { action: 'retry', itemId: jobIds[0] })
    await tick()
    const retryId = f.workers[0].runJobIds().at(-1)!
    expect(retryId).not.toBe(jobIds[0])
    saved.mockResolvedValue(true)
    f.workers[0].finish(retryId)
    await tick()
    expect(await f.coordinator.submission(ids[0], retryId)).toMatchObject({ status: 'completed' })
    expect((await f.coordinator.history(ids[0])).queue!.failed).toEqual([])
    await f.coordinator.close()
  })

  it('prioritizes internal FIFO inputs, caps concurrent external admissions, and continues after stop and failure', async () => {
    const f = fixture()
    const extra = Array.from(
      { length: 6 },
      (_, i) => `20000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
    )
    await f.coordinator.send(ids[0], [{ kind: 'text', text: 'active' }], [], jobIds[0])
    await tick()
    const results = await Promise.allSettled(
      extra
        .slice(0, 4)
        .map((jobId, i) =>
          f.coordinator.send(ids[0], [{ kind: 'text', text: `external-${i}` }], [], jobId),
        ),
    )
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(3)
    expect(results.find((item) => item.status === 'rejected')).toMatchObject({
      reason: { code: 'AGENT_QUEUE_FULL' },
    })
    await f.coordinator.notifyDiscovery(ids[0], { platform: 'boss' }, extra[4])
    await f.coordinator.notifyDiscovery(ids[0], { platform: 'liepin' }, extra[5])
    await f.coordinator.notifyDiscovery(
      ids[0],
      { platform: 'boss' },
      '30000000-0000-4000-8000-000000000001',
    )
    expect((await f.coordinator.history(ids[0])).queue!.internal).toHaveLength(2)
    f.coordinator.cancel(ids[0], jobIds[0])
    f.workers[0].finish(jobIds[0])
    await tick()
    expect(f.workers[0].runJobIds()).toEqual([jobIds[0], extra[4]])
    // A delayed second stop for the previous round must not cancel the new round.
    f.coordinator.cancel(ids[0], jobIds[0])
    expect(f.workers[0].requests.filter((r) => r.kind === 'cancel')).toHaveLength(1)
    f.workers[0].event(extra[4], {
      conversationId: ids[0],
      kind: 'error',
      errorCode: 'INTERNAL_ERROR',
    })
    f.workers[0].finish(extra[4])
    await tick()
    expect(f.workers[0].runJobIds().at(-1)).toBe(extra[5])
    for (const id of [extra[5], ...extra.slice(0, 3)]) {
      f.workers[0].finish(id)
      await tick()
    }
    expect(f.workers[0].runJobIds()).toEqual([jobIds[0], extra[4], extra[5], ...extra.slice(0, 3)])
    await f.coordinator.close()
  })

  it('retains editing positions, lets internal notifications pass, releases edits, and rejects edits to active inputs', async () => {
    const f = fixture()
    await f.coordinator.send(ids[0], [{ kind: 'text', text: 'active' }], [], jobIds[0])
    await tick()
    await f.coordinator.send(ids[0], [{ kind: 'text', text: 'original' }], [], jobIds[1])
    await f.coordinator.send(ids[0], [{ kind: 'text', text: 'third' }], [], jobIds[2])
    await f.coordinator.editQueue(ids[0], { action: 'begin', itemId: jobIds[1] })
    f.workers[0].finish(jobIds[0])
    await tick()
    expect(f.workers[0].runJobIds()).toEqual([jobIds[0]])
    await f.coordinator.notifyDiscovery(ids[0], { platform: 'boss' }, jobIds[3])
    await tick()
    expect(f.workers[0].runJobIds().at(-1)).toBe(jobIds[3])
    await f.coordinator.editQueue(ids[0], {
      action: 'save',
      itemId: jobIds[1],
      parts: [{ kind: 'text', text: 'edited' }],
      attachmentIds: [],
    })
    await f.coordinator.editQueue(ids[0], { action: 'delete', itemId: jobIds[2] })
    f.workers[0].finish(jobIds[3])
    await tick()
    expect(f.workers[0].requests.at(-1)).toMatchObject({
      jobId: jobIds[1],
      parts: [{ kind: 'text', text: 'edited' }],
    })
    await expect(
      f.coordinator.editQueue(ids[0], { action: 'begin', itemId: jobIds[1] }),
    ).rejects.toMatchObject({ code: 'AGENT_QUEUE_CHANGED' })
    await f.coordinator.send(ids[0], [{ kind: 'text', text: 'after reload' }], [], jobIds[2])
    // A deleted input's idempotent receipt remains cancelled; a fresh ID is required to send again.
    expect((await f.coordinator.send(ids[0], [], [], jobIds[2])).status).toBe('cancelled')
    f.workers[0].finish(jobIds[1])
    await tick()
    await f.coordinator.editQueue(ids[0], { action: 'begin', itemId: jobIds[0] })
    f.coordinator.releaseQueueEdits()
    expect((await f.coordinator.history(ids[0])).queue!.failed.every((item) => !item.editing)).toBe(
      true,
    )
    await f.coordinator.close()
  })

  it('blocks both lanes on unknown submission and pending interactions, then resumes exactly once', async () => {
    const f = fixture()
    let pending: AgentHistory['pending'] = null
    vi.spyOn(f.agent, 'rawPending').mockImplementation(async () => pending)
    const saved = vi
      .spyOn(f.agent, 'hasUserMessage')
      .mockRejectedValueOnce(new Error('read failed'))
      .mockResolvedValue(true)
    await f.coordinator.send(ids[0], [{ kind: 'text', text: 'active' }], [], jobIds[0])
    await tick()
    await f.coordinator.send(ids[0], [{ kind: 'text', text: 'next' }], [], jobIds[1])
    f.workers[0].finish(jobIds[0])
    await tick()
    expect((await f.coordinator.history(ids[0])).queue!.blocked?.id).toBe(jobIds[0])
    expect(f.workers[0].runJobIds()).toHaveLength(1)
    pending = { kind: 'question', questions: [{ question: 'which?' }] }
    await f.coordinator.reconcileQueue(ids[0])
    await tick()
    expect(f.workers[0].runJobIds()).toHaveLength(1)
    await f.coordinator.resume(ids[0], ['answer'], jobIds[2])
    await tick()
    expect(f.workers[0].runJobIds().at(-1)).toBe(jobIds[2])
    pending = null
    f.workers[0].finish(jobIds[2])
    await tick()
    expect(f.workers[0].runJobIds().at(-1)).toBe(jobIds[1])
    f.workers[0].finish(jobIds[1])
    await tick()
    expect(saved).toHaveBeenCalledTimes(3)
    await f.coordinator.close()
  })

  it.each<NonNullable<AgentHistory['pending']>>([
    { kind: 'question', questions: [{ question: 'which?' }] },
    { kind: 'confirmation', message: 'confirm', fingerprint: 'test' },
  ])(
    'rechecks a failed pending read without recovering the healthy $kind checkpoint',
    async (pending) => {
      const f = fixture()
      vi.spyOn(f.agent, 'hasUserMessage').mockResolvedValue(true)
      const read = vi.spyOn(f.agent, 'rawPending').mockResolvedValue(null)
      await f.coordinator.send(ids[0], [{ kind: 'text', text: 'active' }], [], jobIds[0])
      await tick()
      await f.coordinator.send(ids[0], [{ kind: 'text', text: 'next' }], [], jobIds[1])
      read.mockRejectedValueOnce(new Error('temporary checkpoint read failure'))
      f.workers[0].event(jobIds[0], { conversationId: ids[0], kind: 'pending', pending })
      f.workers[0].finish(jobIds[0])
      await tick()
      expect((await f.coordinator.history(ids[0])).queue!.blocked?.id).toBe(jobIds[0])
      read.mockResolvedValue(pending)
      await f.coordinator.reconcileQueue(ids[0])
      expect(f.recoverInterruptedRun).not.toHaveBeenCalled()
      expect((await f.coordinator.history(ids[0])).queue!.blocked).toBeNull()
      expect(f.workers[0].runJobIds()).toEqual([jobIds[0]])
      expect(f.coordinator.list().find((item) => item.id === ids[0])?.activity).toBe('waiting')
      await f.coordinator.close()
    },
  )

  it('protects only attachments pinned by inputs or active jobs while allowing unrelated draft cleanup', async () => {
    const f = fixture()
    const fileId = '40000000-0000-4000-8000-000000000001'
    vi.spyOn(f.agent.files, 'get').mockReturnValue({
      id: fileId,
      conversationId: ids[0],
      name: 'a.txt',
      mimeType: 'text/plain',
      sizeBytes: 1,
      relativePath: 'a.txt',
    })
    const remove = vi.fn().mockResolvedValue(undefined)
    f.agent.removeUpload = remove
    await f.coordinator.send(ids[0], [{ kind: 'text', text: 'active' }], [fileId], jobIds[0])
    await tick()
    await expect(f.coordinator.removeUpload(ids[0], fileId)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    })
    await f.coordinator.removeUpload(ids[0], '40000000-0000-4000-8000-000000000002')
    expect(remove).toHaveBeenCalledOnce()
    f.workers[0].finish(jobIds[0])
    await tick()
    await f.coordinator.close()
  })

  it('returns a completed conversation to the end of the global ready FIFO', async () => {
    const f = fixture()
    for (let i = 0; i < 4; i++)
      await f.coordinator.send(ids[i], [{ kind: 'text', text: 'hello' }], [], jobIds[i])
    await tick()
    const next = '50000000-0000-4000-8000-000000000001'
    await f.coordinator.send(ids[0], [{ kind: 'text', text: 'next' }], [], next)
    f.workers[0].finish(jobIds[0])
    await tick()
    expect(f.workers[0].runJobIds()).toEqual([jobIds[0], jobIds[3]])
    expect(f.workers.flatMap((w) => w.runJobIds())).not.toContain(next)
    f.workers[1].finish(jobIds[1])
    await tick()
    expect(f.workers[1].runJobIds()).toEqual([jobIds[1], next])
    for (const worker of f.workers) worker.finish(worker.runJobIds().at(-1)!)
    await tick()
    await f.coordinator.close()
  })

  it('does not label an earlier history read with the cursor of a later usage event', async () => {
    const f = fixture()
    await f.coordinator.send(ids[0], [{ kind: 'text', text: 'hello' }], [], jobIds[0])
    await tick()
    let resolveHistory!: (history: AgentHistory) => void
    vi.spyOn(f.agent, 'history').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveHistory = resolve
        }),
    )
    const pending = f.coordinator.history(ids[0])
    f.workers[0].event(jobIds[0], {
      conversationId: ids[0],
      kind: 'usage',
      usage: { ...usage, contextTokens: 36000 },
    })
    const latestSequence = f.events.at(-1)!.sequence!
    resolveHistory({
      messages: [],
      pending: null,
      usage: { ...usage, contextTokens: 20000 },
      running: true,
    })
    const result = await pending
    expect(result.job!.sequence).toBeLessThan(latestSequence)
    await f.coordinator.close()
  })
  it('returns the original diagnostic reference when submitting a worker job fails', async () => {
    const cause = new Error('Worker channel unavailable')
    const original = FakeWorker.prototype.postMessage
    const post = vi.spyOn(FakeWorker.prototype, 'postMessage').mockImplementation(function (
      this: FakeWorker,
      request,
    ) {
      if (request.kind === 'run') throw cause
      original.call(this, request)
    })
    const { coordinator, events } = fixture()
    const context = newDiagnosticContext()
    try {
      await withDiagnosticContext(context, () =>
        coordinator.send(ids[0], [{ kind: 'text', text: 'first' }], [], jobIds[0]),
      )
      await tick()
      const diagnostic = withDiagnosticContext(context, () => findDiagnosticReference(cause))
      expect(diagnostic).toBeDefined()
      expect(events.find((event) => event.kind === 'error')?.diagnostic).toEqual(diagnostic)
      expect(diagnostic?.traceId).toBe(context.traceId)
    } finally {
      post.mockRestore()
      await coordinator.close()
    }
  })
  it('rejects a job ID reused by another conversation during acceptance', async () => {
    const { coordinator, workers } = fixture()
    try {
      const first = coordinator.send(ids[0], [{ kind: 'text', text: 'first' }], [], jobIds[0])
      await expect(
        coordinator.send(ids[1], [{ kind: 'text', text: 'second' }], [], jobIds[0]),
      ).rejects.toThrow('任务 ID 已被使用')
      expect((await first).conversationId).toBe(ids[0])
    } finally {
      await tick()
      for (const worker of workers) for (const jobId of worker.runJobIds()) worker.finish(jobId)
      await coordinator.close()
    }
  })

  it('runs three conversations, queues the fourth, and keeps streamed output isolated', async () => {
    const { coordinator, workers, events } = fixture()
    try {
      await Promise.all(
        ids.map((id, index) =>
          coordinator.send(id, [{ kind: 'text', text: id }], [], jobIds[index]),
        ),
      )
      await tick()
      expect(workers).toHaveLength(3)
      expect(workers.flatMap((worker) => worker.runJobIds()).sort()).toEqual(jobIds.slice(0, 3))
      expect(coordinator.list().find((item) => item.id === ids[3])?.queuePosition).toBe(1)

      workers[0].event(jobIds[0], { conversationId: ids[0], kind: 'token', text: '甲' })
      workers[1].event(jobIds[1], { conversationId: ids[1], kind: 'token', text: '乙' })
      expect((await coordinator.history(ids[0])).job?.liveText).toBe('甲')
      expect((await coordinator.history(ids[1])).job?.liveText).toBe('乙')
      expect((await coordinator.history(ids[2])).job?.liveText).toBe('')

      workers[1].finish(jobIds[1])
      await tick()
      expect(workers[1].runJobIds()).toEqual([jobIds[1], jobIds[3]])
      expect(coordinator.list().find((item) => item.id === ids[0])?.activity).toBe('running')
      expect(coordinator.list().find((item) => item.id === ids[2])?.activity).toBe('running')
      expect(
        events
          .filter((event) => event.kind === 'state' && event.state === 'running')
          .map((event) => event.jobId),
      ).toContain(jobIds[3])
      expect(
        events
          .filter((event) => event.kind !== 'queue')
          .every((event) => !!event.jobId && Number.isInteger(event.sequence)),
      ).toBe(true)
    } finally {
      for (const worker of workers) for (const jobId of worker.runJobIds()) worker.finish(jobId)
      await coordinator.close()
    }
  })

  it('cancels a queued conversation without stopping the three running jobs', async () => {
    const { coordinator, workers } = fixture()
    try {
      await Promise.all(
        ids.map((id, index) =>
          coordinator.send(id, [{ kind: 'text', text: id }], [], jobIds[index]),
        ),
      )
      await tick()
      coordinator.cancel(ids[3])
      expect((await coordinator.send(ids[3], [], [], jobIds[3])).status).toBe('cancelled')
      expect(workers.flatMap((worker) => worker.runJobIds())).not.toContain(jobIds[3])
      expect(coordinator.list().filter((item) => item.activity === 'running')).toHaveLength(3)
    } finally {
      for (const worker of workers) for (const jobId of worker.runJobIds()) worker.finish(jobId)
      await coordinator.close()
    }
  })

  it('recovers a crashed job and releases its worker slot', async () => {
    const { coordinator, workers, events, recoverInterruptedRun } = fixture()
    try {
      await coordinator.send(ids[0], [{ kind: 'text', text: 'hello' }], [], jobIds[0])
      await tick()
      workers[0].event(jobIds[0], { conversationId: ids[0], kind: 'token', text: 'partial' })
      workers[0].kill()
      await tick()
      expect(recoverInterruptedRun).toHaveBeenCalledWith(ids[0], 'partial')
      expect(events).toContainEqual(
        expect.objectContaining({
          jobId: jobIds[0],
          kind: 'error',
          submissionState: 'not-saved',
        }),
      )
      expect((await coordinator.send(ids[0], [], [], jobIds[0])).status).toBe('failed')
      expect(coordinator.list().find((item) => item.id === ids[0])?.activity).toBe('idle')
    } finally {
      await coordinator.close()
    }
  })

  it('stops retrying when utility processes cannot initialize', async () => {
    const { coordinator, workers, events } = fixture(true)
    try {
      await coordinator.send(ids[0], [{ kind: 'text', text: 'hello' }], [], jobIds[0])
      await tick()
      await tick()
      expect(workers).toHaveLength(3)
      expect((await coordinator.send(ids[0], [], [], jobIds[0])).status).toBe('failed')
      expect(events.some((event) => event.kind === 'error' && event.jobId === jobIds[0])).toBe(true)
    } finally {
      await coordinator.close()
    }
  })

  it('disconnects every active and queued conversation before an update', async () => {
    const { coordinator, workers, suspendForUpdate, resumeAfterUpdate } = fixture()
    await Promise.all(
      ids.map((id, index) => coordinator.send(id, [{ kind: 'text', text: id }], [], jobIds[index])),
    )
    await tick()
    const update = coordinator.suspendForUpdate()
    await tick()
    expect((await coordinator.send(ids[3], [], [], jobIds[3])).status).toBe('cancelled')
    expect(workers).toHaveLength(3)
    for (let index = 0; index < 3; index++) {
      expect(workers[index].requests).toContainEqual({ kind: 'cancel', jobId: jobIds[index] })
      workers[index].finish(jobIds[index])
    }
    await update
    expect(suspendForUpdate).toHaveBeenCalledOnce()
    expect(coordinator.list().every((item) => item.activity === 'idle')).toBe(true)
    expect(workers.every((worker) => worker.exited)).toBe(true)
    coordinator.resumeAfterUpdate()
    expect(resumeAfterUpdate).toHaveBeenCalledOnce()
    await coordinator.close()
  })
})
