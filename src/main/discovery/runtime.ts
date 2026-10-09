import { SourceError, type PlatformSearch, type SourceBatch } from './adapter'
import { BrowserWindow, WebContentsView, session, shell, type Session } from 'electron'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  platforms,
  needsHumanAction,
  sourceVerificationSchema,
  browserActionSchema,
  browserRegionSchema,
  qrLoginSchema,
  jobFields,
  startSearchSchema,
  jobDetailSchema,
  type DiscoveryApi,
  type JobPlatform,
  type JobQuery,
  type RawJob,
  type SourceProgress,
  type BrowserRegion,
  type PlatformStatus,
  type SourceVerificationState,
} from '../../shared/job-discovery'
import { JobDiscoveryService, type DiscoveryLive } from './service'
import { allowedPage, canonicalJob, jobIdentity } from './platforms'
import { statusFromPage } from './platform-status'
import type { PageSnapshot } from './extraction'
import { QrLoginManager } from './qr-login'
import { QrVerificationWindow } from './qr-verification'
import {
  VerificationWindow,
  platformPreferences,
  protectPlatformPage,
  websiteUserAgent,
} from './verification-window'
import { SearchPage, bounded, wait as delay } from './search-page'
import { platformAdapter } from './adapter-registry'
import { cityName } from '../../shared/discovery-cities'
import { salaryExclusion } from './normalization'
import { BatchCache, RoundBudget, runSourceTasks } from './collection'
import { validateWebUrl } from '../services/web-network'
import { DiscoveryNetwork } from './network'
import { AppServiceError } from '../services/errors'
import { isUpdateFrozen } from '../update-freeze'
import { captureError, recordEvent } from '../diagnostics'

type PlatformPage = WebContentsView | BrowserWindow
interface QueryContext {
  view: BrowserWindow
  adapter: PlatformSearch
  scope: string
  token: string
  recoveringUntil: number
  noGrowth: number
  seen: Set<string>
}
type VerificationAttempt = SourceVerificationState & {
  view?: BrowserWindow
  controller: AbortController
}

