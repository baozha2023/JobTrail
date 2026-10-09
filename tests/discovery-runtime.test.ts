import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { BrowserWindow } from 'electron'
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createServiceContainer } from '../src/main/service-container'
import { DiscoveryRuntime } from '../src/main/discovery/runtime'
import { BossSearch, bossAdapter, bossResponse } from '../src/main/discovery/adapters/boss'
import { SourceError, type SourceBatch } from '../src/main/discovery/adapter'
import { jobIdentity } from '../src/main/discovery/platforms'
import type { PageSnapshot } from '../src/main/discovery/extraction'

const pageState = vi.hoisted(() => ({
  snapshot: {} as Partial<PageSnapshot>,
  networkError: false,
  reads: 0,
  clearFailures: 0,
}))

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class Contents {
    closed = false
    url = ''
    getUserAgent() {
      return 'Mozilla/5.0 职迹/1.7.0 Chrome/150 Electron/43'
    }
    setUserAgent = vi.fn()
    setWebRTCIPHandlingPolicy = vi.fn()
    async loadURL(url: string) {
      if (pageState.networkError) throw new Error('ERR_NAME_NOT_RESOLVED')
      this.url = url
    }
    getURL() {
      return this.url
    }
    async executeJavaScript() {
      pageState.reads++
      return {
        url: this.url,
        authenticated: false,
        login: false,
        challenge: false,
        offline: false,
        detail: {},
        ...pageState.snapshot,
      }
    }
    on() {}
    setWindowOpenHandler() {}
    isDestroyed() {
      return this.closed
    }
    close() {
      this.closed = true
    }
    stop() {}
  }
  class View extends EventEmitter {
    static all: View[] = []
    constructor() {
      super()
      View.all.push(this)
    }
    static getAllWindows() {
      return View.all.filter((w) => !w.isDestroyed())
    }
    webContents = new Contents()
    setBounds() {}
    show() {}
    focus() {}
    setParentWindow() {}
    setSkipTaskbar() {}
    setMenu() {}
    setTitle() {}
    close() {
      this.destroy()
    }
    isDestroyed() {
      return this.webContents.closed
    }
    destroy() {
      if (this.isDestroyed()) return
      this.webContents.close()
      this.emit('closed')
    }
  }
  return {
    BrowserWindow: View,
    WebContentsView: class extends View {},
    shell: {},
    session: {
      defaultSession: { resolveProxy: async () => 'DIRECT' },
      fromPath: () => ({
        setProxy: async () => {},
        closeAllConnections: async () => {},
        getUserAgent: () => 'Mozilla/5.0 职迹/1.7.0 Chrome/150 Electron/43',
        setUserAgent: vi.fn(),
        setPermissionRequestHandler() {},
        setPermissionCheckHandler() {},
        on() {},
        webRequest: { onBeforeRequest() {} },
        flushStorageData() {},
        async clearData() {
          if (pageState.clearFailures > 0) {
            pageState.clearFailures--
            throw new Error('clear_failed')
          }
        },
        async clearCache() {},
        cookies: { flushStore: async () => {} },
      }),
    },
  }
})

