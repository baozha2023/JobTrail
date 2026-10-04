import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { _electron as electron } from 'playwright'
import { linkPackagedProgram } from './packaged-test-helpers.mjs'

const project = path.resolve(import.meta.dirname, '..')
const source = path.join(project, 'dist', 'win-unpacked')
const version = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8')).version
const staging = fs.mkdtempSync(path.join(project, 'dist', '.agent-smoke-'))
const runtime = path.join(staging, 'JobTrail', '.runtime', 'current')
const fixturePdf = path.join(staging, 'stress-resume.pdf')
// Cold Windows startup includes native modules, prompt tokenization and child MCP startup.
const WORKER_START_TIMEOUT = 90_000
let application
let server
let releaseInitialStreams
const initialStreamGate = new Promise((resolve) => {
  releaseInitialStreams = resolve
})

function manyPagePdf(pageCount) {
  const fontId = 3 + pageCount * 2
  const kids = Array.from({ length: pageCount }, (_, index) => `${3 + index * 2} 0 R`).join(' ')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`,
  ]
  for (let index = 0; index < pageCount; index++) {
    const contentId = 4 + index * 2
    const stream = `BT /F1 12 Tf 72 720 Td (Resume page ${index + 1}) Tj ET`
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    )
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  let content = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(content))
    content += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = Buffer.byteLength(content)
  content += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) content += `${String(offset).padStart(10, '0')} 00000 n \n`
  content += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(content)
}

function chunk(id, delta, finishReason = null) {
  return `data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created: 1,
    model: 'mock',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`
}

async function waitFor(predicate, description, timeout = 15_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out waiting for ${description}`)
}

