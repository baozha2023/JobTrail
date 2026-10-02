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
  constructor(private readonly failInit = false) {
    super()
    queueMicrotask(() => this.emit('spawn'))
  }
  postMessage(request: AgentWorkerRequest): void {
    this.requests.push(request)
    if (request.kind === 'init')
      queueMicrotask(() => {
        if (this.failInit) {
          this.emit('message', { kind: 'init-error', error: 'native module unavailable' })
        } else this.emit('message', { kind: 'ready' })
      })
    if (request.kind === 'close') queueMicrotask(() => this.kill())
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

function fixture(failInit = false) {
  const workers: FakeWorker[] = []
  mocks.fork.mockImplementation(() => {
    const worker = new FakeWorker(failInit)
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
      expect(events.every((event) => !!event.jobId && Number.isInteger(event.sequence))).toBe(true)
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
