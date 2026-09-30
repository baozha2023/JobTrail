import type Database from 'better-sqlite3'
import type {
  ExamPaper,
  ExamAnswer,
  CreateExamInput,
  ExamQuestionContent,
  ExamResult,
} from '../../shared/exams'
type Db = InstanceType<typeof Database>
export class ExamRepository {
  constructor(readonly db: Db) {}
  conversationExists(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM agent_conversations WHERE id=? AND deleting=0').get(id)
  }
  findRequest(requestId: string): string | undefined {
    return (
      this.db.prepare('SELECT id FROM exam_papers WHERE request_id=?').get(requestId) as
        | { id: string }
        | undefined
    )?.id
  }
  create(id: string, input: CreateExamInput): void {
    const now = Date.now()
    this.db
      .prepare(
        "INSERT INTO exam_papers (id,conversation_id,request_id,task_id,title,topic,difficulty,counts,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,'generating',?,?)",
      )
      .run(
        id,
        input.conversationId,
        input.requestId,
        input.taskId,
        input.title,
        input.topic,
        input.difficulty,
        JSON.stringify(input.counts),
        now,
        now,
      )
  }
  get(id: string): ExamPaper | undefined {
    const row = this.db
      .prepare(
        'SELECT id,conversation_id AS conversationId,task_id AS taskId,title,topic,difficulty,counts,status,reset_version AS resetVersion,revision,created_at AS createdAt,updated_at AS updatedAt FROM exam_papers WHERE id=?',
      )
      .get(id) as (Omit<ExamPaper, 'counts' | 'questions'> & { counts: string }) | undefined
    if (!row) return undefined
    const questions = this.db
      .prepare('SELECT id,position,content FROM exam_questions WHERE paper_id=? ORDER BY position')
      .all(id) as { id: string; position: number; content: string }[]
    return {
      ...row,
      counts: JSON.parse(row.counts),
      questions: questions.map((q) => ({
        ...q,
        content: JSON.parse(q.content),
        answer: this.answer(q.id),
      })),
    }
  }
  answer(id: string): ExamAnswer {
    const row = this.db
      .prepare(
        'SELECT value,version,submitted,result,grade_request_id AS gradeRequestId,grade_status AS gradeStatus FROM exam_answers WHERE question_id=?',
      )
      .get(id) as
      | {
          value: string
          version: number
          submitted: number
          result: string | null
          gradeRequestId: string | null
          gradeStatus: ExamAnswer['gradeStatus']
        }
      | undefined
    return row
      ? {
          ...row,
          value: JSON.parse(row.value),
          submitted: !!row.submitted,
          result: row.result ? JSON.parse(row.result) : null,
        }
      : {
          value: null,
          version: 0,
          submitted: false,
          result: null,
          gradeRequestId: null,
          gradeStatus: 'idle',
        }
  }
  append(id: string, paper: ExamPaper, requestId: string, content: ExamQuestionContent): void {
    this.db
      .prepare(
        'INSERT INTO exam_questions (id,paper_id,request_id,position,content) VALUES (?,?,?,?,?)',
      )
      .run(id, paper.id, requestId, paper.questions.length + 1, JSON.stringify(content))
    if (!paper.questions.length) {
      const message = {
        id: `exam:${paper.id}`,
        role: 'exam-paper',
        paperId: paper.id,
        attachments: [],
      }
      this.db
        .prepare(
          'INSERT INTO agent_chat_events (id,conversation_id,kind,payload,created_at) VALUES (?,?,?,?,?)',
        )
        .run(message.id, paper.conversationId, message.role, JSON.stringify(message), Date.now())
    }
    this.status(paper.id, 'generating')
  }
  questionRequest(requestId: string) {
    return this.db
      .prepare('SELECT id,paper_id AS paperId,content FROM exam_questions WHERE request_id=?')
      .get(requestId) as { id: string; paperId: string; content: string } | undefined
  }
  touch(id: string) {
    this.db
      .prepare('UPDATE exam_papers SET revision=revision+1,updated_at=? WHERE id=?')
      .run(Date.now(), id)
  }
  updateSettings(
    id: string,
    settings: Pick<ExamPaper, 'topic' | 'difficulty' | 'counts' | 'status'>,
  ) {
    this.db
      .prepare('UPDATE exam_papers SET topic=?,difficulty=?,counts=?,status=? WHERE id=?')
      .run(
        settings.topic,
        settings.difficulty,
        JSON.stringify(settings.counts),
        settings.status,
        id,
      )
    this.touch(id)
  }
  status(id: string, status: ExamPaper['status']) {
    this.db.prepare('UPDATE exam_papers SET status=? WHERE id=?').run(status, id)
    this.touch(id)
  }
  save(paperId: string, questionId: string, value: ExamAnswer['value'], version: number) {
    this.db
      .prepare(
        "INSERT INTO exam_answers (question_id,paper_id,value,version,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(question_id) DO UPDATE SET value=excluded.value,version=excluded.version,submitted=0,result=NULL,grade_request_id=NULL,grade_status='idle',updated_at=excluded.updated_at",
      )
      .run(questionId, paperId, JSON.stringify(value), version, Date.now())
    this.touch(paperId)
  }
  result(paperId: string, questionId: string, result: ExamResult) {
    this.db
      .prepare(
        "UPDATE exam_answers SET submitted=1,result=?,grade_status='completed',updated_at=? WHERE question_id=?",
      )
      .run(JSON.stringify(result), Date.now(), questionId)
    this.touch(paperId)
  }
  grade(paperId: string, questionId: string, requestId: string, status: ExamAnswer['gradeStatus']) {
    this.db
      .prepare('UPDATE exam_answers SET grade_request_id=?,grade_status=? WHERE question_id=?')
      .run(requestId, status, questionId)
    this.touch(paperId)
  }
  reset(id: string) {
    this.db.prepare('DELETE FROM exam_answers WHERE paper_id=?').run(id)
    this.db.prepare('UPDATE exam_papers SET reset_version=reset_version+1 WHERE id=?').run(id)
    this.touch(id)
  }
  interrupt() {
    const ids = this.db
      .prepare(
        "SELECT id FROM exam_papers WHERE status='generating' OR EXISTS (SELECT 1 FROM exam_answers a WHERE a.paper_id=exam_papers.id AND a.grade_status IN ('running','queued'))",
      )
      .all() as { id: string }[]
    for (const { id } of ids) {
      this.db
        .prepare("UPDATE exam_papers SET status='interrupted' WHERE id=? AND status='generating'")
        .run(id)
      this.db
        .prepare(
          "UPDATE exam_answers SET grade_status='interrupted' WHERE paper_id=? AND grade_status IN ('running','queued')",
        )
        .run(id)
      this.touch(id)
    }
  }
  interruptGeneration(conversationId: string) {
    this.db
      .prepare(
        "UPDATE exam_papers SET status='interrupted',revision=revision+1,updated_at=? WHERE conversation_id=? AND status='generating'",
      )
      .run(Date.now(), conversationId)
  }
  deleteConversation(id: string) {
    this.db
      .prepare(
        'DELETE FROM exam_answers WHERE paper_id IN (SELECT id FROM exam_papers WHERE conversation_id=?)',
      )
      .run(id)
    this.db
      .prepare(
        'DELETE FROM exam_questions WHERE paper_id IN (SELECT id FROM exam_papers WHERE conversation_id=?)',
      )
      .run(id)
    this.db.prepare('DELETE FROM exam_papers WHERE conversation_id=?').run(id)
  }
  usage(
    id: string,
    conversationId: string,
    usage:
      | {
          input_tokens?: number
          output_tokens?: number
          input_token_details?: { cache_read?: number }
        }
      | undefined,
  ) {
    const values = [
      usage?.input_tokens ?? null,
      usage?.output_tokens ?? null,
      usage?.input_token_details?.cache_read ?? null,
    ]
    const inserted = this.db
      .prepare(
        "INSERT OR IGNORE INTO agent_model_usage (id,conversation_id,kind,input_tokens,output_tokens,cache_read_tokens,created_at) VALUES (?,?,'grade',?,?,?,?)",
      )
      .run(`grade:${id}`, conversationId, ...values, Date.now())
    if (inserted.changes)
      this.db
        .prepare(
          'UPDATE agent_conversations SET input_tokens=input_tokens+?,output_tokens=output_tokens+?,cache_read_tokens=cache_read_tokens+? WHERE id=?',
        )
        .run(...values.map((v) => v ?? 0), conversationId)
  }
}