try {
  assert.ok(fs.existsSync(path.join(source, 'zhiji.exe')), 'Run pnpm package:win first')
  fs.writeFileSync(fixturePdf, manyPagePdf(10_000))
  linkPackagedProgram(source, runtime)
  fs.copyFileSync(
    path.join(project, 'native', 'bootstrap', 'target', 'debug', 'launcher.exe'),
    path.join(staging, 'JobTrail', 'JobTrail.exe'),
  )
  let resumeId = 0
  const started = new Set()
  const mcpSucceeded = new Set()
  let parseTriggered = false
  let parseTriggeredAt = 0
  let parseCompletedAt = 0
  let parsedDocument = false
  let documentTextVerified = false
  server = http.createServer(async (request, response) => {
    let body = ''
    for await (const bytes of request) body += bytes.toString()
    const data = JSON.parse(body)
    const messages = data.messages ?? []
    const userText = messages
      .filter((message) => message.role === 'user')
      .map((message) =>
        typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
      )
      .join(' ')
    const label =
      ['A', 'B', 'C', 'D', 'E', 'F', 'G'].find((name) => userText.includes(`stress-${name}`)) ??
      'unknown'
    const hasToolResult = messages.some((message) => message.role === 'tool')
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    if (!hasToolResult) {
      if (label === 'A') {
        parseTriggered = true
        parseTriggeredAt = performance.now()
      }
      const toolName = label === 'A' ? 'read_resume' : 'list_statuses'
      response.write(
        chunk('read-resume', {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: `tool-stress-${label}`,
              type: 'function',
              function: {
                name: toolName,
                arguments: label === 'A' ? JSON.stringify({ resumeId }) : '{}',
              },
            },
          ],
        }),
      )
      response.write(chunk('read-resume', {}, 'tool_calls'))
      response.end('data: [DONE]\n\n')
      return
    }
    if (label === 'A' && hasToolResult) {
      parsedDocument = true
      parseCompletedAt = performance.now()
      const documentText = messages
        .filter((message) => message.role === 'tool')
        .map((message) => message.content)
        .join(' ')
      documentTextVerified =
        documentText.includes('Resume page 1') && documentText.includes('Resume page 10000')
    }
    if (label !== 'A' && hasToolResult) {
      const toolResults = messages
        .filter((message) => message.role === 'tool')
        .map((message) => {
          try {
            return JSON.parse(message.content)
          } catch {
            return null
          }
        })
      if (toolResults.some((result) => Array.isArray(result?.items))) mcpSucceeded.add(label)
    }
    started.add(label)
    const count = ['A', 'B', 'C'].includes(label) ? 80 : 28
    for (let index = 0; index < count; index++) {
      if (response.destroyed) return
      response.write(chunk(`slow-${label}`, { role: 'assistant', content: `${label}${index} ` }))
      // Keep the initial workers active until queue and reload assertions finish.
      if (index === 0 && ['A', 'B', 'C'].includes(label)) await initialStreamGate
      await new Promise((resolve) => setTimeout(resolve, 130))
    }
    if (response.destroyed) return
    response.write(chunk(`slow-${label}`, {}, 'stop'))
    response.end('data: [DONE]\n\n')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const env = { ...process.env, APPDATA: staging, LOCALAPPDATA: staging }
  delete env.ELECTRON_RUN_AS_NODE
  application = await electron.launch({
    executablePath: path.join(runtime, 'zhiji.exe'),
    args: [`--user-data-dir=${path.join(staging, 'chromium')}`],
    env,
  })
  let appDiagnostics = ''
  let appDiagnosticsHead = ''
  application.process().stderr?.on('data', (chunk) => {
    appDiagnostics = `${appDiagnostics}${chunk}`.slice(-8000)
    appDiagnosticsHead = `${appDiagnosticsHead}${chunk}`.slice(0, 4000)
  })
  let page = await application.firstWindow()
  page.setDefaultTimeout(15_000)
  await page.locator('.sidebar').waitFor()
  assert.equal(await page.evaluate(() => window.velopackApi.getVersion()), version)
  await application.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, fixturePdf)
  resumeId = await page.evaluate(async (baseUrl) => {
    const api = window.zhijiApi
    const config = await api.config.get()
    await api.config.update({
      ai: { ...config.ai, baseUrl, modelId: 'mock', apiKey: '', multimodal: false },
      mcp: { ...config.mcp, enabled: true },
    })
    return (await api.resumes.import()).id
  }, `http://127.0.0.1:${address.port}/v1`)
  const conversationIds = await page.evaluate(async () => {
    const ids = []
    for (let index = 0; index < 4; index++) ids.push((await window.zhijiApi.agent.create()).id)
    return ids
  })
  fs.writeFileSync(path.join(staging, 'JobTrail', '.jobtrail-root'), 'jobtrail-root-v1\n')
  fs.writeFileSync(
    path.join(runtime, 'sq.version'),
    `<package><version>${version}</version></package>`,
  )
  await page.reload()
  await page.locator('.sidebar').getByText('智能体', { exact: true }).click()
  await page.locator('.agent-history-row').first().waitFor()
  await page.evaluate(() => {
    window.__agentSmokeEvents = []
    window.zhijiApi.agent.onEvent((event) => window.__agentSmokeEvents.push(event))
  })

  const sendChat = (index) =>
    page.evaluate(
      ({ id, label }) =>
        window.zhijiApi.agent.send(
          id,
          [{ kind: 'text', text: `stress-${label}` }],
          [],
          crypto.randomUUID(),
        ),
      { id: conversationIds[index], label: 'ABCD'[index] },
    )
  const [receiptB, receiptC] = await Promise.all([sendChat(1), sendChat(2)])
  const receipts = [undefined, receiptB, receiptC]
  try {
    await waitFor(
      () => started.has('B') && started.has('C'),
      'two concurrent initial model requests',
      WORKER_START_TIMEOUT,
    )
  } catch (error) {
    console.error('Started model streams:', [...started])
    console.error('Receipts:', [receiptB, receiptC])
    console.error('Jobs:', await page.evaluate(() => window.zhijiApi.agent.list()))
    console.error('Events:', await page.evaluate(() => window.__agentSmokeEvents))
    console.error('App diagnostics:', appDiagnostics.slice(-1800))
    throw error
  }
  receipts[0] = await sendChat(0)
  receipts[3] = await sendChat(3)
  assert.equal(receipts.length, 4)
  try {
    await waitFor(async () => {
      const jobs = await page.evaluate(() => window.zhijiApi.agent.list())
      return (
        jobs.filter((job) => job.activity === 'running').length === 3 &&
        jobs.filter((job) => job.activity === 'queued').length === 1
      )
    }, 'three running jobs and one queued job')
  } catch (error) {
    console.error('App diagnostics head:', appDiagnosticsHead)
    console.error('App diagnostics tail:', appDiagnostics.slice(-1800))
    console.error('Receipts:', receipts)
    console.error('Jobs:', await page.evaluate(() => window.zhijiApi.agent.list()))
    console.error('Events:', await page.evaluate(() => window.__agentSmokeEvents))
    throw error
  }
  await waitFor(() => parseTriggered, 'document parsing to start')
  assert.equal(started.has('D'), false)

  const switchStarted = performance.now()
  const responseTimes = []
  for (let index = 0; index < 20; index++) {
    const name = index % 2 ? '智能体' : '求职记录'
    const start = performance.now()
    await page.locator('.sidebar').getByText(name, { exact: true }).click()
    if (name === '智能体') await page.locator('.agent-history-row').first().waitFor()
    else await page.locator('.page-header').waitFor()
    responseTimes.push(performance.now() - start)
  }
  responseTimes.sort((a, b) => a - b)
  if (parseCompletedAt && parseCompletedAt < switchStarted)
    console.error('PDF worker diagnostics:', appDiagnostics.slice(-3000))
  assert.ok(
    !parseCompletedAt || parseCompletedAt >= switchStarted,
    `PDF parsing ended before the page stress run (trigger ${parseTriggeredAt.toFixed(0)}, complete ${parseCompletedAt.toFixed(0)}, switch ${switchStarted.toFixed(0)})`,
  )
  const p95 = responseTimes[Math.ceil(responseTimes.length * 0.95) - 1]
  assert.ok(p95 < 500, `Page switching p95 was ${p95.toFixed(1)} ms`)
  const slowestPageSwitch = Math.max(...responseTimes)
  assert.ok(
    slowestPageSwitch < 1000,
    `A page switch took ${slowestPageSwitch.toFixed(1)} ms under PDF parsing load`,
  )

  await page.locator('.agent-history-row .agent-queue-label').getByText('排队中').waitFor()
  await page.evaluate((id) => window.zhijiApi.agent.cancel(id), conversationIds[1])
  await waitFor(async () => {
    const jobs = await page.evaluate(() => window.zhijiApi.agent.list())
    return jobs.find((job) => job.id === conversationIds[3])?.activity === 'running'
  }, 'queued job to start after cancellation')
  const running = await page.evaluate(() => window.zhijiApi.agent.list())
  assert.equal(running.find((job) => job.id === conversationIds[0]).activity, 'running')
  assert.equal(running.find((job) => job.id === conversationIds[2]).activity, 'running')

  await waitFor(() => started.has('A'), 'PDF parse to complete and A stream to start', 30_000)
  await page.reload()
  await page.locator('.sidebar').getByText('智能体', { exact: true }).click()
  const restored = await page.evaluate(
    (id) => window.zhijiApi.agent.history(id),
    conversationIds[0],
  )
  assert.equal(restored.job?.status, 'running')
  assert.ok(
    restored.job?.liveText || restored.messages.length,
    'Running output survived renderer reload',
  )
  for (const label of ['A', 'B', 'C', 'A']) {
    await page
      .locator('.agent-history-row')
      .filter({ hasText: `stress-${label}` })
      .click()
    await waitFor(
      async () =>
        (await page.locator('.agent-message.assistant').allTextContents()).some((text) =>
          text.includes(`${label}0`),
        ),
      `${label} streamed output in the selected chat`,
    )
  }

  releaseInitialStreams()
  await waitFor(
    async () => {
      const jobs = await page.evaluate(() => window.zhijiApi.agent.list())
      return jobs.every((job) => job.activity === 'idle')
    },
    'all background jobs to finish',
    30_000,
  )
  assert.equal(parsedDocument, true, 'The worker parsed the PDF and resumed the model call')
  assert.equal(documentTextVerified, true, 'PDF text extraction did not read every page')
  assert.ok(
    mcpSucceeded.has('B') && mcpSucceeded.has('C'),
    'Concurrent MCP tools did not both complete',
  )
  const backupChats = await page.evaluate(async () => {
    const ids = []
    for (const label of ['E', 'F']) {
      const id = (await window.zhijiApi.agent.create()).id
      ids.push(id)
      await window.zhijiApi.agent.send(
        id,
        [{ kind: 'text', text: `stress-${label}` }],
        [],
        crypto.randomUUID(),
      )
    }
    return ids
  })
  await waitFor(
    () => started.has('E') && started.has('F'),
    'background jobs before backup',
    WORKER_START_TIMEOUT,
  )
  const backupFile = path.join(staging, 'agent-stress.jobtrail-backup')
  await application.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file })
  }, backupFile)
  assert.equal(await page.evaluate(() => window.zhijiApi.backup.export()), 'exported')
  assert.ok(fs.statSync(backupFile).size > 0)
  const afterBackup = await page.evaluate(() => window.zhijiApi.agent.list())
  assert.ok(
    backupChats.every((id) => afterBackup.find((job) => job.id === id)?.activity === 'idle'),
  )
  await page.evaluate(async () => {
    const id = (await window.zhijiApi.agent.create()).id
    await window.zhijiApi.agent.send(
      id,
      [{ kind: 'text', text: 'stress-G' }],
      [],
      crypto.randomUUID(),
    )
  })
  await waitFor(
    () => started.has('G'),
    'background job before application exit',
    WORKER_START_TIMEOUT,
  )
  const exitStarted = performance.now()
  await application.close()
  application = undefined
  assert.ok(performance.now() - exitStarted < 15_000, 'Application exit did not drain the agent')
  console.log(
    `Packaged agent passed: 3 workers, FIFO queue, concurrent MCP, PDF parse, reload, backup pause, exit, page p95 ${p95.toFixed(1)} ms`,
  )
} catch (error) {
  const logs = path.join(staging, 'JobTrail', 'logs')
  if (fs.existsSync(logs))
    for (const name of fs.readdirSync(logs))
      if (name.endsWith('.jsonl'))
        console.error(name, fs.readFileSync(path.join(logs, name), 'utf8').slice(-4000))
  throw error
} finally {
  releaseInitialStreams()
  if (application) await application.close()
  if (server) await new Promise((resolve) => server.close(resolve))
  fs.rmSync(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
