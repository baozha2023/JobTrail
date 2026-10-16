// Explicit manual QA only: real configured model, isolated application data and
// local official-origin fixtures. Never included in routine build/release tests.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { createDecipheriv, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import QRCode from 'qrcode'
import { _electron as electron } from 'playwright'
import { skipToursForTest, waitFor } from './packaged-test-helpers.mjs'

assert.ok(
  process.argv.includes('--live-model'),
  'Use --live-model only when the user explicitly authorizes real model calls.',
)
const project = path.resolve(import.meta.dirname, '..')
const key = Buffer.from(
  JSON.parse(fs.readFileSync(path.join(project, 'private-build.config.json'), 'utf8'))
    .configEncryptionKey,
  'hex',
)
const envelope = JSON.parse(fs.readFileSync(path.join(project, 'config.json'), 'utf8'))
assert.equal(envelope.format, 'jobtrail-encrypted-config')
assert.equal(envelope.version, 1)
const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'))
decipher.setAAD(Buffer.from('jobtrail-encrypted-config:1'))
decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
const ai = JSON.parse(
  Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]).toString(),
).ai
const endpoint = new URL(ai.baseUrl.endsWith('/') ? ai.baseUrl : ai.baseUrl + '/')
const require = createRequire(import.meta.url)
const queueMode = process.argv.includes('--queue')
const gates = new Map()
const output = path.join(project, '.runtime', queueMode ? 'agent-queue-qa' : 'chat-recovery-qa')
fs.mkdirSync(output, { recursive: true })
fs.mkdirSync(path.join(project, 'dist'), { recursive: true })
const root = fs.mkdtempSync(path.join(project, 'dist', '.agent-discovery-live-'))
assert.ok(path.resolve(root).startsWith(path.join(project, 'dist') + path.sep))
function linkTree(source, target) {
  fs.mkdirSync(target, { recursive: true })
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    assert.ok(!entry.isSymbolicLink(), 'Test program inputs must not be links')
    const from = path.join(source, entry.name),
      to = path.join(target, entry.name)
    if (entry.isDirectory()) linkTree(from, to)
    else fs.linkSync(from, to)
  }
}
linkTree(path.join(project, 'out'), path.join(root, 'out'))
linkTree(path.join(project, 'resource'), path.join(root, 'resource'))
fs.copyFileSync(path.join(project, 'package.json'), path.join(root, 'package.json'))
fs.symlinkSync(path.join(project, 'node_modules'), path.join(root, 'node_modules'), 'junction')
const requests = []
const scenarios = []
const directAdmissions = []
let application
let page
let calls = 0
const server = http.createServer(async (request, response) => {
  try {
    let body = ''
    for await (const chunk of request) body += chunk
    const data = JSON.parse(body)
    assert.ok(++calls <= (queueMode ? 40 : 30), 'Live model QA call limit reached')
    const messages = data.messages
    const lastUser = messages.findLastIndex((message) => message.role === 'user')
    const inputText =
      typeof messages[lastUser]?.content === 'string'
        ? messages[lastUser].content
        : JSON.stringify(messages[lastUser]?.content)
    const queueStep = inputText.startsWith('QUEUE:')
    const tools = messages.slice(lastUser + 1).filter((message) => message.role === 'tool')
    let next = 'get_job_search'
    if (tools.length) {
      const last = tools.at(-1),
        result = JSON.parse(last.content)
      if (last.name === 'get_job_search')
        next = result.item.sources.some((source) =>
          ['challenge', 'login_required', 'session_expired'].includes(source.state),
        )
          ? null
          : 'list_discovered_jobs'
      else if (last.name === 'list_discovered_jobs') next = 'get_discovered_job'
      else next = null
    }
    if (queueStep) next = null
    // The model generates real tool call IDs and arguments. Limit the test's
    // bounded tool sequence so a QA run cannot touch unrelated user operations.
    const allowed = new Set(['get_job_search', 'list_discovered_jobs', 'get_discovered_job'])
    data.tools = data.tools.filter((tool) => allowed.has(tool.function.name))
    const detailSchema = data.tools.find((tool) => tool.function.name === 'get_discovered_job')
      .function.parameters
    detailSchema.properties.mode = { type: 'string', enum: ['ensure'] }
    detailSchema.required = [...new Set([...(detailSchema.required ?? []), 'mode', 'runId'])]
    let detailStep = ''
    if (next === 'get_discovered_job') {
      const listed = JSON.parse(
        tools.findLast((tool) => tool.name === 'list_discovered_jobs').content,
      )
      const searched = JSON.parse(tools.findLast((tool) => tool.name === 'get_job_search').content)
      detailStep = ` 本步读取列表第一项 jobId=${listed.items[0].id}，runId=${searched.item.id}，mode=ensure。`
    }
    if (next) {
      assert.equal(messages[0].role, 'system')
      data.messages = [
        {
          ...messages[0],
          content: `${messages[0].content}\n隔离验收当前步骤已提供且仅需调用 ${next} 工具，它就在本次请求的 tools 定义中。必须先调用该工具，不能依据之前轮次的工具列表声称工具不可用。使用原任务标识和工具 schema 允许的参数；取得结果后才能回答。不要用前一场景的岗位或缓存详情替代本步调用。${detailStep}`,
        },
        ...messages.slice(1),
      ]
    }
    if (next)
      assert.ok(
        data.tools.some((tool) => tool.function.name === next),
        'The next real-model tool must be available',
      )
    // The configured thinking model supports automatic tool selection only.
    data.tool_choice = next ? 'auto' : 'none'
    const streaming = data.stream
    data.stream = false
    delete data.stream_options
    data.max_tokens = Math.min(data.max_tokens ?? 4096, 4096)
    const upstream = await fetch(new URL('chat/completions', endpoint), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(ai.apiKey ? { authorization: `Bearer ${ai.apiKey}` } : {}),
      },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(90000),
    })
    if (!upstream.ok) {
      let detail = await upstream.text()
      if (ai.apiKey) detail = detail.replaceAll(ai.apiKey, '[redacted]')
      detail = detail.replaceAll(ai.baseUrl, '[endpoint]')
      throw new Error(`Configured model HTTP ${upstream.status}: ${detail.slice(0, 600)}`)
    }
    const completion = await upstream.json()
    const message = completion.choices?.[0]?.message
    assert.ok(message, 'Configured model returned no assistant message')
    requests.push({
      index: calls,
      input: inputText,
      expectedTool: next,
      tools: (message.tool_calls ?? []).map((call) => ({
        name: call.function.name,
        args: JSON.parse(call.function.arguments),
      })),
      text: message.content ?? '',
      usage: completion.usage ?? null,
    })
    console.log(
      `Live model call ${calls}: ${message.tool_calls?.map((call) => call.function.name).join(', ') || 'assistant reply'}`,
    )
    if (
      queueStep &&
      ['QUEUE:HOLD', 'QUEUE:STOP', 'QUEUE:FAIL'].some((tag) => inputText.startsWith(tag))
    ) {
      await new Promise((resolve) => {
        gates.set(inputText.split(' ')[0], resolve)
        response.once('close', resolve)
      })
      if (response.destroyed) return
      if (inputText.startsWith('QUEUE:FAIL')) {
        requests.at(-1).injectedFailure = true
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            error: { message: 'Controlled delivery failure after a real model response' },
          }),
        )
        return
      }
    }
    if (!streaming) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(completion))
    } else {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (delta, finish, usage) =>
        `data: ${JSON.stringify({ id: completion.id, object: 'chat.completion.chunk', created: completion.created, model: completion.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`
      response.write(
        chunk(
          {
            role: 'assistant',
            content: message.content ?? '',
            ...(message.tool_calls
              ? { tool_calls: message.tool_calls.map((call, index) => ({ ...call, index })) }
              : {}),
          },
          null,
        ),
      )
      response.write(chunk({}, completion.choices[0].finish_reason ?? 'stop', completion.usage))
      response.end('data: [DONE]\n\n')
    }
  } catch (error) {
    requests.push({
      index: calls,
      error: error instanceof Error ? error.message : 'QA relay failed',
    })
    response.writeHead(400, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'Controlled live model QA failed' } }))
  }
})