const fixtures: {
  root: string
  runtime: DiscoveryRuntime
  container: ReturnType<typeof createServiceContainer>
}[] = []
const pending = new WeakMap<BossSearch, SourceBatch>()
const pages = new WeakMap<BossSearch, number>()
let beforeRead: (page: number, signal: AbortSignal) => Promise<void>
let endPage = 3
let read: MockInstance<BossSearch['read']>
let commit: MockInstance<BossSearch['commit']>
function batch(page: number): SourceBatch {
  return {
    page,
    rawCount: 2,
    sourceIds: [0, 1].map(
      (i) => jobIdentity('boss', `https://www.zhipin.com/job_detail/page${page}_${i}.html`).id,
    ),
    duplicateCount: 0,
    rejectedCount: 0,
    hasMore: page < endPage,
    evidence: 'search_response',
    submitted: { keyword: 'Java', cityCode: '101010100' },
    jobs: [0, 1].map((i) => ({
      platform: 'boss',
      url: `https://www.zhipin.com/job_detail/page${page}_${i}.html`,
      title: '官方相关岗位',
      company: '公司',
      city: '北京',
      salary: '',
      experience: '',
      education: '',
      recruitment: '',
      employment: '',
      jd: '',
      detailRead: false,
    })),
  }
}
beforeEach(() => {
  pageState.snapshot = {}
  pageState.networkError = false
  pageState.reads = 0
  pageState.clearFailures = 0
  endPage = 3
  beforeRead = async () => {}
  read = vi.spyOn(BossSearch.prototype, 'read').mockImplementation(async function (
    this: BossSearch,
    signal,
  ) {
    const page = pages.get(this) ?? 1
    await beforeRead(page, signal)
    if (!pending.has(this)) pending.set(this, batch(page))
    return pending.get(this)!
  })
  commit = vi.spyOn(BossSearch.prototype, 'commit').mockImplementation(function (
    this: BossSearch,
    value,
  ) {
    expect(value).toBe(pending.get(this))
    pages.set(this, value.page + 1)
    pending.delete(this)
  })
})
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.runtime.suspend()
    f.container.database.close()
    fs.rmSync(f.root, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-runtime-'))
  const container = createServiceContainer(
    {
      root,
      config: path.join(root, 'config.json'),
      data: path.join(root, 'data'),
      database: path.join(root, 'data/zhiji.db'),
      resumes: path.join(root, 'resumes'),
      chatUploads: path.join(root, 'chat-uploads'),
    },
    true,
    false,
  )
  const service = container.services.discovery,
    runtime = new DiscoveryRuntime(root, service, () => undefined)
  service.live = runtime
  const f = { root, container, runtime, service }
  fixtures.push(f)
  return f
}
async function settled(f: ReturnType<typeof fixture>, id: string) {
  await vi.waitFor(
    async () => expect(['queued', 'running']).not.toContain((await f.service.run(id)).state),
    { timeout: 10000, interval: 20 },
  )
  // The persisted state is committed just before the scheduler releases admission.
  await new Promise((resolve) => setImmediate(resolve))
  return f.service.run(id)
}
const input = { query: { keyword: 'Java', city: '北京', platforms: ['boss'] as const } }
const start = (f: ReturnType<typeof fixture>) =>
  f.service.start({ requestId: randomUUID(), query: { ...input.query, platforms: ['boss'] } })

