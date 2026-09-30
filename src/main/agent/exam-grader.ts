import { AppServiceError } from '../services/errors'
import path from 'node:path'
import { app, utilityProcess, type UtilityProcess } from 'electron'
import type { ExamService } from '../services/exam-service'
import type { ConfigService } from '../config'
import {
  saveExamAnswerSchema,
  type ExamIdentity,
  type GradeJob,
  type SaveExamAnswerInput,
} from '../../shared/exams'
import { logFault, forwardDiagnosticStderr } from '../diagnostics'
import { createAgentModel } from './model'
export class ExamGrader {
  private queue: GradeJob[] = []
  private active = new Map<
    string,
    { job: GradeJob; process: UtilityProcess; timer: ReturnType<typeof setTimeout> }
  >()
  private paused = false
  constructor(
    private exams: ExamService,
    private config: ConfigService,
    private emit: (identity: ExamIdentity) => void,
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
    this.queue.push(job)
    this.emit(job.identity)
    this.pump()
    return this.exams.get(identity)
  }
  private pump() {
    while (!this.paused && this.active.size < 2 && this.queue.length) {
      const job = this.queue.shift()!
      if (!this.exams.current(job)) continue
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
        const timer = setTimeout(() => this.finish(job, false), 120000)
        this.active.set(job.id, { job, process: child, timer })
        child.on(
          'message',
          (message: {
            kind?: string
            ok: boolean
            result?: unknown
            usage?: Parameters<ExamService['finishGrade']>[2]
          }) => {
            try {
              if (message.kind === 'ready') {
                if (this.active.has(job.id)) child.postMessage({ job, ai: this.config.reload().ai })
              } else this.finish(job, message.ok, message.result, message.usage)
            } catch (error) {
              logFault('exam.grade-start', error)
              this.finish(job, false)
            }
          },
        )
        child.on('exit', () => this.finish(job, false))
      } catch (error) {
        logFault('exam.grade-start', error)
        this.finish(job, false)
        this.exams.gradeStatus(job, 'error')
        this.emit(job.identity)
      }
    }
  }
  private finish(
    job: GradeJob,
    ok: boolean,
    result?: unknown,
    usage?: Parameters<ExamService['finishGrade']>[2],
  ) {
    if (!this.stopWorker(job.id)) return
    try {
      if (ok) this.exams.finishGrade(job, result, usage)
      else {
        if (usage) this.exams.recordGradeUsage(job, usage)
        logFault('exam.grade', new AppServiceError('EXAM_GRADING_FAILED', 'Grading failed'))
        this.exams.gradeStatus(job, 'error')
      }
    } catch (error) {
      logFault('exam.grade-finish', error)
      try {
        this.exams.gradeStatus(job, 'error')
      } catch (statusError) {
        logFault('exam.grade-status', statusError)
      }
    }
    this.emit(job.identity)
    this.pump()
  }
  cancelInvalid() {
    this.queue = this.queue.filter((job) => this.exams.current(job))
    for (const { job } of this.active.values())
      if (!this.exams.current(job)) this.stopWorker(job.id)
    this.pump()
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
        this.exams.gradeStatus(job, 'interrupted')
        this.emit(job.identity)
      } catch (error) {
        logFault('exam.grade-suspend', error)
      }
  }
  resume() {
    this.exams.recover()
    this.paused = false
    this.pump()
  }
}
