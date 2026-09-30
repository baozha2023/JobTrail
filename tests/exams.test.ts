import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createServiceContainer } from '../src/main/service-container'
import { examQuestionSchema, type SaveExamAnswerInput } from '../src/shared/exams'
const cleanups: (() => void)[] = []
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
)
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-service-'))
  const paths = {
    root,
    data: path.join(root, 'data'),
    database: path.join(root, 'data/zhiji.db'),
    config: path.join(root, 'config.json'),
    resumes: path.join(root, 'resumes'),
    chatUploads: path.join(root, 'chat-uploads'),
  }
  const c = createServiceContainer(paths, false)
  cleanups.push(() => {
    c.database.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const conversationId = randomUUID()
  c.database.db
    .prepare('INSERT INTO agent_conversations (id,title,created_at,updated_at) VALUES (?,?,?,?)')
    .run(conversationId, 'Exam', 1, 1)
  const exam = c.services.exams
  const paper = exam.create({
    conversationId,
    requestId: randomUUID(),
    taskId: randomUUID(),
    title: 'Test',
    topic: 'TypeScript',
    difficulty: 'Medium',
    counts: { single_choice: 1, true_false: 1, short_answer: 1 },
  })
  const identity = { conversationId, paperId: paper.id }
  return { ...c, exam, identity }
}
describe('practice exams', () => {
  it('rejects unknown identity fields and keeps completion retries idempotent', () => {
    const f = fixture()
    const invalid = { ...f.identity, extra: true }
    for (const operation of ['get', 'reset', 'complete'] as const)
      expect(() => f.exam[operation](invalid)).toThrow(
        expect.objectContaining({ code: 'EXAM_INVALID' }),
      )
    f.exam.append({
      ...f.identity,
      requestId: randomUUID(),
      question: { type: 'true_false', prompt: '1=1', correct: true, explanation: 'Identity' },
    })
    const completed = f.exam.update({
      ...f.identity,
      counts: { single_choice: 0, true_false: 1, short_answer: 0 },
    })
    expect(f.exam.complete(f.identity)).toEqual(completed)
  })
  it('updates paper settings, preserves submitted answers, and resumes the same completed paper', () => {
    const f = fixture()
    const p = f.exam.append({
      ...f.identity,
      requestId: randomUUID(),
      question: { type: 'true_false', prompt: '1=1', correct: true, explanation: 'Identity' },
    })
    f.exam.submit({
      ...f.identity,
      questionId: p.questions[0].id,
      resetVersion: 0,
      expectedVersion: 0,
      value: true,
    })
    const completed = f.exam.update({
      ...f.identity,
      counts: { single_choice: 0, true_false: 1, short_answer: 0 },
    })
    expect(completed.status).toBe('completed')
    const patch = {
      ...f.identity,
      topic: 'JavaScript',
      difficulty: 'Hard',
      counts: { single_choice: 0, true_false: 1, short_answer: 1 },
    }
    const updated = f.exam.update(patch)
    expect(updated).toMatchObject({
      topic: 'JavaScript',
      difficulty: 'Hard',
      status: 'interrupted',
    })
    expect(updated.questions).toEqual(completed.questions)
    expect(updated.resetVersion).toBe(completed.resetVersion)
    expect(f.exam.update(patch)).toEqual(updated)
    f.exam.append({
      ...f.identity,
      requestId: randomUUID(),
      question: { type: 'short_answer', prompt: 'Explain event loops' },
    })
    expect(f.exam.complete(f.identity).status).toBe('completed')
    expect(
      f.database.db.prepare("SELECT * FROM agent_chat_events WHERE kind='exam-paper'").all(),
    ).toHaveLength(1)
  })
  it('rejects invalid settings and lower counts atomically, enforcing conversation ownership', () => {
    const f = fixture()
    f.exam.append({
      ...f.identity,
      requestId: randomUUID(),
      question: { type: 'true_false', prompt: '1=1', correct: true, explanation: 'Identity' },
    })
    const before = f.exam.get(f.identity)
    expect(() =>
      f.exam.update({
        ...f.identity,
        topic: 'Should not be written',
        counts: { single_choice: 1, true_false: 0, short_answer: 0 },
      }),
    ).toThrow(expect.objectContaining({ code: 'EXAM_COUNTS_TOO_SMALL' }))
    for (const patch of [
      {},
      { difficulty: '' },
      { counts: { single_choice: 0, true_false: 0, short_answer: 0 } },
      { counts: { true_false: 2 } },
      { title: 'unsupported' },
    ])
      expect(() => f.exam.update({ ...f.identity, ...patch })).toThrow()
    expect(() =>
      f.exam.update({ ...f.identity, conversationId: randomUUID(), topic: 'Wrong owner' }),
    ).toThrow(expect.objectContaining({ code: 'EXAM_NOT_FOUND' }))
    expect(f.exam.get(f.identity)).toEqual(before)
  })
  it('validates four options and creates exactly one card atomically across retries', () => {
    const f = fixture(),
      requestId = randomUUID()
    const question = {
      type: 'single_choice' as const,
      prompt: '2+2?',
      options: ['1', '2', '3', '4'] as [string, string, string, string],
      correct: 'D' as const,
      explanation: 'Addition',
    }
    expect(examQuestionSchema.safeParse({ ...question, options: ['1', '4'] }).success).toBe(false)
    const p = f.exam.append({ ...f.identity, requestId, question })
    expect(f.exam.append({ ...f.identity, requestId, question }).questions).toHaveLength(1)
    expect(
      f.database.db.prepare("SELECT * FROM agent_chat_events WHERE kind='exam-paper'").all(),
    ).toHaveLength(1)
    expect(() =>
      f.exam.append({ ...f.identity, requestId, question: { ...question, prompt: 'different' } }),
    ).toThrow()
    expect(() => f.exam.get({ ...f.identity, conversationId: randomUUID() })).toThrow()
    const answer: SaveExamAnswerInput = {
      ...f.identity,
      questionId: p.questions[0].id,
      resetVersion: 0,
      expectedVersion: 0,
      value: 'D',
    }
    const submitted = f.exam.submit(answer)
    expect(submitted.questions[0].answer.result).toMatchObject({ correct: true })
    const changed = f.exam.save({ ...answer, expectedVersion: 1, value: 'A' })
    expect(changed.questions[0].answer.result).toBeNull()
    expect(() => f.exam.save(answer)).toThrow()
    const reset = f.exam.reset(f.identity)
    expect(reset.resetVersion).toBe(1)
    expect(reset.questions[0].answer.value).toBeNull()
    expect(() => f.exam.save({ ...answer, expectedVersion: 0 })).toThrow()
  })
  it('rejects late grading after edits or reset, counts usage once, and cleans deleted chats', () => {
    const f = fixture()
    const p = f.exam.append({
      ...f.identity,
      requestId: randomUUID(),
      question: { type: 'short_answer', prompt: 'Explain a promise' },
    })
    const input = {
      ...f.identity,
      questionId: p.questions[0].id,
      resetVersion: 0,
      expectedVersion: 0,
      value: 'A future value',
    }
    const job = f.exam.beginGrade(input)
    expect(() => f.exam.beginGrade({ ...input, expectedVersion: 1 })).toThrow()
    f.exam.reset(f.identity)
    f.exam.finishGrade(
      job,
      { score: 80, evaluation: 'Good', referenceAnswer: 'Future completion' },
      { input_tokens: 10, output_tokens: 20 },
    )
    f.exam.finishGrade(
      job,
      { score: 80, evaluation: 'Good', referenceAnswer: 'Future completion' },
      { input_tokens: 10, output_tokens: 20 },
    )
    expect(f.exam.get(f.identity).questions[0].answer.result).toBeNull()
    expect(
      f.database.db.prepare("SELECT * FROM agent_model_usage WHERE kind='grade'").all(),
    ).toHaveLength(1)
    const next = f.exam.beginGrade({ ...input, resetVersion: 1 })
    f.exam.finishGrade(next, { score: 90, evaluation: 'Correct', referenceAnswer: 'Async result' })
    expect(f.exam.get(f.identity).questions[0].answer.result).toMatchObject({ score: 90 })
    f.exam.deleteConversation(f.identity.conversationId)
    for (const table of ['exam_papers', 'exam_questions', 'exam_answers'])
      expect(f.database.db.prepare(`SELECT * FROM ${table}`).all()).toHaveLength(0)
  })
  it('keeps partial papers after interruption and enforces per-type counts', () => {
    const f = fixture()
    expect(() => f.exam.complete(f.identity)).toThrow()
    f.exam.append({
      ...f.identity,
      requestId: randomUUID(),
      question: { type: 'true_false', prompt: '1=1', correct: true, explanation: 'Identity' },
    })
    f.exam.interruptGeneration(f.identity.conversationId)
    expect(f.exam.get(f.identity).status).toBe('interrupted')
    expect(() =>
      f.exam.append({
        ...f.identity,
        requestId: randomUUID(),
        question: { type: 'true_false', prompt: '2=2', correct: true, explanation: 'Identity' },
      }),
    ).toThrow()
  })
  it('retains charged usage when a grader returns invalid structured output', () => {
    const f = fixture()
    const p = f.exam.append({
      ...f.identity,
      requestId: randomUUID(),
      question: { type: 'short_answer', prompt: 'Explain a promise' },
    })
    const job = f.exam.beginGrade({
      ...f.identity,
      questionId: p.questions[0].id,
      resetVersion: 0,
      expectedVersion: 0,
      value: 'An asynchronous result',
    })
    expect(() =>
      f.exam.finishGrade(job, { score: 150 }, { input_tokens: 9, output_tokens: 7 }),
    ).toThrow()
    expect(f.exam.get(f.identity).questions[0].answer.result).toBeNull()
    expect(
      f.database.db
        .prepare("SELECT input_tokens, output_tokens FROM agent_model_usage WHERE kind='grade'")
        .get(),
    ).toEqual({ input_tokens: 9, output_tokens: 7 })
  })
})
