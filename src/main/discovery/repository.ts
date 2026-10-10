import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  platforms,
  jobListSchema,
  searchQuerySchema,
  sourceProgressSchema,
  discoveryStatusOutputSchema,
  type JobQuery,
  type SearchRun,
  type SourceProgress,
  type RawJob,
  type JobObservation,
  type DiscoveredJob,
  type JobPage,
  type PlatformStatus,
  type JobPlatform,
} from '../../shared/job-discovery'
import { normalizeJob, salaryExclusion, duplicateFingerprint } from './normalization'
import { rankRelevance } from './relevance'
import { jobIdentity } from './platforms'
import { platformAdapter } from './adapter-registry'
import { AppServiceError } from '../services/errors'
import {
  observationPayload,
  readObservation,
  sourceProjection,
  readSource,
  collectDiscoveryGarbage,
  type SourceRow,
} from './persistence'
type Db = InstanceType<typeof Database>
type RunRow = {
  id: string
  request_id: string
  query: string
  state: SearchRun['state']
  created_at: number
  updated_at: number
}
type JobRow = {
  id: string
  observation_id: number
  payload: string
  opportunity_id: number | null
  possible_duplicate: number
}
export class DiscoveryRepository {
  constructor(readonly db: Db) {}
  create(query: JobQuery, requestId: string): SearchRun {
    query = searchQuerySchema.parse(query)
    const existing = this.db
      .prepare('SELECT run_id id FROM discovery_requests WHERE request_id=?')
      .get(requestId) as { id: string } | undefined
    if (existing) {
      const run = this.run(existing.id)
      if (JSON.stringify(run.query) !== JSON.stringify(query))
        throw new AppServiceError('VALIDATION_ERROR', 'requestId already belongs to another query')
      return run
    }
    const pending = this.db
      .prepare(
        "SELECT id FROM discovery_runs WHERE query=? AND state IN('queued','running') ORDER BY created_at LIMIT 1",
      )
      .get(JSON.stringify(query)) as { id: string } | undefined
    if (pending) {
      this.db.prepare('INSERT INTO discovery_requests VALUES(?,?)').run(requestId, pending.id)
      return this.run(pending.id)
    }
    const id = randomUUID(),
      now = Date.now()
    this.db
      .prepare('INSERT INTO discovery_runs VALUES(?,?,?,?,?,?)')
      .run(id, requestId, JSON.stringify(query), 'queued', now, now)
    this.db.prepare('INSERT INTO discovery_requests VALUES(?,?)').run(requestId, id)
    for (const platform of query.platforms)
      this.source(id, {
        platform,
        state: 'queued',
        count: 0,
        batches: 0,
        sourcePage: 0,
        rawCount: 0,
        validCount: 0,
        duplicateCount: 0,
        rejectedCount: 0,
        salaryExcluded: { out_of_range: 0, day: 0, hour: 0, foreign: 0, unknown: 0 },
        cursor: null,
        generation: 0,
        remote: { keyword: query.keyword, city: '', cityCode: '' },
        message: '',
        cachedAt: null,
      })
    return this.run(id)
  }
  run(id: string): SearchRun {
    z.string().uuid().parse(id)
    const row = this.db.prepare('SELECT * FROM discovery_runs WHERE id=?').get(id) as
      | RunRow
      | undefined
    if (!row) throw new AppServiceError('NOT_FOUND', 'Search run not found')
    return {
      id: row.id,
      requestId: row.request_id,
      query: JSON.parse(row.query),
      state: row.state,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      sources: (
        this.db
          .prepare(
            'SELECT ' +
              sourceProjection +
              ' FROM discovery_sources WHERE run_id=? ORDER BY platform',
          )
          .all(id) as SourceRow[]
      ).map(readSource),
    }
  }
  state(id: string, state: SearchRun['state']) {
    this.db
      .prepare('UPDATE discovery_runs SET state=?,updated_at=? WHERE id=?')
      .run(state, Date.now(), id)
  }
  source(id: string, source: SourceProgress) {
    source = sourceProgressSchema.parse(source)
    const run = this.run(id)
    if (!run.query.platforms.includes(source.platform))
      throw new AppServiceError('VALIDATION_ERROR', 'Source does not belong to search')
    const columns = [
      'run_id',
      'platform',
      'state',
      'count',
      'batches',
      'source_page',
      'raw_count',
      'valid_count',
      'duplicate_count',
      'rejected_count',
      'excluded_range',
      'excluded_day',
      'excluded_hour',
      'excluded_foreign',
      'excluded_unknown',
      'generation',
      'cursor',
      'remote',
      'message',
      'cached_at',
    ]
    this.db
      .prepare(
        'INSERT INTO discovery_sources(' +
          columns.join(',') +
          ') VALUES(' +
          columns.map(() => '?').join(',') +
          ') ON CONFLICT(run_id,platform) DO UPDATE SET ' +
          columns
            .slice(2)
            .map((c) => c + '=excluded.' + c)
            .join(','),
      )
      .run(
        id,
        source.platform,
        source.state,
        source.count,
        source.batches,
        source.sourcePage,
        source.rawCount,
        source.validCount,
        source.duplicateCount,
        source.rejectedCount,
        source.salaryExcluded.out_of_range,
        source.salaryExcluded.day,
        source.salaryExcluded.hour,
        source.salaryExcluded.foreign,
        source.salaryExcluded.unknown,
        source.generation,
        source.cursor,
        JSON.stringify(source.remote),
        source.message,
        source.cachedAt,
      )
    this.db.prepare('UPDATE discovery_runs SET updated_at=? WHERE id=?').run(Date.now(), id)
  }
  observe(
    raw: RawJob,
    runId?: string,
    observedAt = Date.now(),
    kind: 'list' | 'detail' = 'list',
  ): number | null {
    const run = runId ? this.run(runId) : undefined
    if (run && !run.query.platforms.includes(raw.platform))
      throw new AppServiceError('VALIDATION_ERROR', 'Wrong search platform')
    // Admission uses this response, never a previous observation's salary.
    if (kind === 'list' && run && salaryExclusion(raw.salary, run.query)) return null
    const key = jobIdentity(raw.platform, raw.url, raw.externalId)
    const previous = this.db
      .prepare(
        'SELECT o.payload FROM discovery_jobs j JOIN discovery_observations o ON o.id=j.current_observation_id WHERE j.id=?',
      )
      .get(key.id) as { payload: string } | undefined
    const previousValue = previous ? readObservation(previous.payload) : undefined
    const makeCurrent = !previousValue || observedAt >= previousValue.readAt
    const value = normalizeJob(
      { ...raw, url: key.url },
      observedAt,
      makeCurrent ? previousValue : undefined,
    )
    const payload = observationPayload(value)
    return this.db
      .transaction(() => {
        const observationId = Number(
          this.db
            .prepare('INSERT INTO discovery_observations(job_id,payload,observed_at) VALUES(?,?,?)')
            .run(key.id, payload, observedAt).lastInsertRowid,
        )
        this.db
          .prepare(
            'INSERT INTO discovery_jobs(id,platform,identity,url,created_at,current_observation_id,duplicate_fingerprint) VALUES(?,?,?,?,?,?,?) ON CONFLICT(platform,identity) DO UPDATE SET url=excluded.url,current_observation_id=excluded.current_observation_id,duplicate_fingerprint=excluded.duplicate_fingerprint WHERE ?',
          )
          .run(
            key.id,
            raw.platform,
            key.identity,
            key.url,
            observedAt,
            observationId,
            duplicateFingerprint(value),
            makeCurrent ? 1 : 0,
          )
        if (run) this.attachObservation(run, key.id, observationId, value)
        return observationId
      })
      .immediate()
  }
  private attachObservation(
    run: SearchRun,
    jobId: string,
    observationId: number,
    value: JobObservation,
  ) {
    if (!run.query.platforms.includes(value.platform))
      throw new AppServiceError('VALIDATION_ERROR', 'Wrong search platform')
    const existed = this.contains(run.id, jobId)
    const excluded = salaryExclusion(value.salary, run.query)
    if (excluded)
      this.db
        .prepare('DELETE FROM discovery_results WHERE run_id=? AND job_id=?')
        .run(run.id, jobId)
    else
      this.db
        .prepare(
          'INSERT INTO discovery_results VALUES(?,?,?,?) ON CONFLICT(run_id,job_id) DO UPDATE SET observation_id=excluded.observation_id,relevance=excluded.relevance',
        )
        .run(run.id, jobId, observationId, 0)
    this.db
      .prepare('UPDATE discovery_sources SET count=count+? WHERE run_id=? AND platform=?')
      .run(excluded ? (existed ? -1 : 0) : existed ? 0 : 1, run.id, value.platform)
  }
  reuseObservation(runId: string, jobId: string, observationId: number) {
    const job = this.get(jobId, undefined, observationId)
    this.attachObservation(this.run(runId), jobId, observationId, job)
  }
  private base = `SELECT j.id,o.id observation_id,o.payload,s.opportunity_id,
    EXISTS(SELECT 1 FROM discovery_jobs j2 WHERE j2.duplicate_fingerprint=j.duplicate_fingerprint AND j2.platform<>j.platform) possible_duplicate
    FROM discovery_jobs j JOIN discovery_observations o ON o.job_id=j.id LEFT JOIN discovery_saved s ON s.job_id=j.id`
  private map(row: JobRow, removedFromCurrentSearch = false): DiscoveredJob {
    return {
      ...readObservation(row.payload),
      id: row.id,
      observationId: row.observation_id,
      removedFromCurrentSearch,
      savedOpportunityId: row.opportunity_id,
      possibleDuplicate: !!row.possible_duplicate,
    }
  }
  get(id: string, runId?: string, observationId?: number, viewId?: string): DiscoveredJob {
    z.string().min(1).max(100).parse(id)
    let removed = false
    if (runId) {
      this.run(runId)
      const result = this.db
        .prepare('SELECT observation_id FROM discovery_results WHERE run_id=? AND job_id=?')
        .get(runId, id) as { observation_id: number } | undefined
      removed = !result
      if (viewId) {
        const item = this.db
          .prepare(
            'SELECT i.observation_id FROM discovery_view_items i JOIN discovery_views v ON v.id=i.view_id WHERE v.id=? AND v.run_id=? AND i.job_id=?',
          )
          .get(viewId, runId, id) as { observation_id: number } | undefined
        if (!item || (observationId !== undefined && observationId !== item.observation_id))
          throw new AppServiceError('NOT_FOUND', 'Job observation does not belong to view')
        observationId = item.observation_id
      } else if (observationId !== undefined) {
        const owned =
          result?.observation_id === observationId ||
          this.db
            .prepare(
              'SELECT 1 FROM discovery_view_items i JOIN discovery_views v ON v.id=i.view_id WHERE v.run_id=? AND i.job_id=? AND i.observation_id=?',
            )
            .get(runId, id, observationId)
        if (!owned) throw new AppServiceError('NOT_FOUND', 'Observation does not belong to search')
      } else {
        if (!result) throw new AppServiceError('NOT_FOUND', 'Job does not belong to search')
        observationId = result.observation_id
      }
    } else if (viewId) throw new AppServiceError('VALIDATION_ERROR', 'View requires search')
    const row = this.db
      .prepare(
        this.base +
          ' WHERE j.id=? AND o.id=' +
          (observationId !== undefined ? '?' : 'j.current_observation_id'),
      )
      .get(id, ...(observationId !== undefined ? [observationId] : [])) as JobRow | undefined
    if (!row) throw new AppServiceError('NOT_FOUND', 'Discovered job not found')
    return this.map(row, removed)
  }
  contains(runId: string, jobId: string): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM discovery_results WHERE run_id=? AND job_id=?')
      .get(runId, jobId)
  }
  removeOfflineJob(id: string): void {
    const job = this.get(id)
    const runs = this.db.prepare('SELECT run_id FROM discovery_results WHERE job_id=?').all(id) as {
      run_id: string
    }[]
    for (const table of [
      'discovery_results',
      'discovery_view_items',
      'discovery_saved',
      'discovery_observations',
    ])
      this.db.prepare('DELETE FROM ' + table + ' WHERE job_id=?').run(id)
    this.db.prepare('DELETE FROM discovery_jobs WHERE id=?').run(id)
    for (const { run_id } of runs)
      this.db
        .prepare('UPDATE discovery_sources SET count=? WHERE run_id=? AND platform=?')
        .run(this.sourceCount(run_id, job.platform), run_id, job.platform)
  }
  list(input: z.input<typeof jobListSchema>): JobPage {
    const q = jobListSchema.parse(input)
    return this.db
      .transaction(() => {
        const run = this.run(q.runId)
        const viewId = q.viewId ?? randomUUID()
        const view = q.viewId
          ? (this.db.prepare('SELECT run_id,sort FROM discovery_views WHERE id=?').get(viewId) as
              | { run_id: string; sort: NonNullable<typeof q.sort> }
              | undefined)
          : { run_id: q.runId, sort: q.sort ?? 'relevance' }
        if (!view || view.run_id !== q.runId || (input.sort && view.sort !== input.sort))
          throw new AppServiceError(
            'VALIDATION_ERROR',
            'View does not belong to this search and sort',
          )
        if (!q.viewId)
          this.db
            .prepare('INSERT INTO discovery_views VALUES(?,?,?,?)')
            .run(viewId, q.runId, view.sort, Date.now())
        if (
          view.sort === 'relevance' &&
          (!q.viewId ||
            this.db
              .prepare(
                `SELECT 1 FROM discovery_results r WHERE r.run_id=?
            AND NOT EXISTS(SELECT 1 FROM discovery_view_items v WHERE v.view_id=? AND v.job_id=r.job_id)
            LIMIT 1`,
              )
              .get(q.runId, viewId))
        )
          this.rankResults(run)
        const sort =
          view.sort === 'salary'
            ? "COALESCE(json_extract(o.payload,'$.salaryMax'),json_extract(o.payload,'$.salaryMin')) DESC NULLS LAST"
            : view.sort === 'discovered'
              ? 'j.created_at DESC'
              : 'r.relevance DESC'
        // Existing positions and observations are immutable; only unseen identities are appended.
        this.db
          .prepare(
            `INSERT INTO discovery_view_items(view_id,ordinal,job_id,observation_id)
        SELECT @view, (SELECT COALESCE(MAX(ordinal),0) FROM discovery_view_items WHERE view_id=@view)
          + ROW_NUMBER() OVER(ORDER BY ${sort},j.id), j.id,o.id
        FROM discovery_results r JOIN discovery_jobs j ON j.id=r.job_id
        JOIN discovery_observations o ON o.id=r.observation_id
        WHERE r.run_id=@run AND NOT EXISTS(SELECT 1 FROM discovery_view_items v WHERE v.view_id=@view AND v.job_id=j.id)
        ORDER BY ${sort},j.id`,
          )
          .run({ view: viewId, run: q.runId })
        const total = (
          this.db
            .prepare('SELECT COUNT(*) n FROM discovery_view_items WHERE view_id=?')
            .get(viewId) as { n: number }
        ).n
        const rows = this.db
          .prepare(
            this.base +
              ' JOIN discovery_view_items v ON v.observation_id=o.id AND v.job_id=j.id WHERE v.view_id=? ORDER BY v.ordinal LIMIT ? OFFSET ?',
          )
          .all(viewId, q.pageSize, (q.page - 1) * q.pageSize) as JobRow[]
        return {
          viewId,
          items: rows.map((row) => this.map(row, !this.contains(q.runId, row.id))),
          total,
          page: q.page,
          pageSize: q.pageSize,
        }
      })
      .immediate()
  }
  private rankResults(run: SearchRun): void {
    const rows = this.db
      .prepare(
        `SELECT r.job_id,o.payload FROM discovery_results r
      JOIN discovery_observations o ON o.id=r.observation_id WHERE r.run_id=?`,
      )
      .iterate(run.id) as IterableIterator<{ job_id: string; payload: string }>
    function* documents() {
      for (const row of rows) yield { id: row.job_id, ...readObservation(row.payload) }
    }
    // Only numeric features survive the scan. SQL still owns ordering, counts and pagination.
    // Recalculate at refresh/append boundaries; existing view ordinals stay immutable.
    const scores = rankRelevance(run.query.keyword, documents())
    const update = this.db.prepare(
      'UPDATE discovery_results SET relevance=? WHERE run_id=? AND job_id=?',
    )
    for (const { id, score } of scores) update.run(score, run.id, id)
  }
  history(page: number) {
    z.number().int().min(1).parse(page)
    return {
      items: (
        this.db
          .prepare('SELECT id FROM discovery_runs ORDER BY created_at DESC,id LIMIT 20 OFFSET ?')
          .all((page - 1) * 20) as { id: string }[]
      ).map((r) => this.run(r.id)),
      total: (this.db.prepare('SELECT COUNT(*) n FROM discovery_runs').get() as { n: number }).n,
    }
  }
  remove(ids: string[]) {
    ids = [...new Set(z.array(z.string().uuid()).max(100).parse(ids))]
    for (const id of ids) {
      if (['running', 'queued'].includes(this.run(id).state))
        throw new AppServiceError(
          'VALIDATION_ERROR',
          'Cancel active searches before deleting history',
        )
      this.db
        .prepare(
          'DELETE FROM discovery_view_items WHERE view_id IN(SELECT id FROM discovery_views WHERE run_id=?)',
        )
        .run(id)
      for (const table of [
        'discovery_views',
        'discovery_requests',
        'discovery_results',
        'discovery_sources',
      ])
        this.db.prepare('DELETE FROM ' + table + ' WHERE run_id=?').run(id)
      this.db.prepare('DELETE FROM discovery_runs WHERE id=?').run(id)
    }
    this.db.exec(collectDiscoveryGarbage)
  }
  status(): PlatformStatus[] {
    return platforms.map((platform) => {
      const row = this.db
        .prepare('SELECT payload FROM discovery_platforms WHERE platform=?')
        .get(platform) as { payload: string } | undefined
      const status: PlatformStatus = row
        ? JSON.parse(row.payload)
        : {
            platform,
            state: 'unknown',
            checkedAt: null,
            generation: 0,
            evidence: '',
            capabilities: {
              cities: [],
              remoteFilters: [...platformAdapter(platform).remoteFilters],
              qr: 'website',
            },
            limitations: ['authentication_unchecked'],
          }
      // Capabilities belong to the current adapter, not the persisted account state.
      status.capabilities.cities = platformAdapter(platform).cities.all.map((city) => city.name)
      status.capabilities.remoteFilters = [...platformAdapter(platform).remoteFilters]
      return status
    })
  }
  platform(status: PlatformStatus) {
    status = discoveryStatusOutputSchema.parse(status)
    this.db
      .prepare(
        'INSERT INTO discovery_platforms VALUES(?,?) ON CONFLICT(platform) DO UPDATE SET payload=excluded.payload',
      )
      .run(status.platform, JSON.stringify(status))
  }
  resetRuntime() {
    this.db
      .prepare(
        "UPDATE discovery_runs SET state='interrupted',updated_at=? WHERE state IN('running','queued')",
      )
      .run(Date.now())
    this.db.exec(
      "UPDATE discovery_sources SET cursor=NULL,state=CASE WHEN state IN('running','queued') THEN 'interrupted' ELSE state END",
    )
    for (const status of this.status())
      this.platform({
        ...status,
        generation: status.generation + 1,
        limitations:
          status.state === 'authenticated'
            ? [...new Set([...status.limitations, 'session_recheck_required'])]
            : status.limitations,
      })
  }
  saved(id: string): number | null {
    return (
      (
        this.db.prepare('SELECT opportunity_id FROM discovery_saved WHERE job_id=?').get(id) as
          | { opportunity_id: number }
          | undefined
      )?.opportunity_id ?? null
    )
  }
  link(job: DiscoveredJob, opportunityId: number) {
    this.db
      .prepare('INSERT INTO discovery_saved VALUES(?,?,?,?)')
      .run(job.id, opportunityId, job.observationId, Date.now())
  }
  sourceCount(runId: string, platform: JobPlatform): number {
    return (
      this.db
        .prepare(
          'SELECT COUNT(*) n FROM discovery_results r JOIN discovery_jobs j ON j.id=r.job_id WHERE r.run_id=? AND j.platform=?',
        )
        .get(runId, platform) as { n: number }
    ).n
  }
}