async function blockedSearch() {
  const f = fixture()
  endPage = 1
  beforeRead = async () => {
    throw new SourceError('challenge')
  }
  const run = await start(f)
  expect((await settled(f, run.id)).sources[0].state).toBe('challenge')
  const page = BrowserWindow.getAllWindows()[0]
  await page.webContents.loadURL('https://www.zhipin.com/web/geek/verify?opaque=fixture')
  return { f, run, page }
}
it.each([1, 2])(
  'pauses BOSS for re-login when page %s hides salary, keeping saved batches',
  async (page) => {
    const f = fixture()
    const previous = f.service.repository.status().find((s) => s.platform === 'boss')!
    f.service.work.run(() =>
      f.service.repository.platform({ ...previous, state: 'authenticated', checkedAt: Date.now() }),
    )
    beforeRead = async (number) => {
      if (number === page)
        bossResponse(
          {
            code: 0,
            zpData: { hasMore: true, jobList: [{ encryptJobId: 'hidden', jobName: 'Java' }] },
          },
          number,
        )
    }
    const run = await start(f)
    const result = await settled(f, run.id)
    expect(result.sources[0]).toMatchObject({
      state: 'session_expired',
      message: 'session_expired',
      count: (page - 1) * 2,
      batches: page - 1,
    })
    expect(commit).toHaveBeenCalledTimes(page - 1)
    expect((await f.service.status()).find((s) => s.platform === 'boss')?.state).toBe(
      'session_expired',
    )
  },
)
it('opens the blocked page once and clears its warning only after a fresh official batch commits', async () => {
  const { f, run, page } = await blockedSearch()
  const request = { action: 'open', runId: run.id, platform: 'boss' } as const
  expect(await f.service.verification(request)).toEqual({
    runId: run.id,
    platform: 'boss',
    phase: 'open',
  })
  await f.service.verification(request)
  expect(BrowserWindow.getAllWindows()).toEqual([page])
  expect(page.webContents.getURL()).toContain('opaque=fixture')
  expect((await f.service.run(run.id)).sources[0].state).toBe('challenge')
  expect((await f.service.continue(run.id)).sources[0].state).toBe('challenge')
  beforeRead = async () => {}
  pageState.snapshot = { authenticated: true }
  page.close()
  expect((await f.service.verification({ action: 'get' }))?.phase).toBe('checking')
  await vi.waitFor(async () => expect(await f.service.verification({ action: 'get' })).toBeNull())
  const resolved = (await f.service.run(run.id)).sources[0]
  expect(resolved.state).toBe('completed')
  expect(resolved.batches).toBe(1)
  expect(resolved.cachedAt).toBeNull()
  expect(resolved.count).toBe(2)
  expect((await f.service.status()).find((s) => s.platform === 'boss')?.state).toBe('authenticated')
})
it.each(['login_required', 'session_expired'] as const)(
  'requires official QR confirmation before rechecking %s without an interactive website window',
  async (state) => {
    const f = fixture()
    endPage = 1
    beforeRead = async () => {
      throw new SourceError(state)
    }
    const run = await start(f)
    await settled(f, run.id)
    const open = { action: 'open', runId: run.id, platform: 'boss' } as const
    await expect(f.service.verification(open)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    const show = vi.spyOn(BrowserWindow.prototype, 'show')
    vi.spyOn(bossAdapter.qr, 'create').mockReturnValue({
      initialize: async () => ({ image: 'data:image/png;base64,aGVsbG8=', expiresInMs: 180000 }),
      poll: async () => 'authenticated',
    })
    const qr = (await f.service.qrLogin({ action: 'start', platform: 'boss' }))!
    const recheck = {
      action: 'recheck',
      runId: run.id,
      platform: 'boss',
      attemptId: qr.attemptId,
    } as const
    await expect(f.service.verification(recheck)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    })
    await vi.waitFor(
      async () => {
        expect(
          (await f.service.qrLogin({ action: 'get', platform: 'boss', attemptId: qr.attemptId }))
            ?.state,
        ).toBe('authenticated')
      },
      { timeout: 5000 },
    )
    await expect(
      f.service.verification({ ...recheck, attemptId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    beforeRead = async () => {}
    pageState.snapshot = { authenticated: true }
    expect(await f.service.verification(recheck)).toMatchObject({ phase: 'checking' })
    await vi.waitFor(async () => expect(await f.service.verification({ action: 'get' })).toBeNull())
    expect((await f.service.run(run.id)).sources[0]).toMatchObject({
      state: 'completed',
      count: 2,
      batches: 1,
    })
    expect(show).not.toHaveBeenCalled()
  },
)
it.each(['challenge', 'network', 'parse', 'visible_challenge'] as const)(
  'does not treat closing a verification window as success when the recheck reports %s',
  async (failure) => {
    const { f, run, page } = await blockedSearch()
    await f.service.verification({ action: 'open', runId: run.id, platform: 'boss' })
    beforeRead = async () => {
      if (failure === 'challenge') throw new SourceError('challenge')
      if (failure === 'network') throw new Error('network failed')
      if (failure === 'parse') throw new SourceError('parse_error', 'response_contract_changed')
    }
    if (failure === 'visible_challenge')
      pageState.snapshot = { challenge: true, authenticated: true }
    page.close()
    await vi.waitFor(async () => expect(await f.service.verification({ action: 'get' })).toBeNull())
    const result = (await f.service.run(run.id)).sources[0]
    expect(result.state).toBe('challenge')
    expect(result.batches).toBe(0)
    expect(result.count).toBe(0)
  },
)
it('automatically continues only the verified source within one round and keeps later searches queued', async () => {
  const { f, run, page } = await blockedSearch()
  endPage = 8
  let secondPage = false
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  beforeRead = async (number) => {
    if (number === 2) {
      secondPage = true
      await gate
    }
  }
  await f.service.verification({ action: 'open', runId: run.id, platform: 'boss' })
  page.close()
  await vi.waitFor(() => expect(secondPage).toBe(true), { timeout: 5000 })
  expect(await f.service.verification({ action: 'get' })).toMatchObject({ phase: 'resuming' })
  expect(await f.service.run(run.id)).toMatchObject({ state: 'running' })
  expect((await f.service.run(run.id)).sources[0]).toMatchObject({ state: 'partial', count: 2 })
  const next = await f.service.start({
    requestId: randomUUID(),
    query: { ...input.query, keyword: 'Python', platforms: ['boss'] },
  })
  try {
    expect((await f.service.run(next.id)).state).toBe('queued')
  } finally {
    release()
  }
  await vi.waitFor(async () => expect(await f.service.verification({ action: 'get' })).toBeNull(), {
    timeout: 5000,
  })
  expect((await settled(f, run.id)).sources[0]).toMatchObject({
    state: 'partial',
    sourcePage: 3,
    batches: 3,
    count: 6,
  })
  expect((await settled(f, next.id)).sources[0].count).toBe(6)
  expect(read).toHaveBeenCalledTimes(7) // Original block, three resumed batches, then three batches for the other query.
})
it('stops automatic continuation at a new challenge and retains the committed batch', async () => {
  const { f, run, page } = await blockedSearch()
  endPage = 3
  beforeRead = async (number) => {
    if (number === 2) throw new SourceError('challenge')
  }
  await f.service.verification({ action: 'open', runId: run.id, platform: 'boss' })
  page.close()
  await vi.waitFor(async () => expect(await f.service.verification({ action: 'get' })).toBeNull(), {
    timeout: 5000,
  })
  expect((await f.service.run(run.id)).sources[0]).toMatchObject({
    state: 'challenge',
    batches: 1,
    count: 2,
  })
  expect(read).toHaveBeenCalledTimes(3)
})
it('keeps the human warning and does not continue when the first verified batch cannot commit', async () => {
  const { f, run, page } = await blockedSearch()
  endPage = 3
  beforeRead = async () => {}
  vi.spyOn(f.service.repository, 'observe').mockImplementation(() => {
    throw new Error('disk write failed')
  })
  await f.service.verification({ action: 'open', runId: run.id, platform: 'boss' })
  page.close()
  await vi.waitFor(async () => expect(await f.service.verification({ action: 'get' })).toBeNull())
  expect((await f.service.run(run.id)).sources[0]).toMatchObject({
    state: 'challenge',
    message: 'batch_save_failed',
    count: 0,
    batches: 0,
  })
  expect(read).toHaveBeenCalledTimes(2)
  expect(commit).not.toHaveBeenCalled()
})
it('does not restart other sources while continuing a verified historical source', async () => {
  const f = fixture()
  endPage = 2
  const run = f.service.work.run(() =>
    f.service.repository.create({ ...input.query, platforms: ['boss', 'liepin'] }, randomUUID()),
  )
  f.service.work.run(() => {
    f.service.repository.state(run.id, 'partial')
    for (const source of run.sources)
      f.service.repository.source(run.id, {
        ...source,
        state: source.platform === 'boss' ? 'challenge' : 'partial',
      })
  })
  const other = (await f.service.run(run.id)).sources.find((s) => s.platform === 'liepin')
  await f.service.verification({ action: 'open', runId: run.id, platform: 'boss' })
  BrowserWindow.getAllWindows()[0].close()
  await vi.waitFor(async () => expect(await f.service.verification({ action: 'get' })).toBeNull(), {
    timeout: 5000,
  })
  const result = await f.service.run(run.id)
  expect(result.sources.find((s) => s.platform === 'boss')).toMatchObject({
    state: 'completed',
    count: 4,
    batches: 2,
  })
  expect(result.sources.find((s) => s.platform === 'liepin')).toEqual(other)
  expect(result.state).toBe('partial')
})
it.each(['cancel', 'logout', 'maintenance', 'close'] as const)(
  'does not continue saving after %s during automatic continuation',
  async (action) => {
    const { f, run, page } = await blockedSearch()
    endPage = 3
    let secondPage = false
    beforeRead = async (number, signal) => {
      if (number !== 2) return
      secondPage = true
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }
    await f.service.verification({ action: 'open', runId: run.id, platform: 'boss' })
    page.close()
    await vi.waitFor(() => expect(secondPage).toBe(true), { timeout: 5000 })
    if (action === 'cancel') await f.service.cancel(run.id)
    else if (action === 'logout') await f.service.browser({ action: 'clear', platform: 'boss' })
    else if (action === 'maintenance') await f.runtime.suspend()
    else await f.service.verification({ action: 'close' })
    await settled(f, run.id)
    expect((await f.service.run(run.id)).sources[0]).toMatchObject({
      state: 'cancelled',
      batches: 1,
      count: 2,
    })
    expect(commit).toHaveBeenCalledTimes(1)
    expect(BrowserWindow.getAllWindows()).toHaveLength(0)
  },
)
it('closes verification without rechecking on explicit cancellation and logout', async () => {
  const { f, run } = await blockedSearch()
  const request = { action: 'open', runId: run.id, platform: 'boss' } as const
  await f.service.verification(request)
  const reads = read.mock.calls.length
  await f.service.verification({ action: 'close' })
  expect(await f.service.verification({ action: 'get' })).toBeNull()
  expect(BrowserWindow.getAllWindows()).toHaveLength(0)
  await f.service.verification(request)
  await f.service.browser({ action: 'clear', platform: 'boss' })
  expect(await f.service.verification({ action: 'get' })).toBeNull()
  expect(BrowserWindow.getAllWindows()).toHaveLength(0)
  expect(read).toHaveBeenCalledTimes(reads)
})
it('aborts a pending verification recheck during maintenance without losing the warning', async () => {
  const { f, run, page } = await blockedSearch()
  await f.service.verification({ action: 'open', runId: run.id, platform: 'boss' })
  let reading = false
  beforeRead = async (_page, signal) =>
    new Promise<void>((_resolve, reject) => {
      reading = true
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  page.close()
  await vi.waitFor(() => expect(reading).toBe(true))
  await f.runtime.suspend()
  expect(await f.service.verification({ action: 'get' })).toBeNull()
  expect((await f.service.run(run.id)).sources[0].state).toBe('challenge')
  expect(BrowserWindow.getAllWindows()).toHaveLength(0)
})

it('does not reuse anonymous cached batches after a confirmed QR login', async () => {
  const f = fixture()
  endPage = 1
  const first = await start(f)
  await settled(f, first.id)
  expect(read).toHaveBeenCalledOnce()
  const previous = (await f.service.status()).find((s) => s.platform === 'boss')!
  vi.spyOn(bossAdapter.qr, 'create').mockReturnValue({
    initialize: async () => ({ image: 'data:image/png;base64,aGVsbG8=', expiresInMs: 180000 }),
    poll: async () => 'authenticated',
  })
  await f.service.qrLogin({ action: 'start', platform: 'boss' })
  await vi.waitFor(
    async () => {
      expect((await f.service.status()).find((s) => s.platform === 'boss')).toMatchObject({
        state: 'authenticated',
        generation: previous.generation + 1,
      })
    },
    { timeout: 5000 },
  )
  const next = await start(f)
  await settled(f, next.id)
  expect(read).toHaveBeenCalledTimes(2)
})

it('reuses current detail across frozen views, while snapshot and force-refresh stay distinct', async () => {
  const f = fixture(),
    run = await start(f)
  await settled(f, run.id)
  const view = await f.service.list({ runId: run.id }),
    job = view.items[0]
  const args = {
    jobId: job.id,
    runId: run.id,
    viewId: view.viewId,
    observationId: job.observationId,
  }
  pageState.snapshot = { detail: { jd: '完整职责', detailRead: true } }
  const first = await f.service.detail({ ...args, mode: 'ensure' })
  expect(first.detailRead).toBe(true)
  expect(pageState.reads).toBe(1)
  expect(await f.service.detail({ ...args, mode: 'ensure' })).toEqual(first)
  expect(pageState.reads).toBe(1)
  expect(await f.service.detail({ ...args, mode: 'snapshot' })).toMatchObject({
    observationId: job.observationId,
    detailRead: false,
  })
  expect(
    (await f.service.list({ runId: run.id, viewId: view.viewId })).items[0].observationId,
  ).toBe(job.observationId)
  await f.service.detail({ ...args, mode: 'refresh' })
  expect(pageState.reads).toBe(2)
  // A valid cache remains usable by an independent MCP service without a desktop runtime.
  f.service.live = undefined
  expect((await f.service.detail({ ...args, mode: 'ensure' })).detailRead).toBe(true)
  await expect(f.service.detail({ ...args, mode: 'refresh' })).rejects.toMatchObject({
    code: 'DISCOVERY_UNAVAILABLE',
  })
  f.service.live = f.runtime
  const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1800000)
  await f.service.detail({ ...args, mode: 'ensure' })
  expect(pageState.reads).toBe(3)
  now.mockRestore()
  await expect(f.service.detail({ ...args, refresh: true } as never)).rejects.toThrow()
})

it('releases the account-change lock after a clear failure so logout can be retried', async () => {
  const f = fixture()
  pageState.clearFailures = 1
  await expect(f.runtime.browser({ action: 'clear', platform: 'boss' })).rejects.toThrow(
    'clear_failed',
  )
  await f.runtime.browser({ action: 'clear', platform: 'boss' })
  expect((await f.service.status()).find((item) => item.platform === 'boss')).toMatchObject({
    state: 'unknown',
    generation: 1,
    limitations: ['authentication_unchecked'],
  })
})

it('deletes confirmed offline jobs and prevents stale source pages from reintroducing them', async () => {
  const f = fixture()
  endPage = 1
  const run = await start(f)
  await settled(f, run.id)
  const view = await f.service.list({ runId: run.id })
  const job = view.items[0]
  pageState.snapshot = { offline: true }
  const request = { jobId: job.id, runId: run.id, viewId: view.viewId, mode: 'refresh' as const }
  await expect(
    Promise.all([f.service.detail(request), f.service.detail(request)]),
  ).rejects.toMatchObject({ code: 'DISCOVERY_JOB_OFFLINE' })
  expect(
    (await f.service.list({ runId: run.id, viewId: view.viewId })).items.map((j) => j.id),
  ).not.toContain(job.id)
  const next = await start(f)
  await settled(f, next.id)
  expect((await f.service.list({ runId: next.id })).items.map((j) => j.id)).not.toContain(job.id)
  expect((await f.service.run(next.id)).sources[0].count).toBe(1)
  await expect(f.service.detail(request)).rejects.toMatchObject({ code: 'DISCOVERY_JOB_OFFLINE' })
})

it.each(['login', 'challenge', 'blank', 'redirect', 'network'] as const)(
  'never deletes a job after a %s failure',
  async (reason) => {
    const f = fixture(),
      r = f.service.repository
    const raw = batch(1).jobs[0]
    f.service.work.run(() => r.observe(raw))
    const id = jobIdentity(raw.platform, raw.url).id
    pageState.snapshot =
      reason === 'login'
        ? { login: true, offline: true }
        : reason === 'challenge'
          ? { challenge: true, offline: true }
          : reason === 'redirect'
            ? { url: 'https://www.zhipin.com/job_detail/different.html', offline: true }
            : {}
    pageState.networkError = reason === 'network'
    const request = f.service.detail({ jobId: id, mode: 'refresh' as const })
    if (reason === 'network' || reason === 'redirect') await expect(request).rejects.toBeDefined()
    else await request
    expect(r.get(id).id).toBe(id)
  },
)

it('retains the furthest committed page across repeated cursor loss during replay', async () => {
  const f = fixture()
  endPage = 9
  const run = await start(f)
  await settled(f, run.id)
  await f.service.continue(run.id)
  expect((await settled(f, run.id)).sources[0].sourcePage).toBe(6)
  for (let loss = 0; loss < 2; loss++) {
    BrowserWindow.getAllWindows()[0].webContents.close()
    await f.service.continue(run.id)
    expect((await settled(f, run.id)).sources[0]).toMatchObject({
      sourcePage: 6,
      count: 12,
      state: 'partial',
    })
  }
  await f.service.continue(run.id)
  expect((await settled(f, run.id)).sources[0]).toMatchObject({
    sourcePage: 6,
    count: 12,
    state: 'partial',
  })
  await f.service.continue(run.id)
  expect((await settled(f, run.id)).sources[0]).toMatchObject({
    sourcePage: 9,
    count: 18,
    state: 'completed',
  })
}, 25000)

it('rolls back a whole failed batch and retries it before advancing the source', async () => {
  const f = fixture(),
    repo = f.service.repository,
    original = repo.observe.bind(repo)
  let calls = 0
  const observe = vi.spyOn(repo, 'observe').mockImplementation((...args) => {
    if (++calls === 2) throw new Error('disk write failed')
    return original(...args)
  })
  const run = await start(f),
    failed = await settled(f, run.id)
  expect(failed.sources[0]).toMatchObject({
    state: 'partial',
    sourcePage: 0,
    count: 0,
    message: 'batch_save_failed',
  })
  expect(repo.sourceCount(run.id, 'boss')).toBe(0)
  expect(commit).not.toHaveBeenCalled()
  observe.mockRestore()
  await f.service.continue(run.id)
  expect((await settled(f, run.id)).sources[0]).toMatchObject({
    state: 'completed',
    sourcePage: 3,
    count: 6,
  })
  expect(commit.mock.calls.map(([b]) => b.page)).toEqual([1, 2, 3])
  expect(read).toHaveBeenCalledTimes(4)
})

it('cancels an in-flight page, preserves saved identities and replays an expired cursor without loss', async () => {
  const f = fixture()
  let waiting = false
  beforeRead = async (page, signal) => {
    if (page !== 2) return
    waiting = true
    await new Promise<void>((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
    )
  }
  const run = await start(f)
  await vi.waitFor(() => expect(waiting).toBe(true), { timeout: 5000 })
  await f.service.cancel(run.id)
  await settled(f, run.id)
  expect(f.service.repository.sourceCount(run.id, 'boss')).toBe(2)
  beforeRead = async () => {}
  await f.service.continue(run.id)
  await settled(f, run.id)
  const all = await f.service.list({ runId: run.id })
  expect(all.items.map((j) => j.id).sort()).toEqual(
    [1, 2, 3].flatMap((p) => batch(p).jobs.map((j) => jobIdentity('boss', j.url).id)).sort(),
  )
  expect(commit.mock.calls.map(([b]) => b.page)).toEqual([1, 1, 2, 3])
})

it('uses the cached prefix then rebuilds the native cursor and appends later pages without duplicate display entries', async () => {
  const f = fixture()
  endPage = 6
  const first = await start(f)
  await settled(f, first.id)
  const reads = read.mock.calls.length
  const second = await start(f)
  await settled(f, second.id)
  expect(read).toHaveBeenCalledTimes(reads)
  const view = await f.service.list({ runId: second.id })
  for (let round = 0; round < 2; round++) {
    await f.service.continue(second.id)
    await settled(f, second.id)
  }
  const final = await f.service.list({ runId: second.id, viewId: view.viewId })
  expect(final.items.slice(0, view.items.length).map((j) => j.id)).toEqual(
    view.items.map((j) => j.id),
  )
  expect(final.total).toBe(12)
  expect(new Set(final.items.map((j) => j.id)).size).toBe(12)
  expect((await f.service.run(second.id)).sources[0]).toMatchObject({
    sourcePage: 6,
    state: 'completed',
  })
}, 15000)

it('continues through fully excluded source batches and isolates salary caches', async () => {
  const f = fixture()
  endPage = 6
  const run = await f.service.start({
    requestId: randomUUID(),
    query: { ...input.query, platforms: ['boss'], salaryMin: 15000, salaryMax: 20000 },
  })
  const first = await settled(f, run.id)
  expect(first.sources[0]).toMatchObject({
    sourcePage: 3,
    count: 0,
    duplicateCount: 0,
    salaryExcluded: { unknown: 6 },
  })
  await f.service.continue(run.id)
  expect((await settled(f, run.id)).sources[0]).toMatchObject({
    sourcePage: 6,
    count: 0,
    state: 'completed',
    salaryExcluded: { unknown: 12 },
  })
  expect(f.container.database.db.prepare('SELECT COUNT(*) n FROM discovery_jobs').get()).toEqual({
    n: 0,
  })
  const unfiltered = await start(f)
  expect((await settled(f, unfiltered.id)).sources[0]).toMatchObject({
    sourcePage: 3,
    count: 6,
    cachedAt: null,
  })
}, 20000)

it('persists valid rows despite skipped parse failures and keeps collecting city-filtered batches', async () => {
  const f = fixture()
  read.mockImplementation(async function (this: BossSearch) {
    const page = pages.get(this) ?? 1
    const value = batch(page)
    // Platform adapters return only admitted jobs, but retain identities before their filters.
    value.rawCount += 1
    value.rejectedCount = 1
    if (page < 3) value.jobs = []
    pending.set(this, value)
    return value
  })
  const run = await start(f)
  const done = await settled(f, run.id)
  expect(done.sources[0]).toMatchObject({
    state: 'completed',
    sourcePage: 3,
    count: 2,
    validCount: 6,
    rawCount: 9,
    rejectedCount: 3,
    duplicateCount: 0,
  })
  expect((await f.service.list({ runId: run.id })).items).toHaveLength(2)
  expect(f.container.database.db.prepare('SELECT COUNT(*) n FROM discovery_jobs').get()).toEqual({
    n: 2,
  })
  const cached = await start(f)
  expect((await settled(f, cached.id)).sources[0]).toMatchObject({
    state: 'completed',
    count: 2,
    rejectedCount: 3,
  })
})
it('rejects inconsistent batch counts before saving any jobs as a website request failure', async () => {
  const f = fixture()
  read.mockResolvedValue({ ...batch(1), rawCount: 3 })
  const run = await start(f)
  expect((await settled(f, run.id)).sources[0]).toMatchObject({
    state: 'network_error',
    message: 'batch_accounting_mismatch',
    batches: 0,
    count: 0,
  })
  expect(commit).not.toHaveBeenCalled()
  expect((await f.service.list({ runId: run.id })).items).toHaveLength(0)
})
