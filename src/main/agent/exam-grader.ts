import {
  newDiagnosticContext,
  type DiagnosticContext,
  type DiagnosticReference,
} from '../../shared/diagnostics'
import type { ExamChangeEvent } from '../../shared/types'
import { AppServiceError } from '../services/errors'
import path from 'node:path'
import { app, utilityProcess, type UtilityProcess } from 'electron'
import type { ExamService } from '../services/exam-service'
import type { ConfigService } from '../config'
import { saveExamAnswerSchema, type GradeJob, type SaveExamAnswerInput } from '../../shared/exams'
import {
  captureError,
  forwardDiagnosticStderr,
  currentDiagnosticContext,
  withDiagnosticContext,
  recordEvent,
} from '../diagnostics'
import { createAgentModel } from './model'
export class ExamGrader {
  private queue: GradeJob[] = []
  private contexts = new Map<string, DiagnosticContext>()
  private active = new Map<
    string,
    { job: GradeJob; process: UtilityProcess; timer: ReturnType<typeof setTimeout> }
  >()
  private paused = false
  constructor(
    private exams: ExamService,
    private config: ConfigService,
    private emit: (identity: ExamChangeEvent) => void,
    private root: string,
  ) {}
  submit(input: SaveExamAnswerInput) {
    if (this.paused) throw new AppServiceError('EXAM_UNAVAILABLE', 'Grading unavailable')
    const parsed = saveExamAnswerSchema.safeParse(input)
    if (!parsed.success) throw new AppServiceError('EXAM_INVALID', 'Invalid grading input')
    input = parsed.data
    const identity = { conversationId: input.conversationId, paperId: input.paperId }
    const paper = this.exams.get(identity)
    const answer = paper.questions.find((q) => q.id === input.questionId)?.answer
    if (
      paper.resetVersion === input.resetVersion &&
      answer?.version === input.expectedVersion &&
      answer.value === input.value &&
      ['queued', 'running', 'completed'].includes(answer.gradeStatus)
    )
      return paper
    createAgentModel(this.config.reload().ai)
    const job = this.exams.beginGrade(input)
    this.cancelInvalid()
    this.contexts.set(job.id, newDiagnosticContext(currentDiagnosticContext()))
    recordEvent({ operation: 'exam.grade', outcome: 'started' }, this.contexts.get(job.id))
    this.queue.push(job)
    this.emit(job.identity)
    this.pump()
    return this.exams.get(identity)
  }
  private pump() {
    while (!this.paused && this.active.size < 2 && this.queue.length) {
      const job = this.queue.shift()!
      if (!this.exams.current(job)) {
        this.cancelContext(job.id)
        continue
      }
      try {
        this.exams.gradeStatus(job, 'running')
        const child = utilityProcess.fork(
          path.join(app.getAppPath(), 'out/main/grade-worker.js'),
          [],
          {
            serviceName: 'JobTrail Exam Grader',
            stdio: 'pipe',
            env: {
              ...process.env,
              JOBTRAIL_LOG_ROOT: this.root,
              JOBTRAIL_LOG_VERSION: app.getVersion(),
              JOBTRAIL_LOG_PACKAGED: app.isPackaged ? '1' : '0',
            },
          },
        )
        forwardDiagnosticStderr(child.stderr)
        const timer = setTimeout(() => {
          const diagnostic = captureError(
            { code: 'EXAM_GRADING_TIMEOUT', message: 'Grading exceeded 120 seconds' },
            { operation: 'exam.grade-timeout', ...this.contexts.get(job.id) },
          )
          this.finish(job, false, undefined, undefined, diagnostic)
        }, 120000)
        this.active.set(job.id, { job, process: child, timer })
        child.on(
          'message',
          (message: {
            diagnostic?: DiagnosticReference
            kind?: string
            ok: boolean
            result?: unknown
            usage?: Parameters<ExamService['finishGrade']>[2]
          }) => {
            try {
              if (message.kind === 'ready') {
                if (this.active.has(job.id))
                  child.postMessage({
                    job,
                    context: this.contexts.get(job.id),
                    ai: this.config.reload().ai,
                  })
              } else this.finish(job, message.ok, message.result, message.usage, message.diagnostic)
            } catch (error) {
              const diagnostic = captureError(error, {
                operation: 'exam.grade-start',
                ...this.contexts.get(job.id),
              })
              this.finish(job, false, undefined, undefined, diagnostic)
            }
          },
        )
        child.on('exit', () => this.finish(job, false))
      } catch (error) {
        const diagnostic = captureError(error, {
          operation: 'exam.grade-start',
          ...this.contexts.get(job.id),
        })
        recordEvent(
          {
            operation: 'exam.grade',
            outcome: 'failed',
            attributes: { relatedEventId: diagnostic.eventId },
          },
          this.contexts.get(job.id),
        )
        this.contexts.delete(job.id)
        this.stopWorker(job.id)
        this.exams.gradeStatus(job, 'error')
        this.emit({
          ...job.identity,
          error: { code: 'EXAM_GRADING_FAILED', message: 'EXAM_GRADING_FAILED', diagnostic },
        })
      }
    }
  }
  private finish(
    job: GradeJob,
    ok: boolean,
    result?: unknown,
    usage?: Parameters<ExamService['finishGrade']>[2],
    diagnostic?: DiagnosticReference,
  ) {
    const context = this.contexts.get(job.id) ?? newDiagnosticContext()
    withDiagnosticContext(context, () => this.finishInContext(job, ok, result, usage, diagnostic))
    this.contexts.delete(job.id)
  }
  private finishInContext(
    job: GradeJob,
    ok: boolean,
    result?: unknown,
    usage?: Parameters<ExamService['finishGrade']>[2],
    diagnostic?: DiagnosticReference,
  ) {
    if (!this.stopWorker(job.id)) return
    let failure: DiagnosticReference | undefined
    try {
      if (ok) {
        this.exams.finishGrade(job, result, usage)
        recordEvent({ operation: 'exam.grade', outcome: 'succeeded' })
      } else {
        if (usage) this.exams.recordGradeUsage(job, usage)
        const reference =
          diagnostic ??
          captureError(
            new AppServiceError('EXAM_GRADING_FAILED', 'Grading worker exited without a result'),
            { operation: 'exam.grade' },
          )
        recordEvent({
          operation: 'exam.grade',
          outcome: 'failed',
          attributes: { relatedEventId: reference.eventId },
        })
        this.exams.gradeStatus(job, 'error')
        failure = reference
      }
    } catch (error) {
      failure = captureError(error, { operation: 'exam.grade-finish' })
      try {
        this.exams.gradeStatus(job, 'error')
      } catch (statusError) {
        captureError(statusError, { operation: 'exam.grade-status' })
      }
    }
    this.emit({
      ...job.identity,
      ...(failure
        ? {
            error: {
              code: 'EXAM_GRADING_FAILED' as const,
              message: 'EXAM_GRADING_FAILED',
              diagnostic: failure,
            },
          }
        : {}),
    })
    this.pump()
  }
  cancelInvalid() {
    this.queue = this.queue.filter((job) => {
      if (this.exams.current(job)) return true
      this.cancelContext(job.id)
      return false
    })
    for (const { job } of this.active.values())
      if (!this.exams.current(job)) {
        this.cancelContext(job.id)
        this.stopWorker(job.id)
      }
    this.pump()
  }
  private cancelContext(id: string): void {
    const context = this.contexts.get(id)
    if (context) recordEvent({ operation: 'exam.grade', outcome: 'cancelled' }, context)
    this.contexts.delete(id)
  }
  private stopWorker(id: string): boolean {
    const active = this.active.get(id)
    if (!active) return false
    this.active.delete(id)
    clearTimeout(active.timer)
    active.process.kill()
    return true
  }
  suspend() {
    this.paused = true
    const jobs = [...this.queue, ...[...this.active.values()].map((a) => a.job)]
    this.queue = []
    for (const id of this.active.keys()) this.stopWorker(id)
    for (const job of jobs)
      try {
        this.cancelContext(job.id)
        this.exams.gradeStatus(job, 'interrupted')
        this.emit(job.identity)
      } catch (error) {
        captureError(error, { operation: 'exam.grade-suspend' })
      }
  }
  resume() {
    this.exams.recover()
    this.paused = false
    this.pump()
  }
}
