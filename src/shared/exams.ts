import { z } from 'zod'

const text = z.string().trim().min(1).max(12000)
export const examQuestionSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('single_choice'),
    prompt: text,
    options: z.tuple([text, text, text, text]),
    correct: z.enum(['A', 'B', 'C', 'D']),
    explanation: text,
  }),
  z.strictObject({
    type: z.literal('true_false'),
    prompt: text,
    correct: z.boolean(),
    explanation: text,
  }),
  z.strictObject({ type: z.literal('short_answer'), prompt: text }),
])
// Creation accepts the private answer; public question DTOs omit it entirely.
export const examQuestionInputSchema = z.discriminatedUnion('type', [
  examQuestionSchema.options[0],
  examQuestionSchema.options[1],
  examQuestionSchema.options[2].extend({ defaultAnswer: text }),
])
export const examCountsSchema = z.strictObject({
  single_choice: z.number().int().min(0).max(100),
  true_false: z.number().int().min(0).max(100),
  short_answer: z.number().int().min(0).max(100),
})
export const createExamSchema = z.strictObject({
  conversationId: z.string().uuid(),
  requestId: z.string().min(1).max(200),
  taskId: z.string().min(1).max(200),
  title: z.string().trim().min(1).max(200),
  topic: text,
  difficulty: z.string().trim().min(1).max(200),
  counts: examCountsSchema,
})
export const appendExamSchema = z.strictObject({
  conversationId: z.string().uuid(),
  paperId: z.string().uuid(),
  requestId: z.string().min(1).max(200),
  question: examQuestionInputSchema,
})
export const examIdentitySchema = z.strictObject({
  conversationId: z.string().uuid(),
  paperId: z.string().uuid(),
})
export const examPdfExportSchema = examIdentitySchema.extend({
  answerPlacement: z.enum(['after_each', 'at_end']),
})
export const examPrintStateSchema = z.strictObject({
  jobId: z.string().uuid(),
  phase: z.enum(['ready', 'complete', 'failed']),
})
export type ExamPdfExportInput = z.infer<typeof examPdfExportSchema>
export type ExamPrintState = z.infer<typeof examPrintStateSchema>
// Only the isolated PDF renderer receives this snapshot, never the chat or ordinary exam API.
export interface ExamPdfSnapshot {
  title: string
  topic: string
  difficulty: string
  counts: z.infer<typeof examCountsSchema>
  status: ExamPaper['status']
  questions: {
    position: number
    content: ExamQuestionContent
    defaultAnswer: string | null
  }[]
}
export interface ExamPrintDocument {
  jobId: string
  locale: 'zh-CN' | 'en-US'
  answerPlacement: ExamPdfExportInput['answerPlacement']
  paper: ExamPdfSnapshot
}
export interface ExamPrintApi {
  onDocument(listener: (document: ExamPrintDocument) => void): () => void
  ready(): Promise<void>
  complete(success: boolean): Promise<void>
}
export const updateExamSchema = examIdentitySchema.extend({
  topic: text.optional(),
  difficulty: z.string().trim().min(1).max(200).optional(),
  counts: examCountsSchema.optional(),
})
export const gradeResultSchema = z.strictObject({
  score: z.number().min(0).max(100),
  evaluation: text,
  referenceAnswer: text,
})
export const saveExamAnswerSchema = examIdentitySchema.extend({
  questionId: z.string().uuid(),
  resetVersion: z.number().int().nonnegative(),
  expectedVersion: z.number().int().nonnegative(),
  value: z.union([z.string().max(30000), z.boolean(), z.null()]),
})
export type ExamQuestionContent = z.infer<typeof examQuestionSchema>
export type CreateExamInput = z.infer<typeof createExamSchema>
export type AppendExamInput = z.infer<typeof appendExamSchema>
export type ExamIdentity = z.infer<typeof examIdentitySchema>
export type SaveExamAnswerInput = z.infer<typeof saveExamAnswerSchema>
export type GradeResult = z.infer<typeof gradeResultSchema>
export type ExamResult =
  | GradeResult
  | { correct: boolean; answer: string | boolean; explanation: string }
export interface ExamAnswer {
  value: string | boolean | null
  version: number
  submitted: boolean
  result: ExamResult | null
  gradeRequestId: string | null
  gradeStatus: 'idle' | 'queued' | 'running' | 'completed' | 'error' | 'interrupted'
}
export interface ExamQuestion {
  id: string
  position: number
  content: ExamQuestionContent
  answer: ExamAnswer
}
export interface ExamPaper {
  id: string
  conversationId: string
  taskId: string
  title: string
  topic: string
  difficulty: string
  counts: z.infer<typeof examCountsSchema>
  status: 'generating' | 'completed' | 'interrupted'
  resetVersion: number
  revision: number
  createdAt: number
  updatedAt: number
  questions: ExamQuestion[]
}
export interface GradeJob {
  id: string
  identity: ExamIdentity
  questionId: string
  resetVersion: number
  answerVersion: number
  prompt: string
  answer: string
  topic: string
  difficulty: string
}