try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const env = {
    ...process.env,
    APPDATA: path.join(root, '.appdata'),
    LOCALAPPDATA: path.join(root, '.localappdata'),
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  application = await electron.launch({
    executablePath: require('electron'),
    args: [root, `--user-data-dir=${path.join(root, '.chromium')}`],
    env,
  })
  page = await application.firstWindow()
  page.setDefaultTimeout(30000)
  await skipToursForTest(page)
  await page.evaluate(
    ({ baseUrl, modelId, contextWindowK }) =>
      window.zhijiApi.config.update({
        ai: {
          baseUrl,
          modelId,
          apiKey: '',
          multimodal: false,
          contextWindowK,
          compactThresholdPercent: 80,
        },
      }),
    {
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      modelId: ai.modelId,
      contextWindowK: ai.contextWindowK,
    },
  )

  await application.evaluate(
    async ({ session }, { root, fixtureQr }) => {
      const fixture = {
        blocked: true,
        scanned: false,
        batchFailure: false,
        scenario: 0,
        requests: [],
      }
      globalThis.chatRecoveryFixture = fixture
      const current = session.fromPath(
        process.getBuiltinModule('path').join(root, 'browser-sessions', 'boss'),
        { cache: true },
      )
      await current.protocol.handle('https', async (request) => {
        const url = new URL(request.url)
        fixture.requests.push(url.pathname)
        const json = (value) =>
          new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
        if (url.pathname.startsWith('/wapi/zppassport/')) {
          if (url.pathname.endsWith('/captcha/randkey'))
            return json({ code: 0, zpData: { shortRandKey: 'local-qa' } })
          if (url.pathname.endsWith('/qrcode/getMpCode'))
            return json({
              code: 0,
              zpData: {
                mpCodeUrl: fixtureQr,
              },
            })
          if (url.pathname.endsWith('/qrcode/scanByMp'))
            return json({ code: 0, scaned: fixture.scanned })
          if (url.pathname.endsWith('/qrcode/loginConfirm')) {
            fixture.blocked = false
            return json({ code: 0 })
          }
          return json({ code: 0 })
        }
        if (url.pathname === '/qa/verified') {
          fixture.blocked = false
          return json({ ok: true })
        }
        if (url.pathname === '/wapi/zpgeek/search/joblist.json') {
          if (fixture.batchFailure) return json({ code: 37 })
          return json({
            code: 0,
            zpData: {
              hasMore: false,
              jobList: [
                {
                  encryptJobId: `qa${fixture.scenario}001`,
                  jobName: '合成测试开发岗',
                  brandName: '隔离测试公司',
                  cityName: '北京',
                  salaryDesc: '15-25K',
                  jobExperience: '1-3年',
                  jobDegree: '本科',
                },
                {
                  encryptJobId: `qa${fixture.scenario}002`,
                  jobName: '合成测试质量岗',
                  brandName: '隔离测试公司',
                  cityName: '北京',
                  salaryDesc: '12-20K',
                  jobExperience: '1-3年',
                  jobDegree: '本科',
                },
              ],
            },
          })
        }
        const challenge =
          '<h1>安全验证</h1><button id="verify" onclick="fetch(\'/qa/verified\').then(()=>this.textContent=\'验证已完成，请手动关窗\')">完成本地合成验证</button>'
        const search = `<a href="/web/geek/chat">消息</a><input class="ipt-search" value="合成QA"/><div class="job-search-form"><input/></div><span class="cur-city-label">北京</span><button class="btn-search" onclick="fetch('/wapi/zpgeek/search/joblist.json',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'query='+encodeURIComponent(document.querySelector('.ipt-search').value)+'&city=101010100&page=1'})">搜索</button>`
        const detail =
          '<a href="/web/geek/chat">消息</a><div class="job-name"><h1>合成测试开发岗</h1></div><span class="company-name">隔离测试公司</span><span class="salary">15-25K</span><span class="job-area">北京</span><div class="job-sec-text">合成完整JD：开发 TypeScript 桌面应用，编写自动化回归。此内容仅用于隔离验收。</div>'
        return new Response(
          '<!doctype html><html><head><meta charset="utf-8"><title>' +
            (fixture.blocked ? '安全验证' : '本地合成招聘页') +
            '</title></head><body>' +
            (fixture.blocked
              ? challenge
              : url.pathname.startsWith('/job_detail/')
                ? detail
                : search) +
            '</body></html>',
          { headers: { 'content-type': 'text/html; charset=utf-8' } },
        )
      })
    },
    { root, fixtureQr: await QRCode.toDataURL('LOCAL-VERIFICATION-QA', { width: 300, margin: 2 }) },
  )

  async function seed(state) {
    const id = randomUUID(),
      requestId = randomUUID()
    const initial = (await page.evaluate(() => window.zhijiApi.discovery.status())).find(
      (item) => item.platform === 'boss',
    )
    await application.evaluate(
      ({ app }, { root, id, requestId, state, initial }) => {
        const require = process
          .getBuiltinModule('module')
          .createRequire(app.getAppPath() + '/package.json')
        const db = new (require('better-sqlite3'))(root + '/data/zhiji.db')
        const now = Date.now()
        try {
          db.transaction(() => {
            const query = { keyword: '合成QA', city: '', platforms: ['boss'] }
            db.prepare('INSERT INTO discovery_runs VALUES(?,?,?,?,?,?)').run(
              id,
              requestId,
              JSON.stringify(query),
              'partial',
              now,
              now,
            )
            db.prepare('INSERT INTO discovery_requests VALUES(?,?)').run(requestId, id)
            db.prepare(
              'INSERT INTO discovery_sources VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
            ).run(
              id,
              'boss',
              state,
              ...Array(13).fill(0),
              null,
              JSON.stringify({ keyword: query.keyword, city: '', cityCode: '' }),
              state,
              null,
            )
            db.prepare(
              'INSERT INTO discovery_platforms VALUES(?,?) ON CONFLICT(platform) DO UPDATE SET payload=excluded.payload',
            ).run(
              'boss',
              JSON.stringify({
                ...initial,
                state: state === 'challenge' ? 'challenge' : 'session_expired',
              }),
            )
          })()
        } finally {
          db.close()
        }
        globalThis.chatRecoveryFixture.blocked = true
        globalThis.chatRecoveryFixture.scanned = false
        globalThis.chatRecoveryFixture.batchFailure = false
        globalThis.chatRecoveryFixture.scenario += 1
      },
      { root, id, requestId, state, initial },
    )
    return id
  }
  async function sendDirect(conversationId, parts, label) {
    const result = await page.evaluate(
      async ({ conversationId, parts }) => {
        const jobId = crypto.randomUUID()
        let waitingSnapshot = false
        const unsubscribe = window.zhijiApi.agent.onEvent((event) => {
          if (event.kind === 'queue' && event.conversationId === conversationId && event.queue)
            waitingSnapshot ||= [...event.queue.internal, ...event.queue.external].some(
              (item) => item.id === jobId,
            )
        })
        try {
          const receipt = await window.zhijiApi.agent.send(conversationId, parts, [], jobId)
          await window.zhijiApi.agent.history(conversationId)
          return { receipt, waitingSnapshot }
        } finally {
          unsubscribe()
        }
      },
      { conversationId, parts },
    )
    assert.equal(result.receipt.status, 'running', `${label} reserves an execution slot directly`)
    assert.equal(result.waitingSnapshot, false, `${label} never publishes a waiting snapshot`)
    await page.locator('.agent-message.user').filter({ hasText: parts[0].text }).waitFor()
    assert.equal(
      await page.locator('.agent-input-queue').count(),
      0,
      `${label} renders directly in chat`,
    )
    directAdmissions.push({
      label,
      jobId: result.receipt.jobId,
      passed: true,
      waitingSnapshot: false,
    })
  }
  async function chat(id) {
    const conversation = await page.evaluate(() => window.zhijiApi.agent.create())
    await page.locator('.sidebar').getByText('智能体', { exact: true }).click()
    await page.reload()
    await page.locator('.sidebar').getByText('智能体', { exact: true }).click()
    await page.locator('.agent-history-row').first().click()
    await sendDirect(
      conversation.id,
      [
        {
          kind: 'text',
          text: `受控测试：请读取搜索任务 ${id} 的进度。若需人工验证或登录，请提示点击卡片，并停止重复轮询。恢复后请用同一任务读取岗位列表，并以 mode=ensure 读取第一个岗位完整详情，然后列出岗位名称及JD。这是合成测试，不要读取其他数据。`,
        },
      ],
      directAdmissions.length ? 'idle-worker' : 'cold-worker',
    )
    await page.locator('.agent-discovery-card').waitFor({ timeout: 120000 })
    await waitFor(
      async () =>
        !(await page.evaluate((id) => window.zhijiApi.agent.history(id), conversation.id)).running,
      'initial real model response',
      120000,
    )
    return conversation.id
  }
  async function recovered(conversationId, runId) {
    await waitFor(
      async () => {
        const history = await page.evaluate(
          (id) => window.zhijiApi.agent.history(id),
          conversationId,
        )
        const continuation = history.messages.findLastIndex(
          (message) =>
            message.role === 'user' &&
            message.parts.some(
              (part) => part.kind === 'text' && part.text.includes('恢复轮次已结束'),
            ),
        )
        return (
          continuation >= 0 &&
          !history.running &&
          history.messages
            .slice(continuation + 1)
            .some((message) => message.role === 'assistant' && message.text.trim())
        )
      },
      'automatic real-model continuation with complete detail',
      180000,
    )
    const run = await page.evaluate((id) => window.zhijiApi.discovery.run(id), runId)
    assert.equal(run.sources[0].state, 'completed')
    assert.equal(run.sources[0].count, 2)
    const history = await page.evaluate((id) => window.zhijiApi.agent.history(id), conversationId)
    assert.ok(
      history.messages.some(
        (message) =>
          message.role === 'tool' &&
          message.name === 'get_discovered_job' &&
          message.result?.includes('合成完整JD'),
      ),
      'Real-model continuation must read complete detail through get_discovered_job',
    )
    const notifications = history.messages.filter(
      (message) =>
        message.role === 'user' &&
        message.parts.some((part) => part.kind === 'text' && part.text.includes('恢复轮次已结束')),
    )
    assert.equal(notifications.length, 1)
    assert.ok(
      history.messages
        .filter((message) => message.role === 'assistant')
        .at(-1)
        ?.text.trim(),
    )
    return history
  }

  async function waitForNativeVerification() {
    await waitFor(
      async () =>
        application.evaluate(({ BrowserWindow, WebContentsView }) =>
          BrowserWindow.getAllWindows().some(
            (win) =>
              win.isVisible() &&
              win.contentView.children.some(
                (view) =>
                  view instanceof WebContentsView &&
                  view.webContents.getURL().startsWith('https://www.zhipin.com'),
              ),
          ),
        ),
      'loaded native verification window',
    )
  }

  const websiteRun = await seed('challenge')
  const websiteChat = await chat(websiteRun)
  if (queueMode) {
    await sendDirect(
      websiteChat,
      [{ kind: 'text', text: 'QUEUE:HOLD 请仅回复“当前任务完成”。不要调用工具。' }],
      'warm-worker',
    )
    await waitFor(
      () => gates.has('QUEUE:HOLD'),
      'real model response held for queue testing',
      120000,
    )
    for (const tag of ['FIRST', 'SECOND', 'THIRD']) {
      await page
        .locator('.agent-composer [role="textbox"]')
        .fill(`QUEUE:${tag} 请仅回复“${tag}完成”，不要调用工具。`)
      await page
        .locator('.agent-actions')
        .getByRole('button', { name: '发送', exact: true })
        .click()
      await waitFor(
        async () =>
          (await page.evaluate((id) => window.zhijiApi.agent.history(id), websiteChat)).queue
            .external.length ===
          ['FIRST', 'SECOND', 'THIRD'].indexOf(tag) + 1,
        'external input admission',
      )
    }
    assert.equal(
      await page.locator('.agent-composer [role="textbox"]').getAttribute('contenteditable'),
      'true',
    )
    await page.locator('.agent-composer [role="textbox"]').fill('QUEUE:FOURTH 不应发送')
    assert.equal(
      await page
        .locator('.agent-actions')
        .getByRole('button', { name: '发送', exact: true })
        .isDisabled(),
      true,
    )
    const rejected = await page.evaluate(async (id) => {
      try {
        await window.zhijiApi.agent.send(
          id,
          [{ kind: 'text', text: 'QUEUE:OVERFLOW' }],
          [],
          crypto.randomUUID(),
        )
        return null
      } catch (error) {
        return error.code
      }
    }, websiteChat)
    assert.equal(rejected, 'AGENT_QUEUE_FULL')
    await page.screenshot({ path: path.join(output, 'queue-full-zh-light.png') })
    const queueWindow = await application.browserWindow(page)
    await queueWindow.evaluate((win) => {
      if (win.isMaximized()) win.unmaximize()
      win.setContentSize(900, 620)
    })
    await page.evaluate(() => window.zhijiApi.config.update({ locale: 'en-US', themeMode: 'dark' }))
    await page.reload()
    await page.locator('.sidebar').getByText('Agent', { exact: true }).click()
    await page.locator('.agent-history-row').first().click()
    await waitFor(
      async () => (await page.locator('.agent-input-queue-row').count()) === 3,
      'English dark queue restored',
    )
    assert.equal(
      await page
        .locator('.agent-actions')
        .getByRole('button', { name: 'Send', exact: true })
        .isDisabled(),
      true,
    )
    const bounds = await page.locator('.agent-input-queue').evaluate((node) => {
      const rect = node.getBoundingClientRect()
      return {
        left: rect.left,
        right: rect.right,
        width: window.innerWidth,
        overflow: document.documentElement.scrollWidth - window.innerWidth,
      }
    })
    assert.ok(
      bounds.left >= 0 && bounds.right <= bounds.width && bounds.overflow <= 1,
      'queue fits narrow window',
    )
    await page
      .locator('.agent-input-queue-row')
      .nth(1)
      .getByRole('button', { name: 'Edit', exact: true })
      .click()
    await page.locator('.agent-queue-editor-modal').waitFor()
    await page.screenshot({
      path: path.join(output, 'queue-edit-en-dark-narrow.png'),
      animations: 'disabled',
    })
    await page
      .locator('.agent-queue-editor-modal')
      .getByRole('button', { name: 'Cancel edit', exact: true })
      .click()
    await page.locator('.agent-queue-editor-modal').waitFor({ state: 'hidden' })
    await page.evaluate(() =>
      window.zhijiApi.config.update({ locale: 'zh-CN', themeMode: 'light' }),
    )
    await queueWindow.evaluate((win) => win.setContentSize(1280, 800))
    await page.reload()
    await page.locator('.sidebar').getByText('智能体', { exact: true }).click()
    await page.locator('.agent-history-row').first().click()
    await waitFor(
      async () => (await page.locator('.agent-input-queue-row').count()) === 3,
      'Chinese light queue restored',
    )
    const rows = page.locator('.agent-input-queue-row[data-origin="external"]')
    await rows.nth(1).getByRole('button', { name: '编辑', exact: true }).click()
    const edit = page.locator('.agent-queue-editor-modal')
    await edit.locator('[role="textbox"]').fill('QUEUE:EDITED 请仅回复“编辑完成”，不要调用工具。')
    await edit.getByRole('button', { name: '保存', exact: true }).click()
    await edit.waitFor({ state: 'hidden' })
    await rows.nth(2).getByRole('button', { name: '删除', exact: true }).click()
    await waitFor(async () => (await rows.count()) === 2, 'queued message deletion')
    await page
      .locator('.agent-composer [role="textbox"]')
      .fill('QUEUE:REPLACEMENT 请仅回复“替换完成”，不要调用工具。')
    await page.locator('.agent-actions').getByRole('button', { name: '发送', exact: true }).click()
  }
  await page.screenshot({ path: path.join(output, 'website-card.png') })
  await page.locator('.agent-discovery-card').getByRole('button', { name: '打开验证窗口' }).click()
  await waitFor(
    async () =>
      application.evaluate(({ BrowserWindow, WebContentsView }) =>
        BrowserWindow.getAllWindows().some((win) =>
          win.contentView.children.some(
            (view) =>
              view instanceof WebContentsView &&
              view.webContents.getURL().startsWith('https://www.zhipin.com'),
          ),
        ),
      ),
    'native window with official-origin fixture',
  )
  const host = await application.evaluateHandle(({ BrowserWindow, WebContentsView }) =>
    BrowserWindow.getAllWindows().find((win) =>
      win.contentView.children.some(
        (view) =>
          view instanceof WebContentsView &&
          view.webContents.getURL().startsWith('https://www.zhipin.com'),
      ),
    ),
  )
  await waitFor(
    async () => host.evaluate((win) => !!win?.isVisible()),
    'native verification window',
  )
  await waitFor(
    async () =>
      host.evaluate((win) =>
        win.contentView.children[0].webContents.executeJavaScript(
          '!!document.querySelector("#verify")',
        ),
      ),
    'rendered local verification control',
  )
  await host.evaluate(async (win) => {
    const wc = win.contentView.children[0].webContents
    await wc.executeJavaScript('document.querySelector("#verify").click()')
  })
  await waitFor(
    async () => application.evaluate(() => !globalThis.chatRecoveryFixture.blocked),
    'local verification action',
  )
  assert.equal(await host.evaluate((win) => win.isDestroyed()), false)
  assert.equal(
    (await page.evaluate(() => window.zhijiApi.discovery.verification({ action: 'get' }))).phase,
    'open',
  )
  await host.evaluate((win) => win.close())
  if (queueMode) {
    await waitFor(
      async () =>
        (await page.evaluate((id) => window.zhijiApi.agent.history(id), websiteChat)).queue.internal
          .length === 1,
      'verified notification queued before external messages',
      30000,
    )
    const before = await page.evaluate((id) => window.zhijiApi.agent.history(id), websiteChat)
    assert.equal(before.queue.external.length, 3)
    assert.equal(before.messages.filter((message) => message.role === 'user').length, 2)
    await page.reload()
    await page.locator('.sidebar').getByText('智能体', { exact: true }).click()
    await page.locator('.agent-history-row').first().click()
    await waitFor(
      async () => (await page.locator('.agent-input-queue-row').count()) === 4,
      'both queues restored after Renderer reload',
    )
    gates.get('QUEUE:HOLD')()
  }
  await recovered(websiteChat, websiteRun)
  scenarios.push({
    name: 'website-verification',
    passed: true,
    manualCloseRequired: true,
    sameRun: websiteRun,
  })

  if (queueMode) {
    const history = await page.evaluate((id) => window.zhijiApi.agent.history(id), websiteChat)
    const users = history.messages
      .filter((message) => message.role === 'user')
      .map((message) =>
        message.parts.map((part) => (part.kind === 'text' ? part.text : '')).join(''),
      )
    assert.equal(users.length, 6)
    assert.ok(users[2].includes('恢复轮次已结束'))
    assert.ok(users[3].startsWith('QUEUE:FIRST'))
    assert.ok(users[4].startsWith('QUEUE:EDITED'))
    assert.ok(users[5].startsWith('QUEUE:REPLACEMENT'))
    assert.equal(history.queue.external.length, 0)
    scenarios.push({
      name: 'dual-queue-priority-capacity-edit-delete-reload',
      passed: true,
      order: users,
      layouts: ['zh-CN light', 'en-US dark 900×620'],
    })
    for (const stage of ['STOP', 'FAIL']) {
      const receipt = await page.evaluate(
        ({ id, stage }) =>
          window.zhijiApi.agent.send(
            id,
            [{ kind: 'text', text: `QUEUE:${stage} 请仅回复“当前任务完成”，不要调用工具。` }],
            [],
            crypto.randomUUID(),
          ),
        { id: websiteChat, stage },
      )
      await waitFor(() => gates.has(`QUEUE:${stage}`), 'held model response ' + stage, 120000)
      await page.evaluate(
        ({ id, stage }) =>
          window.zhijiApi.agent.send(
            id,
            [{ kind: 'text', text: `QUEUE:AFTER-${stage} 请仅回复“后续任务完成”，不要调用工具。` }],
            [],
            crypto.randomUUID(),
          ),
        { id: websiteChat, stage },
      )
      if (stage === 'STOP')
        await page.evaluate(({ id, jobId }) => window.zhijiApi.agent.cancel(id, jobId), {
          id: websiteChat,
          jobId: receipt.jobId,
        })
      else gates.get('QUEUE:FAIL')()
      await waitFor(
        async () => {
          const state = await page.evaluate((id) => window.zhijiApi.agent.history(id), websiteChat)
          return (
            !state.running &&
            state.queue.external.length === 0 &&
            state.messages.some(
              (message) =>
                message.role === 'user' &&
                message.parts.some(
                  (part) => part.kind === 'text' && part.text.startsWith(`QUEUE:AFTER-${stage}`),
                ),
            )
          )
        },
        'next input after ' + stage,
        120000,
      )
      scenarios.push({ name: `continues-after-${stage.toLowerCase()}`, passed: true })
    }
    await page.screenshot({ path: path.join(output, 'queue-completed.png') })
  } else {
    const loginRun = await seed('session_expired')
    const loginChat = await chat(loginRun)
    await page
      .locator('.agent-discovery-card')
      .getByRole('button', { name: '扫码登录', exact: true })
      .click()
    const modal = page.locator('.agent-discovery-login')
    await modal.locator('.discovery-qr-image').waitFor()
    const mainWindow = await application.browserWindow(page)
    await mainWindow.evaluate((win) => {
      win.setContentSize(1100, 620)
      win.webContents.setZoomFactor(1.25)
    })
    await waitFor(
      async () =>
        modal.locator('.discovery-qr-image').evaluate((img) => {
          const qr = img.getBoundingClientRect(),
            panel = img.parentElement.getBoundingClientRect(),
            dialog = img.closest('.discovery-login-dialog').getBoundingClientRect(),
            footer = img
              .closest('.discovery-login-dialog')
              .querySelector('.discovery-account-footer')
              .getBoundingClientRect()
          return (
            img.complete &&
            qr.width > 0 &&
            Math.abs(qr.width - qr.height) < 1 &&
            qr.top >= panel.top &&
            qr.bottom <= panel.bottom &&
            qr.top >= 0 &&
            qr.bottom <= innerHeight &&
            qr.left >= 0 &&
            qr.right <= innerWidth &&
            dialog.top >= 0 &&
            dialog.bottom <= innerHeight &&
            dialog.left >= 0 &&
            dialog.right <= innerWidth &&
            footer.top >= dialog.top &&
            footer.bottom <= dialog.bottom
          )
        }),
      'complete dialog and QR in compact zoomed window',
    )
    await modal.getByRole('button', { name: '关闭', exact: true }).click()
    await page.waitForTimeout(1800)
    let history = await page.evaluate((id) => window.zhijiApi.agent.history(id), loginChat)
    assert.equal(history.messages.filter((message) => message.role === 'user').length, 1)
    await page
      .locator('.agent-discovery-card')
      .getByRole('button', { name: '扫码登录', exact: true })
      .click()
    await modal.locator('.discovery-qr-image').waitFor()
    await page.screenshot({ path: path.join(output, 'login-card.png') })
    await application.evaluate(() => {
      globalThis.chatRecoveryFixture.scanned = true
    })
    await modal.waitFor({ state: 'hidden', timeout: 15000 })
    await recovered(loginChat, loginRun)
    scenarios.push({
      name: 'session-expired-qr',
      passed: true,
      cancellationKeepsCard: true,
      automaticClose: true,
      sameRun: loginRun,
    })
    const requiredRun = await seed('login_required')
    const requiredChat = await chat(requiredRun)
    await page
      .locator('.agent-discovery-card')
      .getByRole('button', { name: '扫码登录', exact: true })
      .click()
    await modal.locator('.discovery-qr-image').waitFor()
    await application.evaluate(() => {
      globalThis.chatRecoveryFixture.scanned = true
    })
    await modal.waitFor({ state: 'hidden', timeout: 15000 })
    await recovered(requiredChat, requiredRun)
    scenarios.push({
      name: 'login-required-qr',
      passed: true,
      automaticClose: true,
      sameRun: requiredRun,
    })

    const failedRun = await seed('challenge')
    const failedChat = await chat(failedRun)
    await application.evaluate(() => {
      globalThis.chatRecoveryFixture.batchFailure = true
    })
    await page
      .locator('.agent-discovery-card')
      .getByRole('button', { name: '打开验证窗口' })
      .click()
    await waitFor(
      async () =>
        (await page.evaluate(() => window.zhijiApi.discovery.verification({ action: 'get' })))
          ?.phase === 'open',
      'failure-path window',
    )
    await waitForNativeVerification()
    await application.evaluate(({ BrowserWindow, WebContentsView }) => {
      globalThis.chatRecoveryFixture.blocked = false
      BrowserWindow.getAllWindows()
        .find((win) =>
          win.contentView.children.some(
            (view) =>
              view instanceof WebContentsView &&
              view.webContents.getURL().startsWith('https://www.zhipin.com'),
          ),
        )
        .close()
    })
    await waitFor(
      async () =>
        !(await page.evaluate(() => window.zhijiApi.discovery.verification({ action: 'get' }))),
      'failed recheck completion',
      30000,
    )
    assert.equal(
      (await page.evaluate((id) => window.zhijiApi.discovery.run(id), failedRun)).sources[0].state,
      'challenge',
    )
    history = await page.evaluate((id) => window.zhijiApi.agent.history(id), failedChat)
    assert.equal(history.messages.filter((message) => message.role === 'user').length, 1)
    await page.locator('.agent-discovery-card').waitFor()
    await application.evaluate(() => {
      globalThis.chatRecoveryFixture.batchFailure = false
    })
    await waitFor(
      async () =>
        page
          .locator('.agent-discovery-card button')
          .evaluate(
            (button) => !button.disabled && !button.classList.contains('n-button--loading'),
          ),
      'retry button ready after failed recheck',
    )
    await page
      .locator('.agent-discovery-card')
      .getByRole('button', { name: '打开验证窗口' })
      .click()
    await waitFor(
      async () =>
        (await page.evaluate(() => window.zhijiApi.discovery.verification({ action: 'get' })))
          ?.phase === 'open',
      'retry window',
    )
    await waitForNativeVerification()
    await application.evaluate(({ BrowserWindow, WebContentsView }) =>
      BrowserWindow.getAllWindows()
        .find((win) =>
          win.contentView.children.some(
            (view) =>
              view instanceof WebContentsView &&
              view.webContents.getURL().startsWith('https://www.zhipin.com'),
          ),
        )
        .close(),
    )
    await recovered(failedChat, failedRun)
    scenarios.push({
      name: 'failed-recheck-then-retry',
      passed: true,
      failureDoesNotNotify: true,
      sameRun: failedRun,
    })
    const resultWindow = await application.browserWindow(page)
    await resultWindow.evaluate((win) => {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    })
    await page.screenshot({ path: path.join(output, 'continued-chat.png'), animations: 'disabled' })
  }
  assert.ok(
    requests
      .filter((item) => item.tools?.length)
      .every((item) => item.tools[0].name === item.expectedTool),
  )
  assert.ok(!requests.some((item) => item.error))
  console.log(
    `Live model ${ai.modelId}: ${scenarios.length} native recovery paths passed; ${calls} real API calls.`,
  )
} catch (error) {
  if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {})
  console.error(
    `Live recovery QA failed: ${error instanceof Error ? error.message : 'unknown failure'}`,
  )
  process.exitCode = 1
} finally {
  fs.writeFileSync(
    path.join(output, 'report.json'),
    JSON.stringify({ model: ai.modelId, scenarios, directAdmissions, requests }, null, 2),
  )
  for (const release of gates.values()) release()
  if (application) await application.close()
  await new Promise((resolve) => server.close(resolve))
  assert.ok(path.resolve(root).startsWith(path.join(project, 'dist') + path.sep))
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