export class DiscoveryRuntime implements DiscoveryLive {
  private verificationAttempt?: VerificationAttempt
  private qr: QrLoginManager
  private verificationWindows: VerificationWindow
  private changing = new Set<JobPlatform>()
  private pagePlatforms = new Map<PlatformPage, JobPlatform>()
  private sourceControllers = new Map<string, AbortController>()
  private queries = new Map<string, QueryContext>()
  private sessions = new Map<JobPlatform, Session>()
  private pages = new Set<PlatformPage>()
  private foreground?: { view: WebContentsView; platform: JobPlatform }
  private regionValue: BrowserRegion = { x: 0, y: 0, width: 0, height: 0, visible: false }
  private lanes = new Map<JobPlatform, Promise<unknown>>()
  private runTail: Promise<unknown> = Promise.resolve()
  private controllers = new Map<string, AbortController>()
  private tasks = new Set<Promise<unknown>>()
  private details = new Map<string, ReturnType<DiscoveryApi['detail']>>()
  private offlineJobs = new Set<string>()
  private cache = new BatchCache()
  private suspended = false
  private browserSequence = 0
  private network = new DiscoveryNetwork((url) => session.defaultSession.resolveProxy(url))
  constructor(
    private root: string,
    private service: JobDiscoveryService,
    private window: () => BrowserWindow | undefined,
  ) {
    this.verificationWindows = new VerificationWindow(window)
    this.qr = new QrLoginManager(
      (p) => this.session(p),
      (p) => {
        const previous = service.repository.status().find((s) => s.platform === p)!
        service.work.run(() =>
          service.repository.platform({
            ...previous,
            state: 'authenticated',
            generation: previous.generation + 1,
            checkedAt: Date.now(),
            evidence: 'official_qr_login_confirmed',
            limitations: [],
          }),
        )
      },
      (p) => {
        const previous = service.repository.status().find((s) => s.platform === p)!
        service.work.run(() =>
          service.repository.platform({
            ...previous,
            state: 'challenge',
            checkedAt: Date.now(),
            evidence: 'official_qr_verification_required',
            limitations: ['challenge'],
          }),
        )
      },
      new QrVerificationWindow(this.verificationWindows),
    )
  }
  private writable(p?: JobPlatform) {
    if (p && this.changing.has(p))
      throw new AppServiceError('DISCOVERY_UNAVAILABLE', 'Account change in progress')
    if (this.suspended || isUpdateFrozen(this.root))
      throw new AppServiceError('PERSISTENCE_BUSY', 'Discovery is suspended for data maintenance')
  }
  private async session(p: JobPlatform): Promise<Session> {
    const existing = this.sessions.get(p)
    if (existing) {
      await this.network.prepare(existing)
      return existing
    }
    const s = session.fromPath(path.join(this.root, 'browser-sessions', p), { cache: true })
    s.setUserAgent(websiteUserAgent(s.getUserAgent()))
    s.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    s.setPermissionCheckHandler(() => false)
    s.on('will-download', (event) => event.preventDefault())
    s.webRequest.onBeforeRequest((details, callback) => {
      if (details.url.startsWith('data:') || details.url.startsWith('blob:')) {
        callback({ cancel: details.resourceType === 'mainFrame' })
        return
      }
      if (details.resourceType === 'mainFrame' && !allowedPage(p, details.url)) {
        callback({ cancel: true })
        return
      }
      try {
        validateWebUrl(details.url)
        callback({ cancel: false })
      } catch (error) {
        captureError(error, { operation: `discovery.${p}.network-check`, level: 'warn' })
        callback({ cancel: true })
      }
    })
    this.sessions.set(p, s)
    await this.network.prepare(s)
    return s
  }
  private createPage(p: JobPlatform, background: false): Promise<WebContentsView>
  private createPage(p: JobPlatform, background?: true): Promise<BrowserWindow>
  private async createPage(p: JobPlatform, background = true): Promise<PlatformPage> {
    const webPreferences = platformPreferences(await this.session(p))
    this.writable(p)
    // Background search needs the same native viewport/keyboard/scroll lifecycle
    // as the official page. Foreground job pages remain embedded native views.
    const view = background
      ? new BrowserWindow({
          show: false,
          width: 1100,
          height: 800,
          skipTaskbar: true,
          webPreferences,
        })
      : new WebContentsView({ webPreferences })
    protectPlatformPage(view.webContents, p)
    view.setBounds({ x: 0, y: 0, width: 1100, height: 800 })
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (allowedPage(p, url))
        void view.webContents.loadURL(url).catch((error) => {
          if (!view.webContents.isDestroyed() && !/ERR_ABORTED/.test(String(error)))
            captureError(error, { operation: `discovery.${p}.navigation`, level: 'warn' })
        })
      return { action: 'deny' }
    })
    this.pages.add(view)
    this.pagePlatforms.set(view, p)
    return view
  }
  private destroy(view: PlatformPage) {
    const wc = view.webContents
    this.pages.delete(view)
    this.pagePlatforms.delete(view)
    if (view instanceof WebContentsView && this.window()?.contentView.children.includes(view))
      this.window()?.contentView.removeChildView(view)
    if (wc && !wc.isDestroyed()) wc.close()
    if (view instanceof BrowserWindow && !view.isDestroyed()) view.destroy()
  }

  private async load(view: PlatformPage, url: string, signal: AbortSignal) {
    try {
      await bounded(view.webContents.loadURL(url), signal)
    } catch (error) {
      // Client-side login navigation may cancel the original load. Inspect the
      // resulting platform page so an explicit login gate is reported correctly.
      const p = this.pagePlatforms.get(view)
      if (
        signal.aborted ||
        !/ERR_ABORTED/.test(String(error)) ||
        !p ||
        !view.webContents ||
        view.webContents.isDestroyed() ||
        !allowedPage(p, view.webContents.getURL())
      )
        throw error
    }
    await delay(1700, signal)
  }
  private async snapshot(
    view: PlatformPage,
    p: JobPlatform,
    signal: AbortSignal,
    detail = false,
  ): Promise<PageSnapshot> {
    return bounded(
      view.webContents.executeJavaScript(platformAdapter(p).pageScript(detail)),
      signal,
    )
  }
  private lane<T>(platform: JobPlatform, work: () => Promise<T>): Promise<T> {
    const previous = this.lanes.get(platform) || Promise.resolve()
    const result = previous.catch(() => {}).then(work)
    this.lanes.set(platform, result)
    this.tasks.add(result)
    void result
      .finally(() => {
        this.tasks.delete(result)
        if (this.lanes.get(platform) === result) this.lanes.delete(platform)
      })
      .catch(() => {})
    return result
  }
  private recordStatus(p: JobPlatform, page: PageSnapshot): PlatformStatus {
    const previous = this.service.repository.status().find((s) => s.platform === p)!
    const status = statusFromPage(previous, page)
    if (
      previous.state !== status.state ||
      previous.evidence !== status.evidence ||
      previous.limitations.join() !== status.limitations.join() ||
      !previous.checkedAt ||
      Date.now() - previous.checkedAt > 60000
    )
      this.service.work.run(() => this.service.repository.platform(status))
    return status
  }
  async status(check = false) {
    if (!check) return this.service.repository.status()
    this.writable()
    await Promise.all(
      platforms.map((p) =>
        this.lane(p, async () => {
          this.writable(p)
          const signal = AbortSignal.timeout(15000)
          const foreground = this.foreground?.platform === p ? this.foreground.view : undefined
          const view = foreground || (await this.createPage(p))
          try {
            if (!foreground) await this.load(view, platformAdapter(p).accountCheckUrl, signal)
            this.recordStatus(p, await this.snapshot(view, p, signal))
          } catch (error) {
            /* An unreachable site is not evidence of logout. */
            captureError(error, { operation: `discovery.${p}.status`, level: 'warn' })
          } finally {
            if (!foreground) this.destroy(view)
          }
        }),
      ),
    )
    return this.service.repository.status()
  }
  async start(input: Parameters<DiscoveryApi['start']>[0]) {
    this.writable()
    const parsed = startSearchSchema.parse(input)
    const run = this.service.work.run(() =>
      this.service.repository.create(parsed.query, parsed.requestId),
    )
    if (run.state === 'queued' && !this.controllers.has(run.id)) this.enqueue(run.id)
    return this.service.repository.run(run.id)
  }
  private enqueue(id: string) {
    const controller = new AbortController()
    this.controllers.set(id, controller)
    const task = this.runTail
      .catch(() => {})
      .then(async () => {
        if (controller.signal.aborted) {
          this.service.work.run(() => {
            this.service.repository.state(id, 'cancelled')
            for (const source of this.service.repository.run(id).sources)
              if (source.state === 'queued')
                this.service.repository.source(id, { ...source, state: 'cancelled' })
          })
          return
        }
        this.service.work.run(() => this.service.repository.state(id, 'running'))
        const timer = setTimeout(() => controller.abort(new SourceError('timeout')), 90000)
        try {
          const run = this.service.repository.run(id)
          await runSourceTasks(
            run.sources.filter((s) => s.state !== 'completed'),
            (source) =>
              this.lane(source.platform, () =>
                this.collect(id, run.query, source, controller.signal),
              ),
          )
          if (this.service.repository.run(id).state !== 'cancelled')
            this.service.work.run(() =>
              this.service.repository.state(
                id,
                this.service.repository.run(id).sources.every((s) => s.state === 'completed')
                  ? 'completed'
                  : 'partial',
              ),
            )
        } catch (error) {
          captureError(error, { operation: 'discovery.schedule' })
          if (this.service.repository.run(id).state !== 'cancelled')
            this.service.work.run(() => this.service.repository.state(id, 'partial'))
        } finally {
          clearTimeout(timer)
        }
      })
      .finally(() => {
        this.controllers.delete(id)
        this.tasks.delete(task)
      })
    this.runTail = task
    this.tasks.add(task)
    void task.catch(() => {})
  }
  async continue(id: string) {
    this.writable()
    const run = this.service.repository.run(id)
    if (this.verificationAttempt?.runId === id) return run
    if (this.controllers.has(id)) return run
    this.service.work.run(() => {
      this.service.repository.state(id, 'queued')
      for (const source of run.sources)
        if (source.state !== 'completed')
          this.service.repository.source(id, { ...source, state: 'queued' })
    })
    this.enqueue(id)
    return this.service.repository.run(id)
  }
  async cancel(id: string) {
    const run = this.service.repository.run(id)
    if (this.verificationAttempt?.runId === id) this.closeVerification()
    this.controllers.get(id)?.abort(new SourceError('cancelled'))
    // The in-flight read observes cancellation before its page is released.
    if (!this.controllers.has(id)) this.releaseQueries(id)
    if (['running', 'queued', 'partial'].includes(run.state))
      this.service.work.run(() => {
        this.service.repository.state(id, 'cancelled')
        for (const source of run.sources)
          if (['running', 'queued'].includes(source.state))
            this.service.repository.source(id, { ...source, state: 'cancelled' })
      })
    return this.service.repository.run(id)
  }
  private releaseQueries(runId?: string, platform?: JobPlatform) {
    for (const [key, context] of this.queries) {
      if (runId && !key.startsWith(runId + ':')) continue
      if (platform && this.pagePlatforms.get(context.view) !== platform) continue
      this.destroy(context.view)
      this.queries.delete(key)
    }
  }
  private async collect(
    id: string,
    query: JobQuery,
    source: SourceProgress,
    signal: AbortSignal,
    onVerified?: () => void,
  ) {
    const p = source.platform,
      key = id + ':' + p
    const controller = new AbortController()
    this.sourceControllers.set(id + p, controller)
    signal = AbortSignal.any([signal, controller.signal])
    const generation = this.service.repository.status().find((s) => s.platform === p)!.generation
    const scope = JSON.stringify([
      platformAdapter(p).contractVersion,
      p,
      query.keyword,
      query.city,
      query.salaryMin,
      query.salaryMax,
      generation,
    ])
    let progress: SourceProgress = {
      ...source,
      state: 'running',
      generation,
      message: '',
      cachedAt: null,
    }
    let verifying = !!onVerified
    // Keep the human-action warning until a fresh batch actually commits.
    const update = () => {
      if (verifying && progress.state === 'running') return
      this.service.work.run(() => this.service.repository.source(id, progress))
    }
    let context = this.queries.get(key)
    const seen = context?.seen ?? new Set<string>()
    let durableFailure = false
    const budget = new RoundBudget(context?.noGrowth ?? 0)
    const save = (batch: SourceBatch, at = Date.now(), cached = false) => {
      if (batch.rawCount !== batch.sourceIds.length + batch.duplicateCount + batch.rejectedCount)
        throw new SourceError('network_error', 'batch_accounting_mismatch')
      const identities = batch.jobs.map(
        (job) => jobIdentity(job.platform, job.url, job.externalId).id,
      )
      const added = batch.sourceIds.filter((id) => !seen.has(id)).length
      const excluded = { ...progress.salaryExcluded }
      const admitted = batch.jobs.filter((job, index) => {
        if (this.offlineJobs.has(identities[index])) return false
        const reason = salaryExclusion(job.salary, query)
        if (reason && !seen.has(identities[index])) excluded[reason]++
        return !reason
      })
      const next = this.service.work.run(() => {
        for (const job of admitted) this.service.repository.observe(job, id, at)
        const result: SourceProgress = {
          ...progress,
          count: this.service.repository.sourceCount(id, p),
          batches: progress.batches + 1,
          sourcePage: Math.max(progress.sourcePage, batch.page),
          rawCount: progress.rawCount + batch.rawCount,
          validCount: progress.validCount + batch.sourceIds.length,
          duplicateCount: progress.duplicateCount + batch.duplicateCount,
          rejectedCount: progress.rejectedCount + batch.rejectedCount,
          salaryExcluded: excluded,
          remote: {
            keyword: batch.submitted.keyword,
            city: cityName(p, batch.submitted.cityCode),
            cityCode: batch.submitted.cityCode,
          },
          cursor: batch.hasMore === false ? null : (context?.token ?? null),
          message: cached
            ? 'cached_results'
            : context && batch.page <= context.recoveringUntil
              ? 'cursor_expired_restarted'
              : batch.evidence,
          cachedAt: cached ? at : null,
        }
        result.duplicateCount += batch.sourceIds.length - added
        this.service.repository.source(id, result)
        return result
      })
      batch.sourceIds.forEach((id) => seen.add(id))
      progress = next
      const state = budget.saved(batch, added, !!context && batch.page <= context.recoveringUntil)
      if (context) context.noGrowth = budget.noGrowth
      return state
    }
    try {
      this.writable(p)
      signal.throwIfAborted()
      if (this.verificationAttempt?.platform === p && !onVerified)
        throw new SourceError('challenge', 'verification_in_progress')
      update()
      if (context && (context.scope !== scope || context.view.webContents.isDestroyed())) {
        this.releaseQueries(id, p)
        context = undefined
      }
      const cached = !context && !source.batches ? this.cache.read(scope) : undefined
      if (cached) {
        for (const batch of cached.batches) {
          const state = save(batch, cached.at, true)
          progress.state = state === 'completed' ? 'completed' : 'partial'
          if (state === 'completed' || budget.exhausted) break
        }
        update()
        return
      }
      if (!context) {
        // Keep a bounded number of resumable pages. Eviction is explicit cursor loss,
        // handled by replaying official pages and deduplicating committed identities.
        for (const [oldKey, old] of this.queries) {
          if (this.queries.size < 8) break
          if (this.controllers.has(oldKey.split(':')[0])) continue
          this.destroy(old.view)
          this.queries.delete(oldKey)
        }
        const view = await this.createPage(p)
        context = {
          view,
          adapter: platformAdapter(p).createSearch(
            new SearchPage(view.webContents, platformAdapter(p).pageScript(false)),
            query,
          ),
          scope,
          token: randomUUID(),
          recoveringUntil: source.sourcePage,
          noGrowth: 0,
          seen,
        }
        this.queries.set(key, context)
        if (source.batches) {
          progress.message = 'cursor_expired_restarted'
          update()
        }
      }
      while (!budget.exhausted) {
        signal.throwIfAborted()
        const batch = await context.adapter.read(signal)
        signal.throwIfAborted()
        if (verifying) {
          const page = await this.snapshot(context.view, p, signal)
          this.recordStatus(p, page)
          if (page.challenge) throw new SourceError('challenge')
          if (page.login) throw new SourceError('login_required')
          signal.throwIfAborted()
        }
        let state: ReturnType<RoundBudget['saved']>
        try {
          state = save(batch)
        } catch (error) {
          durableFailure = !(error instanceof SourceError)
          throw error
        }
        // Never advance the adapter before all rows and source progress commit.
        context.adapter.commit(batch)
        this.cache.append(scope, batch)
        progress.state = state === 'completed' ? 'completed' : 'partial'
        if (state === 'no_growth') progress.message = 'no_growth'
        update()
        if (verifying) {
          verifying = false
          onVerified!()
        }
        if (state !== 'more') break
        if (!budget.exhausted) await delay(1200, signal)
      }
    } catch (error) {
      const reason = signal.aborted ? signal.reason : error
      if (reason instanceof SourceError && reason.state === 'cancelled')
        recordEvent({ operation: `discovery.${p}.collect`, outcome: 'cancelled' })
      else captureError(reason, { operation: `discovery.${p}.collect`, level: 'warn' })
      progress = {
        ...progress,
        state: durableFailure
          ? 'partial'
          : reason instanceof SourceError
            ? reason.state
            : 'network_error',
        message: durableFailure
          ? 'batch_save_failed'
          : reason instanceof SourceError
            ? reason.message
            : 'site_request_failed',
      }
      if (
        progress.state === 'login_required' &&
        this.service.repository.status().find((s) => s.platform === p)?.state === 'authenticated'
      )
        progress.state = 'session_expired'
      if (['login_required', 'session_expired', 'challenge'].includes(progress.state)) {
        const previous = this.service.repository.status().find((s) => s.platform === p)!
        const status = statusFromPage(previous, {
          authenticated: false,
          challenge: progress.state === 'challenge',
          login: progress.state !== 'challenge',
        })
        this.service.work.run(() => this.service.repository.platform(status))
      }
      // A network/parser/storage failure is not proof that the user's block was resolved.
      if (verifying && !needsHumanAction(progress.state)) progress.state = source.state
      update()
    } finally {
      recordEvent({
        operation: `discovery.${p}.collect.${progress.state}`,
        attributes: {
          count: progress.count,
          failedCount: progress.rejectedCount,
          attempt: budget.batches,
        },
      })
      this.sourceControllers.delete(id + p)
      if (
        signal.aborted ||
        this.suspended ||
        (progress.state !== 'partial' && !needsHumanAction(progress.state) && !durableFailure)
      )
        this.releaseQueries(id, p)
    }
  }

  private verificationState(): SourceVerificationState | null {
    const current = this.verificationAttempt
    return current
      ? { runId: current.runId, platform: current.platform, phase: current.phase }
      : null
  }
  private closeVerification() {
    const current = this.verificationAttempt
    this.verificationAttempt = undefined
    if (!current) return
    current.controller.abort(new SourceError('cancelled'))
    if (current.view) this.destroy(current.view)
  }
  private recheckVerification(attempt: VerificationAttempt) {
    attempt.phase = 'checking'
    // Both official QR confirmation and a user-closed challenge window require
    // a fresh committed search batch before the source warning can be cleared.
    const task = bounded(
      this.runTail.catch(() => {}),
      attempt.controller.signal,
    )
      .then(() =>
        this.lane(attempt.platform, async () => {
          attempt.controller.signal.throwIfAborted()
          this.writable(attempt.platform)
          const run = this.service.repository.run(attempt.runId)
          const source = run.sources.find((s) => s.platform === attempt.platform)!
          if (run.state === 'cancelled' || !needsHumanAction(source.state)) return
          this.controllers.set(attempt.runId, attempt.controller)
          this.service.work.run(() => this.service.repository.state(attempt.runId, 'running'))
          const timer = setTimeout(
            () => attempt.controller.abort(new SourceError('timeout')),
            90000,
          )
          try {
            this.releaseQueries(undefined, attempt.platform)
            this.cache.clear()
            await this.collect(attempt.runId, run.query, source, attempt.controller.signal, () => {
              attempt.phase = 'resuming'
            })
          } finally {
            clearTimeout(timer)
            const updated = this.service.repository.run(attempt.runId)
            if (updated.state !== 'cancelled')
              this.service.work.run(() =>
                this.service.repository.state(
                  attempt.runId,
                  updated.sources.every((s) => s.state === 'completed') ? 'completed' : 'partial',
                ),
              )
          }
        }),
      )
      .catch((error) => {
        if (!attempt.controller.signal.aborted)
          captureError(error, { operation: 'discovery.verification.recheck', level: 'warn' })
      })
      .finally(() => {
        if (this.verificationAttempt === attempt) this.verificationAttempt = undefined
        if (this.controllers.get(attempt.runId) === attempt.controller)
          this.controllers.delete(attempt.runId)
        this.tasks.delete(task)
      })
    this.runTail = task
    this.tasks.add(task)
  }
  async verification(input: Parameters<DiscoveryApi['verification']>[0]) {
    const args = sourceVerificationSchema.parse(input)
    if (args.action !== 'open' && args.action !== 'recheck') {
      if (args.action === 'close') this.closeVerification()
      return this.verificationState()
    }
    this.writable(args.platform)
    const current = this.verificationAttempt
    if (current) {
      if (current.runId !== args.runId || current.platform !== args.platform)
        throw new AppServiceError(
          'DISCOVERY_UNAVAILABLE',
          'Complete the current verification first',
        )
      current.view?.show()
      current.view?.focus()
      return this.verificationState()
    }
    const run = this.service.repository.run(args.runId)
    const source = run.sources.find((s) => s.platform === args.platform)
    if (
      run.state === 'cancelled' ||
      !source ||
      (args.action === 'open'
        ? source.state !== 'challenge'
        : source.state !== 'login_required' && source.state !== 'session_expired')
    )
      throw new AppServiceError('VALIDATION_ERROR', 'This source does not need human verification')
    if (args.action === 'recheck') {
      if (this.qr.get(args.platform, args.attemptId)?.state !== 'authenticated')
        throw new AppServiceError('VALIDATION_ERROR', 'Official QR login has not been confirmed')
      const attempt: VerificationAttempt = {
        runId: args.runId,
        platform: args.platform,
        phase: 'checking',
        controller: new AbortController(),
      }
      this.verificationAttempt = attempt
      this.recheckVerification(attempt)
      return this.verificationState()
    }
    const key = args.runId + ':' + args.platform
    const context = this.queries.get(key)
    // Transfer the blocked page to the user: preserve its exact challenge and Session,
    // and remove it from the automated cursor pool before making it interactive.
    this.queries.delete(key)
    const attempt: VerificationAttempt = {
      runId: args.runId,
      platform: args.platform,
      phase: 'open',
      view: context && !context.view.isDestroyed() ? context.view : undefined,
      controller: new AbortController(),
    }
    this.verificationAttempt = attempt
    const onClosed = (userClosed: boolean) => {
      if (attempt.view) {
        this.pages.delete(attempt.view)
        this.pagePlatforms.delete(attempt.view)
      }
      attempt.view = undefined
      if (this.verificationAttempt !== attempt) return
      if (!userClosed) {
        this.closeVerification()
        return
      }
      this.recheckVerification(attempt)
    }
    try {
      await this.qr.cancel(args.platform)
      const platformSession = await this.session(args.platform)
      if (this.verificationAttempt !== attempt) return this.verificationState()
      const { window: view } = this.verificationWindows.open({
        platform: args.platform,
        session: platformSession,
        signal: attempt.controller.signal,
        existing: attempt.view,
        onClosed,
      })
      attempt.view = view
      // A historical run may no longer own a live page. Use its official account
      // entry; rechecking still uses the original search conditions, not this page.
      if (!allowedPage(args.platform, view.webContents.getURL()))
        void view.webContents
          .loadURL(platformAdapter(args.platform).accountCheckUrl)
          .catch((error) => {
            captureError(error, { operation: 'discovery.verification.open', level: 'warn' })
          })
      view.show()
      view.focus()
      return this.verificationState()
    } catch (error) {
      if (this.verificationAttempt === attempt) this.closeVerification()
      throw error
    }
  }
  async detail(input: Parameters<DiscoveryApi['detail']>[0]) {
    const { jobId: id, runId, viewId, observationId, mode } = jobDetailSchema.parse(input)
    this.writable()
    if (this.offlineJobs.has(id))
      throw new AppServiceError('DISCOVERY_JOB_OFFLINE', 'Job is offline')
    const snapshot = this.service.repository.get(id, runId, observationId, viewId)
    if (mode === 'snapshot') return snapshot
    const job = this.service.repository.get(id)
    if (this.verificationAttempt?.platform === job.platform)
      throw new AppServiceError('DISCOVERY_UNAVAILABLE', 'Complete the open verification first')
    const pending = this.details.get(id)
    if (pending)
      return pending.then((result) => {
        if (runId)
          this.service.work.run(() =>
            this.service.repository.reuseObservation(runId, id, result.observationId),
          )
        return {
          ...this.service.repository.get(id, undefined, result.observationId),
          removedFromCurrentSearch: !!runId && !this.service.repository.contains(runId, id),
        }
      })
    const operation = this.lane(job.platform, async () => {
      this.writable(job.platform)
      const view = await this.createPage(job.platform),
        signal = AbortSignal.timeout(25000)
      try {
        await this.load(view, job.url, signal)
        const snapshot = await this.snapshot(view, job.platform, signal, true)
        this.recordStatus(job.platform, snapshot)
        const actual = canonicalJob(job.platform, snapshot.url)
        const expected = canonicalJob(job.platform, job.url)
        const sameJob =
          !!actual &&
          !!expected &&
          (actual.externalId && expected.externalId
            ? actual.externalId === expected.externalId
            : actual.url === expected.url)
        if (!snapshot.challenge && !snapshot.login && snapshot.offline) {
          // A different job or a search/recommendation redirect is not evidence for this ID.
          if (!sameJob) throw new SourceError('scope_unverified')
          this.service.work.run(() => this.service.repository.removeOfflineJob(id))
          this.offlineJobs.add(id)
          this.cache.clear()
          throw new AppServiceError('DISCOVERY_JOB_OFFLINE', 'Job is offline')
        }
        const raw: RawJob = { ...job, detailRead: false, missing: { ...job.missing } }
        if (snapshot.challenge || snapshot.login) {
          for (const f of jobFields)
            if (!raw[f] || (f === 'jd' && !job.detailRead))
              raw.missing![f] = snapshot.challenge ? 'challenge' : 'login_required'
        } else {
          if (!sameJob) throw new SourceError('scope_unverified')
          for (const field of jobFields)
            if (snapshot.detail[field]) {
              raw[field] = snapshot.detail[field]!
              raw.provenance = { ...raw.provenance, [field]: 'dom' }
            }
          raw.detailRead = !!snapshot.detail.detailRead
          if (!raw.detailRead) raw.missing!.jd = 'parse_error'
        }
        if (snapshot.challenge || snapshot.login || !raw.detailRead)
          recordEvent({
            operation: `discovery.${job.platform}.detail.${snapshot.challenge ? 'challenge' : snapshot.login ? 'login_required' : 'parse_error'}`,
          })
        this.service.work.run(() =>
          this.service.repository.observe(raw, runId, Date.now(), 'detail'),
        )
        return {
          ...this.service.repository.get(id),
          removedFromCurrentSearch: !!runId && !this.service.repository.contains(runId, id),
        }
      } finally {
        this.destroy(view)
      }
    })
    this.details.set(id, operation)
    void operation.finally(() => this.details.delete(id)).catch(() => {})
    return operation
  }
  async qrLogin(input: Parameters<DiscoveryApi['qrLogin']>[0]) {
    this.writable()
    const args = qrLoginSchema.parse(input)
    if (args.action === 'start') {
      this.writable(args.platform)
      if (this.verificationAttempt?.platform === args.platform) this.closeVerification()
      return this.qr.start(args.platform)
    }
    if (args.action === 'cancel') await this.qr.cancel(args.platform, args.attemptId)
    if (args.action === 'verify' || args.action === 'retry') {
      this.writable(args.platform)
      return args.action === 'verify'
        ? this.qr.verify(args.platform, args.attemptId)
        : this.qr.retry(args.platform, args.attemptId)
    }
    return this.qr.get(args.platform, args.attemptId)
  }
  async browser(input: Parameters<DiscoveryApi['browser']>[0]) {
    this.writable()
    const args = browserActionSchema.parse(input)
    if (args.action === 'clear') {
      ++this.browserSequence
      const p = args.platform
      this.writable(p)
      this.changing.add(p)
      try {
        if (this.verificationAttempt?.platform === p) this.closeVerification()
        await this.qr.cancel(p)
        for (const [key, controller] of this.sourceControllers)
          if (key.endsWith(p)) controller.abort(new SourceError('cancelled', 'account_changed'))
        this.releaseQueries(undefined, p)
        for (const [view, platform] of this.pagePlatforms) if (platform === p) this.destroy(view)
        if (this.foreground?.platform === p) this.foreground = undefined
        await this.lanes.get(p)?.catch(() => {})
        const platformSession = await this.session(p)
        await platformSession.clearData()
        await platformSession.clearCache()
        this.cache.clear()
        const previous = this.service.repository.status().find((s) => s.platform === p)!
        this.service.work.run(() =>
          this.service.repository.platform({
            ...previous,
            generation: previous.generation + 1,
            state: 'unknown',
            checkedAt: null,
            evidence: '',
            limitations: ['authentication_unchecked'],
          }),
        )
      } finally {
        this.changing.delete(p)
      }
      return
    }
    if (args.action === 'close') {
      ++this.browserSequence
      if (this.foreground) this.destroy(this.foreground.view)
      this.foreground = undefined
      return
    }
    if (args.action === 'open') {
      const sequence = ++this.browserSequence
      const job = this.service.repository.get(args.jobId)
      const p = job.platform
      this.writable(p)
      if (this.foreground) this.destroy(this.foreground.view)
      const view = await this.createPage(p, false)
      if (sequence !== this.browserSequence) {
        this.destroy(view)
        return
      }
      this.foreground = { view, platform: p }
      this.window()?.contentView.addChildView(view)
      await this.region(this.regionValue)
      void view.webContents.loadURL(job.url).catch((error) => {
        if (!view.webContents.isDestroyed() && !/ERR_ABORTED/.test(String(error)))
          captureError(error, { operation: `discovery.${job.platform}.navigation`, level: 'warn' })
      })
      return
    }
    const view = this.foreground?.view
    if (!view || !view.webContents || view.webContents.isDestroyed()) return
    const wc = view.webContents
    const action = args.action
    if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
    if (action === 'forward' && wc.navigationHistory.canGoForward())
      wc.navigationHistory.goForward()
    if (action === 'reload') wc.reload()
    if (action === 'zoomIn') wc.setZoomFactor(Math.min(2, wc.getZoomFactor() + 0.1))
    if (action === 'zoomOut') wc.setZoomFactor(Math.max(0.5, wc.getZoomFactor() - 0.1))
    if (action === 'external' && allowedPage(this.foreground!.platform, wc.getURL()))
      await shell.openExternal(wc.getURL())
  }
  async region(input: BrowserRegion) {
    const rect = browserRegionSchema.parse(input)
    this.regionValue = { ...rect }
    const view = this.foreground?.view,
      win = this.window()
    if (!view || !win) return
    const scale = win.webContents.getZoomFactor()
    rect.x *= scale
    rect.y *= scale
    rect.width *= scale
    rect.height *= scale
    const [width, height] = win.getContentSize(),
      x = Math.max(0, Math.min(width, Math.round(rect.x))),
      y = Math.max(0, Math.min(height, Math.round(rect.y)))
    view.setBounds({
      x,
      y,
      width: Math.max(0, Math.min(width - x, Math.round(rect.width))),
      height: Math.max(0, Math.min(height - y, Math.round(rect.height))),
    })
    view.setVisible(rect.visible && rect.width > 0 && rect.height > 0)
  }
  async suspend() {
    this.suspended = true
    ++this.browserSequence
    this.closeVerification()
    await this.qr.stop()
    for (const controller of this.controllers.values())
      controller.abort(new SourceError('cancelled'))
    for (const view of this.pages) if (!view.webContents.isDestroyed()) view.webContents.stop()
    await Promise.allSettled([...this.tasks])
    for (const view of [...this.pages]) this.destroy(view)
    this.queries.clear()
    this.foreground = undefined
    for (const s of this.sessions.values()) {
      s.flushStorageData()
      await s.cookies.flushStore()
    }
    await this.network.close()
  }
  resume() {
    this.suspended = false
  }
}
