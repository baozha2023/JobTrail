import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import type { ExamService } from '../src/main/services/exam-service'
import type { ConfigService } from '../src/main/config'
import { AppServiceError } from '../src/main/services/errors'
import type { SaveExamAnswerInput, GradeJob } from '../src/shared/exams'
const mocks = vi.hoisted(() => ({ fork: vi.fn(), model: vi.fn(), captureError: vi.fn() }))
vi.mock('electron', () => ({
  app: { getAppPath: () => '/app', getVersion: () => '1.3.0', isPackaged: false },
  utilityProcess: { fork: mocks.fork },
}))
vi.mock('../src/main/agent/model', () => ({ createAgentModel: mocks.model }))
vi.mock('../src/main/diagnostics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/diagnostics')>()),
  captureError: mocks.captureError.mockImplementation(() => ({ eventId: 'diagnostic-id' })),
  recordEvent: vi.fn(),
  forwardDiagnosticStderr: vi.fn(),
}))
import { ExamGrader } from '../src/main/agent/exam-grader'
afterEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
})
function fixture() {
  vi.useFakeTimers()
  const children: (EventEmitter & {
    postMessage: ReturnType<typeof vi.fn>
    kill: ReturnType<typeof vi.fn>
  })[] = []
  mocks.fork.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      postMessage: vi.fn(),
      kill: vi.fn(),
      stderr: null,
    })
    children.push(child)
    return child
  })
  const input: SaveExamAnswerInput = {
    conversationId: randomUUID(),
    paperId: randomUUID(),
    questionId: randomUUID(),
    value: 'answer',
    resetVersion: 0,
    expectedVersion: 1,
  }
  const paper = {
    resetVersion: 0,
    questions: [
      { id: input.questionId, answer: { version: 1, value: 'answer', gradeStatus: 'idle' } },
    ],
  }
  let count = 0
  const exams = {
    get: vi.fn(() => paper),
    beginGrade: vi.fn(
      () =>
        ({
          id: String(++count),
          identity: { conversationId: input.conversationId, paperId: input.paperId },
          questionId: input.questionId,
          answerVersion: 1,
          resetVersion: 0,
        }) as GradeJob,
    ),
    current: vi.fn<(job: GradeJob) => boolean>(() => true),
    gradeStatus: vi.fn(),
    finishGrade: vi.fn(),
    recordGradeUsage: vi.fn(),
  }
  const config = { reload: vi.fn(() => ({ ai: {} })) }
  const emit = vi.fn()
  const grader = new ExamGrader(
    exams as unknown as ExamService,
    config as unknown as ConfigService,
    emit,
    '/synthetic',
  )
  return { grader, exams, children, input, paper, config, emit }
}
it('limits grading to two workers and advances the separate queue after completion', () => {
  const f = fixture()
  try {
    for (let n = 0; n < 3; n++) f.grader.submit(f.input)
    expect(f.children).toHaveLength(2)
    f.children[0].emit('message', { kind: 'ready' })
    expect(f.children[0].postMessage).toHaveBeenCalledTimes(1)
    f.children[0].emit('message', { ok: true, result: { score: 80 } })
    expect(f.exams.finishGrade).toHaveBeenCalledTimes(1)
    expect(f.children).toHaveLength(3)
  } finally {
    f.grader.suspend()
  }
})
it('rejects missing API credentials before creating a grading job or starting a worker', () => {
  const f = fixture()
  mocks.model.mockImplementationOnce(() => {
    throw new AppServiceError('AI_API_KEY_EMPTY', '当前 API Key 为空')
  })
  expect(() => f.grader.submit(f.input)).toThrowError(
    expect.objectContaining({ code: 'AI_API_KEY_EMPTY' }),
  )
  expect(f.exams.beginGrade).not.toHaveBeenCalled()
  expect(f.exams.gradeStatus).not.toHaveBeenCalled()
  expect(mocks.fork).not.toHaveBeenCalled()
  expect(f.paper.questions[0].answer.value).toBe('answer')
})
it('rejects unknown grading fields before the duplicate-request shortcut', () => {
  const f = fixture()
  f.paper.questions[0].answer.gradeStatus = 'completed'
  expect(() => f.grader.submit({ ...f.input, extra: true } as SaveExamAnswerInput)).toThrowError(
    expect.objectContaining({ code: 'EXAM_INVALID' }),
  )
  expect(f.exams.get).not.toHaveBeenCalled()
})
it('handles configuration failure during the worker handshake without crashing Main', () => {
  const f = fixture()
  try {
    f.grader.submit(f.input)
    f.config.reload.mockImplementationOnce(() => {
      throw new Error('configuration unreadable')
    })
    expect(() => f.children[0].emit('message', { kind: 'ready' })).not.toThrow()
    expect(f.children[0].kill).toHaveBeenCalledOnce()
    expect(f.exams.gradeStatus).toHaveBeenLastCalledWith(expect.anything(), 'error')
  } finally {
    f.grader.suspend()
  }
})
it('cancels the previous worker when a direct grading request replaces its answer', () => {
  const f = fixture()
  try {
    f.grader.submit(f.input)
    const beginGrade = f.exams.beginGrade.getMockImplementation()!
    f.exams.beginGrade.mockImplementationOnce(() => {
      f.exams.current.mockImplementation((job) => job.id !== '1')
      return beginGrade()
    })
    f.grader.submit({ ...f.input, value: 'replacement answer' })
    expect(f.children[0].kill).toHaveBeenCalledOnce()
    expect(f.children).toHaveLength(2)
  } finally {
    f.grader.suspend()
  }
})
it.each(['queued', 'running', 'completed'])(
  'does not issue a duplicate request for the same %s answer',
  (status) => {
    const f = fixture()
    f.paper.questions[0].answer.gradeStatus = status
    expect(f.grader.submit(f.input)).toBe(f.paper)
    expect(f.exams.beginGrade).not.toHaveBeenCalled()
    expect(mocks.fork).not.toHaveBeenCalled()
    expect(mocks.model).not.toHaveBeenCalled()
  },
)
it('accounts returned usage when grading fails and marks the answer retryable', () => {
  const f = fixture()
  try {
    f.grader.submit(f.input)
    f.children[0].emit('message', { ok: false, usage: { input_tokens: 3, output_tokens: 4 } })
    expect(f.exams.recordGradeUsage).toHaveBeenCalledWith(expect.objectContaining({ id: '1' }), {
      input_tokens: 3,
      output_tokens: 4,
    })
    expect(f.exams.gradeStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: '1' }),
      'error',
    )
    f.children[0].emit('exit', 1)
    expect(f.exams.recordGradeUsage).toHaveBeenCalledTimes(1)
  } finally {
    f.grader.suspend()
  }
})
it('cancels invalidated answers without failure logs and ignores late worker replies', () => {
  const f = fixture()
  try {
    for (let n = 0; n < 3; n++) f.grader.submit(f.input)
    f.exams.current.mockImplementation((job: GradeJob) => job.id !== '1')
    f.exams.gradeStatus.mockClear()
    f.grader.cancelInvalid()
    expect(f.children[0].kill).toHaveBeenCalledOnce()
    expect(f.children).toHaveLength(3)
    f.children[0].emit('message', { kind: 'ready' })
    expect(f.children[0].postMessage).not.toHaveBeenCalled()
    f.children[0].emit('message', { ok: true, result: { score: 80 } })
    f.children[0].emit('exit', 1)
    expect(f.exams.finishGrade).not.toHaveBeenCalled()
    expect(f.exams.gradeStatus).not.toHaveBeenCalledWith(expect.anything(), 'error')
    expect(mocks.captureError).not.toHaveBeenCalled()
  } finally {
    f.grader.suspend()
  }
})

it('forwards the worker diagnostic to the global message path without recording a second exception', () => {
  const f = fixture()
  try {
    f.grader.submit(f.input)
    const diagnostic = { eventId: randomUUID(), traceId: randomUUID(), spanId: randomUUID() }
    f.children[0].emit('message', { ok: false, diagnostic })
    expect(f.emit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        error: { code: 'EXAM_GRADING_FAILED', message: 'EXAM_GRADING_FAILED', diagnostic },
      }),
    )
    expect(mocks.captureError).not.toHaveBeenCalled()
  } finally {
    f.grader.suspend()
  }
})
