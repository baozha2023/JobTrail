import Database from 'better-sqlite3'
import { isDeepStrictEqual } from 'node:util'
import { SCHEMA_V1 } from './schema-v1'
import { SCHEMA_V2 } from './schema-v2'
import { SCHEMA_V4 } from './schema-v4'
import { SCHEMA_V5 } from './schema-v5'
import { SCHEMA_V3 } from './schema-v3'
import { CHECKPOINT_SCHEMA } from './schema-checkpoint'
import { DatabaseVersionError } from './versions'
import { examQuestionSchema, examCountsSchema, gradeResultSchema } from '../../shared/exams'
import { z } from 'zod'
import {
  discoveryRunOutputSchema,
  discoveryStatusOutputSchema,
  searchQuerySchema,
} from '../../shared/job-discovery'
import { jobIdentity } from '../discovery/platforms'
import { duplicateFingerprint } from '../discovery/normalization'
import {
  readObservation,
  readSource,
  sourceProjection,
  type SourceRow,
} from '../discovery/persistence'
type Db = InstanceType<typeof Database>
export function validateDatabaseVersion(db: Db, version: number): void {
  // Main and MCP can be active together. All reference and count checks must
  // observe one committed snapshot while another process keeps writing to WAL.
  db.transaction(() => validateDatabaseSnapshot(db, version))()
}

function validateDatabaseSnapshot(db: Db, version: number): void {
  const sql =
    version === 1
      ? SCHEMA_V1
      : version === 2
        ? SCHEMA_V2
        : version === 3
          ? SCHEMA_V3
          : version === 4
            ? SCHEMA_V4
            : version === 5
              ? SCHEMA_V5
              : null
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
    if (version >= 2) validateExamData(db)
    if (version >= 3) validateCompanyLocations(db)
    if (version >= 4) validateDiscoveryData(db, version)
  } finally {
    expected.close()
  }
}

