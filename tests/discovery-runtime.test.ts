import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { BrowserWindow, type WebContentsView } from 'electron'
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createServiceContainer } from '../src/main/service-container'
import { DiscoveryRuntime } from '../src/main/discovery/runtime'
import { BossSearch, bossAdapter, bossResponse } from '../src/main/discovery/adapters/boss'
import { shixisengAdapter, ShixisengSearch } from '../src/main/discovery/adapters/shixiseng'
import {
  SourceError,
  type SourceBatch,
  type SearchTransport,
  type AccountSessionState,
} from '../src/main/discovery/adapter'
import { jobIdentity } from '../src/main/discovery/platforms'
import type { PageSnapshot } from '../src/main/discovery/extraction'
import { MCP_TOOLS } from '../src/main/mcp-contracts'
import { platformCities } from '../src/shared/discovery-cities'
import { platforms } from '../src/shared/job-discovery'
import { platformAdapter } from '../src/main/discovery/adapter-registry'

// Account rechecks include the runtime's bounded page-settle interval.
const waitFor: typeof vi.waitFor = (callback, options) =>
  vi.waitFor(callback, options ?? { timeout: 5000 })

const pageState = vi.hoisted(() => ({
  snapshot: {} as Partial<PageSnapshot>,
  accountSnapshot: { authenticated: true } as Partial<PageSnapshot>,
  accountReads: 0,
  networkError: false,
  reads: 0,
  clearFailures: 0,
  deferLoads: false,
}))

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class Contents extends EventEmitter {
    closed = false
    url = ''
    getUserAgent() {
      return 'Mozilla/5.0 职迹/1.7.0 Chrome/150 Electron/43'
    }
    setUserAgent = vi.fn()
    setWebRTCIPHandlingPolicy = vi.fn()
    async loadURL(url: string) {
      this.emit('did-start-loading')
      if (pageState.networkError && url !== 'https://www.zhipin.com/')
        throw new Error('ERR_NAME_NOT_RESOLVED')
      this.url = url
      if (!pageState.deferLoads) this.emit('did-stop-loading')
    }
    getURL() {
      return this.url
    }
    async executeJavaScript() {
      const account = this.url === 'https://www.zhipin.com/'
      if (account) pageState.accountReads++
      else pageState.reads++
      return {
        url: this.url,
        authenticated: false,
        login: false,
        challenge: false,
        offline: false,
        detail: {},
        ...(account ? pageState.accountSnapshot : pageState.snapshot),
      }
    }
    setWindowOpenHandler() {}
    isDestroyed() {
      return this.closed
    }
    close() {
      this.closed = true
      this.emit('destroyed')
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
    contentView = {
      children: [] as unknown[],
      addChildView(view: unknown) {
        this.children.push(view)
      },
      setBounds() {},
    }
    getContentSize() {
      return [960, 760]
    }
    hide() {}
    setBounds() {}
    setVisible = vi.fn()
    show() {}
    focus() {}
    setParentWindow() {}
    setSkipTaskbar() {}
    setMenu() {}
    setTitle() {}
    close() {
      this.emit('close', { preventDefault() {} })
      this.destroy()
    }
    isDestroyed() {
      return !this.webContents || this.webContents.closed
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
  pageState.snapshot = { authenticated: true }
  pageState.accountSnapshot = { authenticated: true }
  pageState.accountReads = 0
  pageState.networkError = false
  pageState.reads = 0
  pageState.clearFailures = 0
  pageState.deferLoads = false
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
function fixture(window?: BrowserWindow, authenticated = true) {
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
    browserLoading = vi.fn(),
    runtime = new DiscoveryRuntime(root, service, () => window, browserLoading)
  service.live = runtime
  if (authenticated)
    service.repository.platform({
      ...service.repository.status().find((s) => s.platform === 'boss')!,
      state: 'authenticated',
      checkedAt: 1234,
      evidence: 'official_qr_login_confirmed',
      limitations: [],
    })
  const f = { root, container, runtime, service, browserLoading }
  fixtures.push(f)
  return f
}
async function settled(f: ReturnType<typeof fixture>, id: string) {
  await waitFor(
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

it('enforces Shixiseng login through backend and MCP without contacting the search page', async () => {
  const f = fixture(undefined, false),
    read = vi.spyOn(ShixisengSearch.prototype, 'read')
  const check = vi.spyOn(shixisengAdapter, 'checkSession')
  for (const viaMcp of [false, true]) {
    const input = {
      requestId: randomUUID(),
      query: { keyword: viaMcp ? '运营' : '设计', city: '', platforms: ['shixiseng' as const] },
    }
    if (viaMcp) {
      const tool = MCP_TOOLS.find((t) => t.name === 'start_job_search')!
      await tool.execute(
        f.container.services,
        tool.inputSchema.parse(input) as Record<string, unknown>,
        AbortSignal.timeout(1000),
      )
    } else await f.service.start(input)
    const history = await f.service.history(1)
    const run = await settled(f, history.items[0].id)
    expect(run.sources[0].state).toBe('login_required')
  }
  expect(read).not.toHaveBeenCalled()
  expect(check).not.toHaveBeenCalled()
})
it('blocks collection on account network failure without revoking Shixiseng login', async () => {
  const f = fixture(),
    repo = f.service.repository
  repo.platform({
    ...repo.status().find((s) => s.platform === 'shixiseng')!,
    state: 'authenticated',
    checkedAt: 1234,
    evidence: 'official_qr_login_confirmed',
  })
  vi.spyOn(shixisengAdapter, 'checkSession').mockRejectedValue(new Error('network'))
  const read = vi.spyOn(ShixisengSearch.prototype, 'read')
  const run = await f.service.start({
    requestId: randomUUID(),
    query: { keyword: '运营', city: '', platforms: ['shixiseng'] },
  })
  expect((await settled(f, run.id)).sources[0].state).toBe('network_error')
  expect(repo.status().find((s) => s.platform === 'shixiseng')?.state).toBe('authenticated')
  expect(read).not.toHaveBeenCalled()
})
it('does not let a late account rejection overwrite a newer login generation', async () => {
  const f = fixture(),
    repo = f.service.repository
  const initial = {
    ...repo.status().find((s) => s.platform === 'shixiseng')!,
    state: 'authenticated' as const,
    checkedAt: 1234,
    evidence: 'official_qr_login_confirmed',
  }
  repo.platform(initial)
  let finish!: (value: AccountSessionState) => void
  const check = vi.spyOn(shixisengAdapter, 'checkSession').mockImplementation(
    () =>
      new Promise<AccountSessionState>((resolve) => {
        finish = resolve
      }),
  )
  const run = await f.service.start({
    requestId: randomUUID(),
    query: { keyword: '运营', city: '', platforms: ['shixiseng'] },
  })
  await waitFor(() => expect(check).toHaveBeenCalledOnce())
  repo.platform({ ...initial, generation: initial.generation + 1 })
  finish('login_required')
  await settled(f, run.id)
  expect(repo.status().find((s) => s.platform === 'shixiseng')).toMatchObject({
    state: 'authenticated',
    generation: initial.generation + 1,
  })
})

it.each([null, 'challenge', 'login_required'] as const)(
  'discards a late batch outcome (%s) after the account generation changes',
  async (failure) => {
    const f = fixture()
    vi.spyOn(bossAdapter, 'checkSession').mockResolvedValue('authenticated')
    beforeRead = async () => {
      const previous = f.service.repository.status().find((s) => s.platform === 'boss')!
      f.service.repository.platform({ ...previous, generation: previous.generation + 1 })
      if (failure) throw new SourceError(failure)
    }
    const run = await start(f)
    expect((await settled(f, run.id)).sources[0]).toMatchObject({ state: 'cancelled', count: 0 })
    expect(commit).not.toHaveBeenCalled()
    expect((await f.service.list({ runId: run.id })).items).toEqual([])
    expect(f.service.repository.status().find((s) => s.platform === 'boss')).toMatchObject({
      state: 'authenticated',
      generation: 1,
    })
  },
)

it('rejects unsupported city combinations through both UI and MCP before creating a run', async () => {
  const f = fixture()
  const request: Parameters<typeof f.service.start>[0] = {
    requestId: randomUUID(),
    query: { keyword: '销售', city: '白杨', platforms: ['boss', 'liepin'] },
  }
  await expect(f.service.start(request)).rejects.toMatchObject({
    code: 'DISCOVERY_UNSUPPORTED_CITY',
  })
  const tool = MCP_TOOLS.find((t) => t.name === 'start_job_search')!
  await expect(
    tool.execute(
      f.container.services,
      tool.inputSchema.parse(request) as Record<string, unknown>,
      AbortSignal.timeout(1000),
    ),
  ).rejects.toMatchObject({ code: 'DISCOVERY_UNSUPPORTED_CITY' })
  expect((await f.service.history(1)).total).toBe(0)
})

it.each([
  ['boss', '白杨'],
  ['wuyou', '昆山'],
  ['boss', '天津市'],
  ['liepin', ''],
] as const)('accepts a supported or empty city: %s / %s', async (platform, city) => {
  const f = fixture()
  const run = f.service.repository.create(
    { keyword: '销售', city, platforms: [platform] },
    randomUUID(),
  )
  const live = vi.spyOn(f.runtime, 'start').mockResolvedValue(run)
  await expect(
    f.service.start({
      requestId: randomUUID(),
      query: { keyword: '销售', city, platforms: [platform] },
    }),
  ).resolves.toEqual(run)
  expect(live).toHaveBeenCalledOnce()
})

it('reports each platform catalog independently of persisted account capabilities', async () => {
  const f = fixture()
  const statuses = await f.service.status()
  for (const status of statuses) {
    f.service.repository.platform({
      ...status,
      capabilities: { ...status.capabilities, cities: ['旧城市'] },
    })
  }
  for (const status of await f.service.status()) {
    expect(status.capabilities.cities).toEqual(platformCities(status.platform).map((c) => c.name))
  }
})

it('keeps historical cities readable and reports unsupported sources on continuation', async () => {
  const f = fixture()
  const query = { keyword: '销售', city: '已移除的城市', platforms: ['boss'] as const }
  const run = f.service.repository.create({ ...query, platforms: ['boss'] }, randomUUID())
  f.service.work.run(() => f.service.repository.state(run.id, 'partial'))
  expect((await f.service.history(1)).items[0].query.city).toBe(query.city)
  await f.service.continue(run.id)
  const result = await settled(f, run.id)
  expect(result.query).toEqual(query)
  expect(result.sources[0].state).toBe('unsupported_city')
})

function foregroundFixture() {
  const children: WebContentsView[] = []
  const window = {
    contentView: {
      children,
      addChildView: (view: WebContentsView) => children.push(view),
      removeChildView: (view: WebContentsView) => children.splice(children.indexOf(view), 1),
    },
    webContents: { getZoomFactor: () => 1 },
    getContentSize: () => [1200, 900],
  } as unknown as BrowserWindow
  const f = fixture(window)
  const raw = batch(1).jobs[0]
  f.service.work.run(() => f.service.repository.observe(raw))
  return { ...f, children, jobId: jobIdentity(raw.platform, raw.url).id }
}

it('reports native page loading, hides the view during navigation and ignores replaced views', async () => {
  const f = foregroundFixture()
  pageState.deferLoads = true
  const rect = { x: 400, y: 100, width: 700, height: 700, visible: true }
  await f.runtime.region(rect)
  const requestId = randomUUID()
  await f.runtime.browser({ action: 'open', jobId: f.jobId, requestId })
  const first = f.children[0]
  expect(f.browserLoading).toHaveBeenLastCalledWith({ requestId, loading: true })
  expect(first.setVisible).toHaveBeenLastCalledWith(false)
  first.webContents.emit('did-stop-loading')
  expect(f.browserLoading).toHaveBeenLastCalledWith({ requestId, loading: false })
  await f.runtime.region(rect)
  expect(first.setVisible).toHaveBeenLastCalledWith(true)
  first.webContents.emit('did-start-loading')
  await f.runtime.region(rect)
  expect(first.setVisible).toHaveBeenLastCalledWith(false)
  expect(f.browserLoading).toHaveBeenLastCalledWith({ requestId, loading: true })

  const nextRequestId = randomUUID()
  await f.runtime.browser({ action: 'open', jobId: f.jobId, requestId: nextRequestId })
  const count = f.browserLoading.mock.calls.length
  first.webContents.emit('did-stop-loading')
  expect(f.browserLoading).toHaveBeenCalledTimes(count)
  expect(f.browserLoading).toHaveBeenLastCalledWith({ requestId: nextRequestId, loading: true })
  f.children[0].webContents.emit('render-process-gone')
  expect(f.browserLoading).toHaveBeenLastCalledWith({ requestId: nextRequestId, loading: false })
  await f.runtime.browser({ action: 'close' })
  expect(f.children).toHaveLength(0)
})

it('drops a pending browser action when its page closes during the account check', async () => {
  const f = foregroundFixture()
  const check = vi.spyOn(bossAdapter, 'checkSession').mockResolvedValue('authenticated')
  await f.runtime.browser({ action: 'open', jobId: f.jobId, requestId: randomUUID() })
  const wc = f.children[0].webContents
  const reload = vi.fn()
  Object.assign(wc, { reload })
  let finish!: (state: AccountSessionState) => void
  check.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const pending = f.runtime.browser({ action: 'reload' })
  await waitFor(() => expect(finish).toBeTypeOf('function'))
  await f.runtime.browser({ action: 'close' })
  finish('authenticated')
  await pending
  expect(reload).not.toHaveBeenCalled()
  expect(f.children).toHaveLength(0)
})

it('releases the previous job page when opening another job fails its account check', async () => {
  const f = foregroundFixture()
  const check = vi.spyOn(bossAdapter, 'checkSession').mockResolvedValue('authenticated')
  await f.runtime.browser({ action: 'open', jobId: f.jobId, requestId: randomUUID() })
  const previous = f.children[0].webContents
  const next = batch(1).jobs[1]
  f.service.work.run(() => f.service.repository.observe(next))
  check.mockResolvedValue('login_required')
  await expect(
    f.runtime.browser({
      action: 'open',
      jobId: jobIdentity(next.platform, next.url).id,
      requestId: randomUUID(),
    }),
  ).rejects.toMatchObject({ state: 'session_expired' })
  expect(previous.isDestroyed()).toBe(true)
  expect(f.children).toHaveLength(0)
})

it('releases a foreground view when the website closes its own contents', async () => {
  const f = foregroundFixture()
  vi.spyOn(bossAdapter, 'checkSession').mockResolvedValue('authenticated')
  await f.runtime.browser({ action: 'open', jobId: f.jobId, requestId: randomUUID() })
  const view = f.children[0]
  view.webContents.close()
  Object.defineProperty(view, 'webContents', { value: undefined })
  expect(f.children).toHaveLength(0)
  await expect(
    f.runtime.region({ x: 0, y: 0, width: 500, height: 500, visible: true }),
  ).resolves.toBeUndefined()
  await expect(f.runtime.suspend()).resolves.toBeUndefined()
})

it('ends foreground loading on a failed page request', async () => {
  const f = foregroundFixture()
  pageState.networkError = true
  const requestId = randomUUID()
  await f.runtime.browser({ action: 'open', jobId: f.jobId, requestId })
  await waitFor(() => {
    expect(f.browserLoading).toHaveBeenLastCalledWith({ requestId, loading: false })
  })
  expect(f.browserLoading).toHaveBeenCalledWith({ requestId, loading: true })
})

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
  expect(BrowserWindow.getAllWindows()).toHaveLength(2)
  expect(page.isDestroyed()).toBe(true)
  const host = BrowserWindow.getAllWindows().at(-1)!
  const officialPage = host.contentView.children[0] as WebContentsView
  expect(officialPage.webContents.getURL()).toContain('opaque=fixture')
  expect((await f.service.run(run.id)).sources[0].state).toBe('challenge')
  expect((await f.service.continue(run.id)).sources[0].state).toBe('challenge')
  beforeRead = async () => {}
  pageState.snapshot = { authenticated: true }
  BrowserWindow.getAllWindows().at(-1)!.close()
  expect((await f.service.verification({ action: 'get' }))?.phase).toBe('checking')
  await waitFor(async () => expect(await f.service.verification({ action: 'get' })).toBeNull())
  const resolved = (await f.service.run(run.id)).sources[0]
  expect(resolved.state).toBe('completed')
  expect(resolved.batches).toBe(1)
  expect(resolved.cachedAt).toBeNull()
  expect(resolved.count).toBe(2)
  expect((await f.service.status()).find((s) => s.platform === 'boss')?.state).toBe('authenticated')
})
it('ignores verification page evidence from a replaced login generation', async () => {
  const { f, run } = await blockedSearch()
  await f.service.verification({ action: 'open', runId: run.id, platform: 'boss' })
  beforeRead = async () => {
    const page = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === '')!
    vi.spyOn(page.webContents, 'executeJavaScript').mockImplementationOnce(async () => {
      const previous = f.service.repository.status().find((s) => s.platform === 'boss')!
      f.service.repository.platform({ ...previous, generation: previous.generation + 1 })
      return { url: '', authenticated: false, challenge: false, login: true, detail: {} }
    })
  }
  BrowserWindow.getAllWindows().at(-1)!.close()
  await waitFor(async () => expect(await f.service.verification({ action: 'get' })).toBeNull())
  expect((await f.service.run(run.id)).sources[0]).toMatchObject({
    state: 'challenge',
    message: 'account_changed',
    count: 0,
  })
  expect(f.service.repository.status().find((s) => s.platform === 'boss')).toMatchObject({
    state: 'authenticated',
    generation: 1,
  })
  expect(commit).not.toHaveBeenCalled()
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
    await waitFor(
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
    await waitFor(async () => expect(await f.service.verification({ action: 'get' })).toBeNull())
    expect((await f.service.run(run.id)).sources[0]).toMatchObject({
      state: 'completed',
      count: 2,
      batches: 1,
    })
    expect(show).not.toHaveBeenCalled()
  },
)
it('does not recheck or close the host when the official verification page closes itself', async () => {
  const { f, run } = await blockedSearch()
  await f.service.verification({ action: 'open', runId: run.id, platform: 'boss' })
  const host = BrowserWindow.getAllWindows().at(-1)!
  const officialPage = host.contentView.children[0] as WebContentsView
  officialPage.webContents.close()
  expect(host.isDestroyed()).toBe(false)
  expect(await f.service.verification({ action: 'get' })).toMatchObject({ phase: 'open' })
  beforeRead = async () => {}
  pageState.snapshot = { authenticated: true }
  host.close()
  await waitFor(async () => expect(await f.service.verification({ action: 'get' })).toBeNull())
  expect((await f.service.run(run.id)).sources[0].state).toBe('completed')
})
it.each(['challenge', 'network', 'parse', 'visible_challenge'] as const)(
  'does not treat closing a verification window as success when the recheck reports %s',
  async (failure) => {
    const { f, run } = await blockedSearch()
    await f.service.verification({ action: 'open', runId: run.id, platform: 'boss' })
    beforeRead = async () => {
      if (failure === 'challenge') throw new SourceError('challenge')
      if (failure === 'network') throw new Error('network failed')
      if (failure === 'parse') throw new SourceError('parse_error', 'response_contract_changed')
    }
    if (failure === 'visible_challenge')
      pageState.snapshot = { challenge: true, authenticated: true }
    BrowserWindow.getAllWindows().at(-1)!.close()
    await waitFor(async () => expect(await f.service.verification({ action: 'get' })).toBeNull())
    const result = (await f.service.run(run.id)).sources[0]
    expect(result.state).toBe('challenge')
    expect(result.batches).toBe(0)
    expect(result.count).toBe(0)
  },
)
it('automatically continues only the verified source within one round and keeps later searches queued', async () => {
  const { f, run } = await blockedSearch()
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
  BrowserWindow.getAllWindows().at(-1)!.close()
  await waitFor(() => expect(secondPage).toBe(true), { timeout: 5000 })
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
  await waitFor(async () => expect(await f.service.verification({ action: 'get' })).toBeNull(), {
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
  const { f, run } = await blockedSearch()
  endPage = 3
  beforeRead = async (number) => {
    if (number === 2) throw new SourceError('challenge')
  }
  await f.service.verification({ action: 'open', runId: run.id, platform: 'boss' })
  BrowserWindow.getAllWindows().at(-1)!.close()
  await waitFor(async () => expect(await f.service.verification({ action: 'get' })).toBeNull(), {
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
  const { f, run } = await blockedSearch()
  endPage = 3
  beforeRead = async () => {}
  vi.spyOn(f.service.repository, 'observe').mockImplementation(() => {
    throw new Error('disk write failed')
  })
  await f.service.verification({ action: 'open', runId: run.id, platform: 'boss' })
  BrowserWindow.getAllWindows().at(-1)!.close()
  await waitFor(async () => expect(await f.service.verification({ action: 'get' })).toBeNull())
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
  BrowserWindow.getAllWindows().at(-1)!.close()
  await waitFor(async () => expect(await f.service.verification({ action: 'get' })).toBeNull(), {
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
    const { f, run } = await blockedSearch()
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
    BrowserWindow.getAllWindows().at(-1)!.close()
    await waitFor(() => expect(secondPage).toBe(true), { timeout: 5000 })
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
  const { f, run } = await blockedSearch()
  await f.service.verification({ action: 'open', runId: run.id, platform: 'boss' })
  let reading = false
  beforeRead = async (_page, signal) =>
    new Promise<void>((_resolve, reject) => {
      reading = true
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  BrowserWindow.getAllWindows().at(-1)!.close()
  await waitFor(() => expect(reading).toBe(true))
  await f.runtime.suspend()
  expect(await f.service.verification({ action: 'get' })).toBeNull()
  expect((await f.service.run(run.id)).sources[0].state).toBe('challenge')
  expect(BrowserWindow.getAllWindows()).toHaveLength(0)
})

it('does not reuse the previous account cached batches after a confirmed QR login', async () => {
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
  await waitFor(
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
  expect(first.missing.recruitment).toBe('not_provided')
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
it('does not publish detail or account evidence from a replaced login generation', async () => {
  const f = foregroundFixture()
  vi.spyOn(bossAdapter, 'checkSession').mockResolvedValue('authenticated')
  pageState.snapshot = { login: true }
  const result = f.service.detail({ jobId: f.jobId, mode: 'refresh' })
  const rejected = expect(result).rejects.toMatchObject({ state: 'cancelled' })
  await waitFor(() =>
    expect(
      BrowserWindow.getAllWindows().some((window) =>
        window.webContents.getURL().includes('/job_detail/'),
      ),
    ).toBe(true),
  )
  const previous = f.service.repository.status().find((s) => s.platform === 'boss')!
  f.service.repository.platform({ ...previous, generation: previous.generation + 1 })
  await rejected
  expect(f.service.repository.get(f.jobId).missing.jd).toBe('detail_not_read')
  expect(f.service.repository.status().find((s) => s.platform === 'boss')).toMatchObject({
    state: 'authenticated',
    generation: 1,
  })
})

it('preserves adapter field parse failures when the rest of the detail is complete', async () => {
  const f = foregroundFixture()
  vi.spyOn(bossAdapter, 'checkSession').mockResolvedValue('authenticated')
  pageState.snapshot = {
    detail: {
      jd: '完整职责',
      detailRead: true,
      education: '',
      missing: { education: 'parse_error' },
    },
  }
  const detail = await f.service.detail({ jobId: f.jobId, mode: 'refresh' })
  expect(detail.detailRead).toBe(true)
  expect(detail.missing.education).toBe('parse_error')
  expect(detail.missing.recruitment).toBe('not_provided')
})

it('exposes a detail challenge and reloads its exact address in the visible verification view', async () => {
  const f = fixture(),
    run = await start(f)
  await settled(f, run.id)
  const job = (await f.service.list({ runId: run.id })).items[0]
  pageState.snapshot = { challenge: true }
  const detail = await f.service.detail({ jobId: job.id, runId: run.id, mode: 'refresh' })
  expect(detail.missing.jd).toBe('challenge')
  expect((await f.service.run(run.id)).sources[0]).toMatchObject({ state: 'challenge', count: 6 })
  const blocked = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === job.url)!
  expect(blocked).toBeDefined()
  await f.service.verification({ action: 'open', runId: run.id, platform: 'boss' })
  expect(blocked.isDestroyed()).toBe(true)
  const host = BrowserWindow.getAllWindows().at(-1)!
  const officialPage = host.contentView.children[0] as WebContentsView
  expect(officialPage.webContents.getURL()).toBe(job.url)
  await f.service.verification({ action: 'close' })
  expect(blocked.isDestroyed()).toBe(true)
})

it.each(['session_expired', 'challenge'] as const)(
  'exposes %s from the account check before opening a detail page',
  async (state) => {
    const f = fixture(),
      run = await start(f)
    await settled(f, run.id)
    const job = (await f.service.list({ runId: run.id })).items[0]
    const status = f.service.repository.status().find((s) => s.platform === 'boss')!
    f.service.work.run(() => f.service.repository.platform({ ...status, state }))
    await expect(
      f.service.detail({ jobId: job.id, runId: run.id, mode: 'refresh' }),
    ).rejects.toThrow()
    expect((await f.service.run(run.id)).sources[0]).toMatchObject({ state, count: 6 })
  },
)

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
}, 35000)

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
  await waitFor(() => expect(waiting).toBe(true), { timeout: 5000 })
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

it('explicitly rechecks every platform even when persisted authentication is unknown', async () => {
  const f = fixture(undefined, false)
  const checks = platforms.map((platform) =>
    vi.spyOn(platformAdapter(platform), 'checkSession').mockResolvedValue('authenticated'),
  )
  const result = await f.runtime.status(true)
  expect(result.every((status) => status.state === 'authenticated')).toBe(true)
  checks.forEach((check) => expect(check).toHaveBeenCalledOnce())
})

it.each([
  [{ authenticated: false, login: true }, 'session_expired', 'session_expired'],
  [{ authenticated: true, challenge: true }, 'challenge', 'challenge'],
  [{ authenticated: false }, 'parse_error', 'authenticated'],
] as const)(
  'checks BOSS account evidence before reading any search batches: %j',
  async (snapshot, sourceState, accountState) => {
    const f = fixture()
    pageState.accountSnapshot = snapshot
    const run = await start(f)
    const result = await settled(f, run.id)
    expect(result.sources[0]).toMatchObject({ state: sourceState, count: 0 })
    expect(read).not.toHaveBeenCalled()
    const status = f.service.repository.status().find((s) => s.platform === 'boss')!
    expect(status.state).toBe(accountState)
    if (sourceState === 'parse_error') {
      expect(status.checkedAt).toBe(1234)
      expect(status.limitations).toContain('authentication_check_inconclusive')
    }
    expect(BrowserWindow.getAllWindows()).toHaveLength(0)
  },
)

it('checks the account once for each collection and continuation, including cached results', async () => {
  const f = fixture()
  const run = await start(f)
  await settled(f, run.id)
  expect(pageState.accountReads).toBe(1)
  expect(read).toHaveBeenCalledTimes(3)
  const next = await start(f)
  await settled(f, next.id)
  expect(pageState.accountReads).toBe(2)
  expect(read).toHaveBeenCalledTimes(3)
})

it('honors adapter-owned per-batch account checks and stops before expired-session rows are read', async () => {
  const f = fixture()
  const repo = f.service.repository
  repo.platform({
    ...repo.status().find((s) => s.platform === 'shixiseng')!,
    state: 'authenticated',
  })
  const check = vi
    .spyOn(shixisengAdapter, 'checkSession')
    .mockResolvedValueOnce('authenticated')
    .mockResolvedValueOnce('authenticated')
    .mockResolvedValueOnce('login_required')
  const search = vi.spyOn(shixisengAdapter, 'createSearch').mockReturnValue({
    read: vi.fn(async () => {
      const source = batch(1)
      const url = 'https://www.shixiseng.com/intern/inn_fixture'
      return {
        ...source,
        hasMore: true,
        submitted: { keyword: 'Java', cityCode: '' },
        sourceIds: [jobIdentity('shixiseng', url).id],
        jobs: [{ ...source.jobs[0], platform: 'shixiseng' as const, url }],
        rawCount: 1,
      }
    }),
    commit: vi.fn(),
  })
  const run = await f.service.start({
    requestId: randomUUID(),
    query: { keyword: 'Java', city: '', platforms: ['shixiseng'] },
  })
  const result = await settled(f, run.id)
  expect(result.sources[0]).toMatchObject({ state: 'session_expired', count: 1, batches: 1 })
  expect(check).toHaveBeenCalledTimes(3)
  expect(search.mock.results[0].value.read).toHaveBeenCalledOnce()
})

it('filters Shixiseng foreign cities before SQLite writes and keeps searching past two filtered pages', async () => {
  const f = fixture(undefined, false)
  const repo = f.service.repository
  repo.platform({
    ...repo.status().find((s) => s.platform === 'shixiseng')!,
    state: 'authenticated',
  })
  vi.spyOn(shixisengAdapter, 'checkSession').mockResolvedValue('authenticated')
  let responses = 0
  const transport: SearchTransport = {
    load: vi.fn(async () => {}),
    fill: vi.fn(async () => {}),
    click: vi.fn(async () => {}),
    guard: vi.fn(async () => {}),
    enter: vi.fn(),
    until: vi.fn(),
    evaluate: vi.fn().mockResolvedValue(true),
    async response(reader, action, signal) {
      await action()
      signal.throwIfAborted()
      const call = responses++
      const page = Math.max(1, call)
      const query = new URLSearchParams({
        keyword: '运营',
        type: 'intern',
        city: call ? '三沙' : '全国',
        page: String(page),
      })
      expect(
        reader.request({
          url: 'https://www.shixiseng.com/app/interns/search/v2?' + query,
          method: 'GET',
          body: '',
        }),
      ).toBe(true)
      const row = (uuid: string, city: string) => ({
        uuid,
        city,
        name: '官网语义相关实习岗位',
        cname: '测试公司',
        minsal: '100',
        maxsal: '200',
        talkFace: '1',
      })
      return reader.response({
        code: 100,
        msg: {
          pageNumber: 20,
          total: 60,
          data: [
            row(`inn_foreign${page}`, '上海'),
            ...(page === 3 ? [row('inn_local', '三沙市')] : []),
          ],
        },
      })
    },
  }
  vi.spyOn(shixisengAdapter, 'createSearch').mockImplementation(
    (_page, query) => new ShixisengSearch(transport, query),
  )
  const run = await f.service.start({
    requestId: randomUUID(),
    query: { keyword: '运营', city: '三沙', platforms: ['shixiseng'] },
  })
  const result = await settled(f, run.id)
  expect(result.sources[0]).toMatchObject({
    state: 'completed',
    count: 1,
    batches: 3,
    sourcePage: 3,
  })
  expect(responses).toBe(4)
  const view = await f.service.list({ runId: run.id })
  expect(view.items.map((job) => job.city)).toEqual(['三沙市'])
  expect(repo.sourceCount(run.id, 'shixiseng')).toBe(1)
  expect(
    f.container.database.db
      .prepare('SELECT count(*) AS count FROM discovery_jobs WHERE platform = ?')
      .get('shixiseng'),
  ).toEqual({ count: 1 })
})
