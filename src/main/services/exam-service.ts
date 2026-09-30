import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import {
  appendExamSchema,
  createExamSchema,
  updateExamSchema,
  examIdentitySchema,
  saveExamAnswerSchema,
  gradeResultSchema,
  type ExamIdentity,
  type SaveExamAnswerInput,
  type GradeJob,
  type ExamPaper,
} from '../../shared/exams'
import { ExamRepository } from '../repositories/exam-repository'
import type { UnitOfWork } from './unit-of-work'
import { AppServiceError } from './errors'
function invalid(message: string): never {
  throw new AppServiceError('EXAM_INVALID', message)
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) return invalid('Invalid exam input')
  return result.data
}
export class ExamService {
  constructor(
    private readonly unit: UnitOfWork,
    private readonly repository: ExamRepository,
  ) {}
  get(input: ExamIdentity): ExamPaper {
    return this.read(parse(examIdentitySchema, input))
  }
  private read(identity: ExamIdentity): ExamPaper {
    const paper = this.repository.get(identity.paperId)
    if (
      !paper ||
      paper.conversationId !== identity.conversationId ||
      !this.repository.conversationExists(identity.conversationId)
    )
      throw new AppServiceError('EXAM_NOT_FOUND', 'Paper not found')
    return paper
  }
  create(input: unknown) {
    const args = parse(createExamSchema, input)
    return this.unit.run(() => {
      if (Object.values(args.counts).reduce((a, b) => a + b, 0) === 0) invalid('题量须大于零')
      if (!this.repository.conversationExists(args.conversationId)) invalid('对话不存在')
      const existing = this.repository.findRequest(args.requestId)
      if (existing) {
        const paper = this.read({ conversationId: args.conversationId, paperId: existing })
        if (
          paper.title !== args.title ||
          paper.topic !== args.topic ||
          paper.difficulty !== args.difficulty ||
          JSON.stringify(paper.counts) !== JSON.stringify(args.counts)
        )
          invalid('重复请求内容不一致')
        return paper
      }
      const id = randomUUID()
      this.repository.create(id, args)
      return this.read({ conversationId: args.conversationId, paperId: id })
    })
  }
  update(input: unknown) {
    const args = parse(updateExamSchema, input)
    if (args.topic === undefined && args.difficulty === undefined && args.counts === undefined)
      invalid('No exam settings were supplied')
    return this.unit.run(() => {
      const paper = this.read(args)
      const topic = args.topic ?? paper.topic
      const difficulty = args.difficulty ?? paper.difficulty
      const counts = args.counts ?? paper.counts
      if (Object.values(counts).reduce((total, count) => total + count, 0) === 0)
        invalid('Question count must be positive')
      let fulfilled = true
      let countsChanged = false
      for (const type of ['single_choice', 'true_false', 'short_answer'] as const) {
        const generated = paper.questions.filter((q) => q.content.type === type).length
        if (counts[type] < generated)
          throw new AppServiceError(
            'EXAM_COUNTS_TOO_SMALL',
            'Counts cannot be lower than generated questions',
          )
        if (counts[type] !== generated) fulfilled = false
        if (counts[type] !== paper.counts[type]) countsChanged = true
      }
      if (topic === paper.topic && difficulty === paper.difficulty && !countsChanged) return paper
      // Increasing a completed paper's quota makes it resumable without starting a worker.
      const status = countsChanged
        ? fulfilled
          ? 'completed'
          : paper.status === 'completed'
            ? 'interrupted'
            : paper.status
        : paper.status
      this.repository.updateSettings(paper.id, { topic, difficulty, counts, status })
      return this.read(args)
    })
  }
  append(input: unknown) {
    const args = parse(appendExamSchema, input)
    return this.unit.run(() => {
      const paper = this.read(args)
      const old = this.repository.questionRequest(args.requestId)
      if (old) {
        if (old.paperId !== paper.id || old.content !== JSON.stringify(args.question))
          invalid('重复请求内容不一致')
        return paper
      }
      if (paper.status === 'completed') invalid('试卷已经完成')
      if (
        paper.questions.filter((q) => q.content.type === args.question.type).length >=
        paper.counts[args.question.type]
      )
        invalid('该题型已达到约定数量')
      this.repository.append(randomUUID(), paper, args.requestId, args.question)
      return this.read(args)
    })
  }
  complete(input: ExamIdentity) {
    const identity = parse(examIdentitySchema, input)
    return this.unit.run(() => {
      const paper = this.read(identity)
      for (const type of ['single_choice', 'true_false', 'short_answer'] as const)
        if (paper.questions.filter((q) => q.content.type === type).length !== paper.counts[type])
          invalid('题量未达到约定数量')
      if (paper.status === 'completed') return paper
      this.repository.status(paper.id, 'completed')
      return this.read(identity)
    })
  }
  save(input: SaveExamAnswerInput) {
    const args = parse(saveExamAnswerSchema, input)
    return this.unit.run(() => {
      const paper = this.read(args)
      const question = paper.questions.find((q) => q.id === args.questionId)
      if (!question) invalid('题目不存在')
      if (
        paper.resetVersion !== args.resetVersion ||
        question.answer.version !== args.expectedVersion
      )
        throw new AppServiceError('EXAM_CONFLICT', 'Stale answer version')
      const value = args.value
      const type = question.content.type
      if (
        value !== null &&
        (type === 'true_false'
          ? typeof value !== 'boolean'
          : type === 'single_choice'
            ? !['A', 'B', 'C', 'D'].includes(String(value))
            : typeof value !== 'string')
      )
        invalid('答案格式无效')
      if (value !== question.answer.value)
        this.repository.save(paper.id, args.questionId, value, args.expectedVersion + 1)
      return this.read(args)
    })
  }
  submit(input: SaveExamAnswerInput) {
    return this.unit.run(() => {
      const paper = this.save(input)
      const question = paper.questions.find((q) => q.id === input.questionId)!
      if (question.content.type === 'short_answer' || question.answer.value === null)
        invalid('请先作答')
      this.repository.result(paper.id, question.id, {
        correct: question.answer.value === question.content.correct,
        answer: question.content.correct,
        explanation: question.content.explanation,
      })
      return this.read(input)
    })
  }
  reset(input: ExamIdentity) {
    const identity = parse(examIdentitySchema, input)
    return this.unit.run(() => {
      const paper = this.read(identity)
      this.repository.reset(paper.id)
      return this.read(identity)
    })
  }
  beginGrade(input: SaveExamAnswerInput): GradeJob {
    return this.unit.run(() => {
      const paper = this.save(input)
      const q = paper.questions.find((q) => q.id === input.questionId)!
      if (
        q.content.type !== 'short_answer' ||
        typeof q.answer.value !== 'string' ||
        !q.answer.value.trim()
      )
        invalid('请填写简答题答案')
      if (['queued', 'running'].includes(q.answer.gradeStatus))
        throw new AppServiceError('EXAM_ALREADY_GRADING', 'Already grading')
      const id = randomUUID()
      this.repository.grade(paper.id, q.id, id, 'queued')
      return {
        id,
        identity: { conversationId: paper.conversationId, paperId: paper.id },
        questionId: q.id,
        resetVersion: paper.resetVersion,
        answerVersion: q.answer.version,
        prompt: q.content.prompt,
        answer: String(q.answer.value),
        topic: paper.topic,
        difficulty: paper.difficulty,
      }
    })
  }
  current(job: GradeJob): boolean {
    try {
      const p = this.read(job.identity),
        q = p.questions.find((q) => q.id === job.questionId)
      return (
        p.resetVersion === job.resetVersion &&
        q?.answer.version === job.answerVersion &&
        q.answer.gradeRequestId === job.id
      )
    } catch (error) {
      if (error instanceof AppServiceError && error.code === 'EXAM_NOT_FOUND') return false
      throw error
    }
  }
  finishGrade(job: GradeJob, result: unknown, usage?: Parameters<ExamRepository['usage']>[2]) {
    this.recordGradeUsage(job, usage)
    this.unit.run(() => {
      if (this.current(job))
        this.repository.result(
          job.identity.paperId,
          job.questionId,
          gradeResultSchema.parse(result),
        )
    })
  }
  recordGradeUsage(job: GradeJob, usage?: Parameters<ExamRepository['usage']>[2]) {
    this.unit.run(() => {
      if (this.repository.conversationExists(job.identity.conversationId))
        this.repository.usage(job.id, job.identity.conversationId, usage)
    })
  }
  gradeStatus(job: GradeJob, status: 'running' | 'error' | 'interrupted') {
    this.unit.run(() => {
      if (this.current(job))
        this.repository.grade(job.identity.paperId, job.questionId, job.id, status)
    })
  }
  recover() {
    this.unit.run(() => this.repository.interrupt())
  }
  interruptGeneration(id: string) {
    this.unit.run(() => this.repository.interruptGeneration(id))
  }
  deleteConversation(id: string) {
    this.unit.run(() => this.repository.deleteConversation(id))
  }
}
