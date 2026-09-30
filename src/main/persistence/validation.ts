import Database from 'better-sqlite3'
import { SCHEMA_V1 } from './schema-v1'
import { SCHEMA_V2 } from './schema-v2'
import { CHECKPOINT_SCHEMA } from './schema-checkpoint'
import { DatabaseVersionError } from './versions'
import { examQuestionSchema, examCountsSchema, gradeResultSchema } from '../../shared/exams'
import { z } from 'zod'
type Db = InstanceType<typeof Database>
export function validateDatabaseVersion(db: Db, version: number): void {
  const sql = version === 1 ? SCHEMA_V1 : version === 2 ? SCHEMA_V2 : null
  if (
    !sql ||
    db.pragma('user_version', { simple: true }) !== version ||
    db.pragma('integrity_check', { simple: true }) !== 'ok'
  )
    throw new DatabaseVersionError(version)
  const expected = new Database(':memory:')
  try {
    expected.exec(sql)
    if (
      db.prepare("SELECT 1 FROM sqlite_master WHERE name IN ('checkpoints','writes') LIMIT 1").get()
    )
      expected.exec(CHECKPOINT_SCHEMA)
    const rows = expected
      .prepare(
        "SELECT name, type, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'",
      )
      .all() as { name: string; type: string; sql: string }[]
    const normalize = (value: string) => value.replace(/\s+/g, ' ').trim()
    const actualNames = db
      .prepare("SELECT name FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[]
    if (
      actualNames.length !== rows.length ||
      actualNames.some((actual) => !rows.some((row) => row.name === actual.name))
    )
      throw new Error('Unexpected persistent schema')
    for (const row of rows) {
      const actual = db
        .prepare('SELECT type, sql FROM sqlite_master WHERE name = ?')
        .get(row.name) as { type: string; sql: string } | undefined
      if (!actual || actual.type !== row.type || normalize(actual.sql) !== normalize(row.sql))
        throw new Error(`Invalid persistent schema: ${row.name}`)
    }
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('trigger','view') LIMIT 1").get())
      throw new Error('Unexpected persistent schema')
    if (version === 2) validateExamData(db)
  } finally {
    expected.close()
  }
}

export function validateExamData(db: Db): void {
  if (
    db
      .prepare(
        'SELECT 1 FROM exam_papers p LEFT JOIN agent_conversations c ON c.id=p.conversation_id WHERE c.id IS NULL LIMIT 1',
      )
      .get() ||
    db
      .prepare(
        'SELECT 1 FROM exam_questions q LEFT JOIN exam_papers p ON p.id=q.paper_id WHERE p.id IS NULL LIMIT 1',
      )
      .get() ||
    db
      .prepare(
        'SELECT 1 FROM exam_answers a LEFT JOIN exam_questions q ON q.id=a.question_id WHERE q.id IS NULL OR q.paper_id<>a.paper_id LIMIT 1',
      )
      .get()
  )
    throw new Error('Invalid exam references')
  const papers = db.prepare('SELECT id,counts,status FROM exam_papers').all() as {
    id: string
    counts: string
    status: string
  }[]
  const objective = z.object({
    correct: z.boolean(),
    answer: z.union([z.string(), z.boolean()]),
    explanation: z.string(),
  })
  for (const paper of papers) {
    const counts = examCountsSchema.parse(JSON.parse(paper.counts))
    const questions = db
      .prepare('SELECT id,position,content FROM exam_questions WHERE paper_id=? ORDER BY position')
      .all(paper.id) as { id: string; position: number; content: string }[]
    const actual = { single_choice: 0, true_false: 0, short_answer: 0 }
    for (const [index, q] of questions.entries()) {
      if (q.position !== index + 1) throw new Error('Invalid question order')
      const content = examQuestionSchema.parse(JSON.parse(q.content))
      actual[content.type]++
      const a = db
        .prepare('SELECT value,result FROM exam_answers WHERE question_id=?')
        .get(q.id) as { value: string; result: string | null } | undefined
      if (a) {
        const value = JSON.parse(a.value)
        if (
          value !== null &&
          (content.type === 'short_answer'
            ? typeof value !== 'string'
            : content.type === 'true_false'
              ? typeof value !== 'boolean'
              : !['A', 'B', 'C', 'D'].includes(value))
        )
          throw new Error('Invalid saved answer')
        if (a.result)
          (content.type === 'short_answer' ? gradeResultSchema : objective).parse(
            JSON.parse(a.result),
          )
      }
    }
    for (const type of ['single_choice', 'true_false', 'short_answer'] as const)
      if (
        actual[type] > counts[type] ||
        (paper.status === 'completed' && actual[type] !== counts[type])
      )
        throw new Error('Invalid question count')
  }
}