function validateDiscoveryData(db: Db, version: number): void {
  // Persistent platform contracts are frozen per released version, independent
  // of the live adapter registry (including platforms nested in JSON columns).
  const allowedPlatforms = new Set(
    version === 4
      ? ['boss', 'liepin', 'zhilian', 'wuyou']
      : ['boss', 'liepin', 'zhilian', 'wuyou', 'iguopin', 'shixiseng'],
  )
  const platform = (value: string) => {
    if (!allowedPlatforms.has(value)) throw new Error('Invalid persistent platform')
  }
  for (const [table, column, target, targetColumn] of [
    ['discovery_jobs', 'current_observation_id', 'discovery_observations', 'id'],
    ['discovery_observations', 'job_id', 'discovery_jobs', 'id'],
    ['discovery_sources', 'run_id', 'discovery_runs', 'id'],
    ['discovery_results', 'run_id', 'discovery_runs', 'id'],
    ['discovery_results', 'job_id', 'discovery_jobs', 'id'],
    ['discovery_results', 'observation_id', 'discovery_observations', 'id'],
    ['discovery_views', 'run_id', 'discovery_runs', 'id'],
    ['discovery_view_items', 'view_id', 'discovery_views', 'id'],
    ['discovery_view_items', 'job_id', 'discovery_jobs', 'id'],
    ['discovery_view_items', 'observation_id', 'discovery_observations', 'id'],
    ['discovery_requests', 'run_id', 'discovery_runs', 'id'],
    ['discovery_saved', 'job_id', 'discovery_jobs', 'id'],
    ['discovery_saved', 'opportunity_id', 'opportunities', 'id'],
    ['discovery_saved', 'observation_id', 'discovery_observations', 'id'],
  ]) {
    if (
      db
        .prepare(
          'SELECT 1 FROM ' +
            table +
            ' a LEFT JOIN ' +
            target +
            ' b ON a.' +
            column +
            '=b.' +
            targetColumn +
            ' WHERE b.' +
            targetColumn +
            ' IS NULL LIMIT 1',
        )
        .get()
    )
      throw new Error('Invalid discovery references')
  }
  for (const row of db
    .prepare(
      'SELECT o.payload,o.observed_at,j.id,j.platform,j.identity FROM discovery_observations o JOIN discovery_jobs j ON j.id=o.job_id',
    )
    .iterate() as Iterable<{
    payload: string
    observed_at: number
    id: string
    platform: string
    identity: string
  }>) {
    const item = readObservation(row.payload),
      key = jobIdentity(item.platform, item.url, item.externalId)
    platform(item.platform)
    if (
      key.id !== row.id ||
      key.identity !== row.identity ||
      item.platform !== row.platform ||
      item.readAt !== row.observed_at ||
      key.url !== item.url
    )
      throw new Error('Invalid discovery observation identity')
  }
  for (const row of db
    .prepare(
      'SELECT j.*,o.payload,o.job_id FROM discovery_jobs j JOIN discovery_observations o ON o.id=j.current_observation_id',
    )
    .iterate() as Iterable<{
    id: string
    job_id: string
    url: string
    duplicate_fingerprint: string | null
    payload: string
  }>) {
    const item = readObservation(row.payload)
    if (
      row.id !== row.job_id ||
      row.url !== item.url ||
      row.duplicate_fingerprint !== duplicateFingerprint(item)
    )
      throw new Error('Invalid discovery current observation')
  }
  for (const row of db
    .prepare('SELECT id,request_id,query,state,created_at,updated_at FROM discovery_runs')
    .iterate() as Iterable<{
    id: string
    request_id: string
    query: string
    state: string
    created_at: number
    updated_at: number
  }>) {
    z.string().uuid().parse(row.id)
    const storedQuery: unknown = JSON.parse(row.query)
    const query = searchQuerySchema.parse(storedQuery)
    query.platforms.forEach(platform)
    // Input defaults and trimming must never repair persisted v4 data.
    if (!isDeepStrictEqual(storedQuery, query)) throw new Error('Invalid persisted discovery query')
    discoveryRunOutputSchema.shape.state.parse(row.state)
    if (
      !Number.isSafeInteger(row.created_at) ||
      row.created_at < 0 ||
      !Number.isSafeInteger(row.updated_at) ||
      row.updated_at < row.created_at
    )
      throw new Error('Invalid discovery search')
    const binding = db
      .prepare('SELECT run_id FROM discovery_requests WHERE request_id=?')
      .get(row.request_id) as { run_id: string } | undefined
    if (binding?.run_id !== row.id) throw new Error('Invalid discovery request binding')
    const sources = (
      db
        .prepare('SELECT ' + sourceProjection + ' FROM discovery_sources WHERE run_id=?')
        .all(row.id) as SourceRow[]
    ).map(readSource)
    sources.forEach((source) => platform(source.platform))
    if (
      sources.length !== query.platforms.length ||
      sources.some(
        (s) => !query.platforms.includes(s.platform) || s.remote.keyword !== query.keyword,
      )
    )
      throw new Error('Invalid discovery sources')
    for (const source of sources) {
      const count = (
        db
          .prepare(
            'SELECT COUNT(*) n FROM discovery_results r JOIN discovery_jobs j ON j.id=r.job_id WHERE r.run_id=? AND j.platform=?',
          )
          .get(row.id, source.platform) as { n: number }
      ).n
      if (source.count !== count) throw new Error('Invalid discovery source count')
    }
  }
  for (const row of db.prepare('SELECT id FROM discovery_views').iterate() as Iterable<{
    id: string
  }>)
    z.string().uuid().parse(row.id)
  for (const row of db
    .prepare('SELECT platform,payload FROM discovery_platforms')
    .iterate() as Iterable<{ platform: string; payload: string }>) {
    platform(row.platform)
    if (discoveryStatusOutputSchema.parse(JSON.parse(row.payload)).platform !== row.platform)
      throw new Error('Invalid discovery platform')
  }
  for (const sql of [
    'SELECT 1 FROM discovery_view_items v JOIN discovery_observations o ON o.id=v.observation_id WHERE v.job_id<>o.job_id LIMIT 1',
    'SELECT 1 FROM discovery_results r JOIN discovery_observations o ON o.id=r.observation_id WHERE r.job_id<>o.job_id LIMIT 1',
    'SELECT 1 FROM discovery_saved s JOIN discovery_observations o ON o.id=s.observation_id WHERE s.job_id<>o.job_id LIMIT 1',
    'SELECT 1 FROM discovery_results r JOIN discovery_jobs j ON j.id=r.job_id LEFT JOIN discovery_sources s ON s.run_id=r.run_id AND s.platform=j.platform WHERE s.run_id IS NULL LIMIT 1',
    'SELECT 1 FROM discovery_view_items i JOIN discovery_views v ON v.id=i.view_id JOIN discovery_jobs j ON j.id=i.job_id LEFT JOIN discovery_sources s ON s.run_id=v.run_id AND s.platform=j.platform WHERE s.run_id IS NULL LIMIT 1',
  ])
    if (db.prepare(sql).get()) throw new Error('Mismatched discovery observation')
}

function validateCompanyLocations(db: Db): void {
  const rows = db.prepare('SELECT name, created_at FROM locations').all() as {
    name: string
    created_at: number
  }[]
  if (
    rows.some(
      (row) =>
        typeof row.name !== 'string' ||
        row.name !== row.name.trim() ||
        !row.name.length ||
        row.name.length > 200 ||
        !Number.isSafeInteger(row.created_at) ||
        row.created_at < 0,
    )
  )
    throw new Error('Invalid company location')
  if (
    db
      .prepare(
        `SELECT 1 FROM company_locations cl LEFT JOIN companies c ON c.id = cl.company_id
      LEFT JOIN locations l ON l.id = cl.location_id
      WHERE c.id IS NULL OR l.id IS NULL OR typeof(cl.created_at) <> 'integer' OR cl.created_at < 0 LIMIT 1`,
      )
      .get() ||
    db
      .prepare(
        'SELECT 1 FROM locations l WHERE NOT EXISTS (SELECT 1 FROM company_locations cl WHERE cl.location_id = l.id) LIMIT 1',
      )
      .get() ||
    db
      .prepare('SELECT 1 FROM company_locations GROUP BY company_id HAVING COUNT(*) > 100 LIMIT 1')
      .get()
  )
    throw new Error('Invalid company location references')
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
