import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import * as yauzl from 'yauzl'
import { _electron as electron } from 'playwright'
import { encodeTestConfig, decodeTestConfig } from './config-test-helpers.mjs'
import { linkPackagedProgram } from './packaged-test-helpers.mjs'

const project = path.resolve(import.meta.dirname, '..')
const version = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8')).version
const staging = fs.mkdtempSync(path.join(project, 'dist', '.exam-smoke-'))
const root = path.join(staging, 'JobTrail'),
  runtime = path.join(root, '.runtime', 'current')
let application, server, releaseGeneration
const generationGate = new Promise((resolve) => {
  releaseGeneration = resolve
})
function chunk(id, delta, finish_reason = null) {
  return `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta, finish_reason }] })}\n\n`
}
async function until(predicate, label) {
  const end = Date.now() + 60000
  while (Date.now() < end) {
    if (await predicate()) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`Timed out: ${label}`)
}
try {
  linkPackagedProgram(path.join(project, 'dist', 'win-unpacked'), runtime)
  fs.copyFileSync(
    path.join(project, 'native/bootstrap/target/debug/launcher.exe'),
    path.join(root, 'JobTrail.exe'),
  )
  for (const name of ['data', 'resumes', 'chat-uploads'])
    fs.cpSync(path.join(project, 'tests/fixtures/v1', name), path.join(root, name), {
      recursive: true,
    })
  server = http.createServer(async (req, res) => {
    let body = ''
    for await (const bytes of req) body += bytes.toString()
    const data = JSON.parse(body),
      messages = data.messages ?? []
    if (messages[0]?.content.includes('阅卷老师')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          id: 'grade',
          object: 'chat.completion',
          created: 1,
          model: 'mock',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  score: 88,
                  evaluation: '解释正确，还可补充拒绝状态。',
                  referenceAnswer: 'Promise 表示异步操作的最终完成或失败。',
                }),
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 24, total_tokens: 36 },
        }),
      )
      return
    }
    const results = messages.filter((m) => m.role === 'tool')
    const step = results.length
    let name, args
    if (step === 0) {
      name = 'load_study'
      args = {}
    } else if (step === 1) {
      name = 'create_exam_paper'
      args = {
        title: 'TypeScript 学习卷',
        topic: 'TypeScript',
        difficulty: '中等',
        counts: { single_choice: 0, true_false: 0, short_answer: 1 },
      }
    } else {
      const created = results
        .map((m) => {
          try {
            return JSON.parse(m.content)
          } catch {
            return null
          }
        })
        .find((r) => r?.paper?.id)
      if (!created) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.end(
          chunk('failed', { role: 'assistant', content: 'Exam smoke failed' }, 'stop') +
            'data: [DONE]\n\n',
        )
        return
      }
      const paperId = created.paper.id
      if (step === 2) {
        name = 'update_exam_paper'
        args = {
          paperId,
          topic: 'TypeScript foundations',
          difficulty: '困难',
          counts: { single_choice: 1, true_false: 1, short_answer: 1 },
        }
      } else if (step === 3) {
        name = 'append_exam_question'
        args = { paperId, question: { type: 'short_answer', prompt: '解释 Promise 的作用。' } }
      } else if (step === 4) {
        await generationGate
        name = 'append_exam_question'
        args = {
          paperId,
          question: {
            type: 'single_choice',
            prompt: '2 + 2 等于多少？',
            options: ['1', '2', '3', '4'],
            correct: 'D',
            explanation: '2 + 2 = 4。',
          },
        }
      } else if (step === 5) {
        name = 'append_exam_question'
        args = {
          paperId,
          question: {
            type: 'true_false',
            prompt: 'TypeScript 支持类型检查。',
            correct: true,
            explanation: '编译器进行静态类型检查。',
          },
        }
      } else if (step === 6) {
        name = 'complete_exam_paper'
        args = { paperId }
      }
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(
      chunk(
        `exam-${step}`,
        name
          ? {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: `exam-tool-${step}`,
                  type: 'function',
                  function: { name, arguments: JSON.stringify(args) },
                },
              ],
            }
          : { role: 'assistant', content: '试卷已完成，请点击卡片继续作答。' },
      ),
    )
    res.write(chunk(`exam-${step}`, {}, name ? 'tool_calls' : 'stop'))
    res.end('data: [DONE]\n\n')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const config = decodeTestConfig(
    fs.readFileSync(path.join(project, 'tests/fixtures/v1/config.json'), 'utf8'),
    Buffer.from('42'.repeat(32), 'hex'),
  )
  config.mcp = { enabled: true, requireWriteConfirmation: true }
  config.ai = {
    ...config.ai,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    modelId: 'mock',
    apiKey: '',
  }
  fs.writeFileSync(path.join(root, 'config.json'), encodeTestConfig(config))
  const env = { ...process.env, APPDATA: staging, LOCALAPPDATA: staging }
  delete env.ELECTRON_RUN_AS_NODE
  const launch = () =>
    electron.launch({
      executablePath: path.join(runtime, 'zhiji.exe'),
      args: [`--user-data-dir=${path.join(staging, 'chromium')}`],
      env,
    })
  application = await launch()
  let page = await application.firstWindow()
  page.setDefaultTimeout(60000)
  await page.locator('.sidebar').waitFor()
  assert.equal(await page.evaluate(() => window.velopackApi.getVersion()), version)
  fs.writeFileSync(path.join(root, '.jobtrail-root'), 'jobtrail-root-v1\n')
  fs.writeFileSync(
    path.join(runtime, 'sq.version'),
    `<package><version>${version}</version></package>`,
  )
  const conversationId = await page.evaluate(async () => {
    const c = await window.zhijiApi.agent.create()
    await window.zhijiApi.agent.send(
      c.id,
      [
        { kind: 'skill', name: 'study' },
        { kind: 'text', text: '请出三道 TypeScript 中等难度题，各题型一道。' },
      ],
      [],
      crypto.randomUUID(),
    )
    return c.id
  })
  await page.reload()
  await page.getByText('智能体', { exact: true }).click()
  await page.locator('.agent-history-row').first().click()
  await page.locator('.exam-card').first().click({ timeout: 25000 })
  await page.locator('.exam-modal textarea').click()
  const modalSize = await page.locator('.exam-modal').evaluate((el) => {
    const rect = el.getBoundingClientRect()
    return {
      width: rect.width,
      height: rect.height,
      expectedWidth: innerWidth * 0.7,
      expectedHeight: innerHeight * 0.9,
    }
  })
  assert.ok(Math.abs(modalSize.width - modalSize.expectedWidth) < 2)
  assert.ok(Math.abs(modalSize.height - modalSize.expectedHeight) < 2)
  assert.equal(await page.locator('.exam-modal .exam-status').count(), 0)
  await page.mouse.click(5, 100)
  assert.ok(
    await page.locator('.exam-modal').isVisible(),
    'clicking the mask must not close the exam',
  )
  await page.locator('.exam-modal textarea').fill('Promise 表示异步操作未来的结果。')
  const gradingConfig = decodeTestConfig(fs.readFileSync(path.join(root, 'config.json'), 'utf8'))
  fs.writeFileSync(
    path.join(root, 'config.json'),
    encodeTestConfig({
      ...gradingConfig,
      ai: { ...gradingConfig.ai, baseUrl: 'https://example.invalid/v1', apiKey: '' },
    }),
  )
  await page.getByRole('button', { name: '判题', exact: true }).click()
  const rejectedGrade = await page.evaluate(async (id) => {
    const history = await window.zhijiApi.agent.history(id)
    const card = history.messages.find((m) => m.role === 'exam-paper')
    const identity = { conversationId: id, paperId: card.paperId }
    const paper = await window.zhijiApi.exams.get(identity)
    const question = paper.questions[0]
    try {
      await window.zhijiApi.exams.grade({
        ...identity,
        questionId: question.id,
        resetVersion: paper.resetVersion,
        expectedVersion: question.answer.version,
        value: question.answer.value,
      })
      return { accepted: true }
    } catch (error) {
      return { code: error.code, name: error.name, gradeStatus: question.answer.gradeStatus }
    }
  }, conversationId)
  assert.deepEqual(rejectedGrade, {
    code: 'AI_API_KEY_EMPTY',
    name: 'IpcClientError',
    gradeStatus: 'idle',
  })
  const gradeError = page.locator('.n-message--error-type').filter({ hasText: '当前 API Key 为空' })
  await gradeError.getByText(/当前 API Key 为空/).waitFor({ timeout: 5000 })
  assert.ok(await gradeError.isVisible(), 'the grading error must use the global message system')
  assert.equal(await page.locator('.exam-modal [role="alert"], .exam-card .exam-error').count(), 0)
  const diagnosticRecords = fs
    .readdirSync(path.join(root, 'logs'))
    .filter((name) => name.endsWith('.jsonl'))
    .flatMap((name) =>
      fs
        .readFileSync(path.join(root, 'logs', name), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    )
  assert.equal(
    diagnosticRecords.filter(
      (record) =>
        record.process === 'main' &&
        record.operation === 'ipc.exams.grade' &&
        record.code === 'AI_API_KEY_EMPTY',
    ).length,
    2,
    'each of the two rejected grading requests must be logged once by Main',
  )
  assert.ok(
    !diagnosticRecords.some((record) => record.operation === 'exam.request'),
    'the renderer must not log the IPC error a second time',
  )
  fs.writeFileSync(path.join(root, 'config.json'), encodeTestConfig(gradingConfig))
  await page.getByRole('button', { name: '判题', exact: true }).click()
  await page.getByText('得分：88/100', { exact: true }).waitFor()
  assert.equal(await page.locator('.exam-modal [role="alert"]').count(), 0)
  assert.equal(
    await page.locator('.exam-question').count(),
    1,
    'grading completed while generation remained active',
  )
  releaseGeneration()
  await until(
    async () => (await page.locator('.exam-question').count()) === 3,
    'incremental questions',
  )
  const identity = await page.evaluate(async (id) => {
    const history = await window.zhijiApi.agent.history(id)
    const card = history.messages.find((m) => m.role === 'exam-paper')
    return { conversationId: id, paperId: card.paperId }
  }, conversationId)
  await until(
    async () =>
      await page.evaluate(
        async (i) => (await window.zhijiApi.exams.get(i)).status === 'completed',
        identity,
      ),
    'completed paper',
  )
  assert.equal(await page.locator('.exam-card').count(), 1)
  const changedSettings = await page.evaluate((i) => window.zhijiApi.exams.get(i), identity)
  assert.equal(changedSettings.topic, 'TypeScript foundations')
  assert.equal(changedSettings.difficulty, '困难')
  const filledSize = await page.locator('.exam-modal').boundingBox()
  assert.ok(
    Math.abs(filledSize.height - modalSize.height) < 2,
    'incremental questions must not resize the modal',
  )
  const choice = page.locator('.exam-question').nth(1)
  assert.equal(await choice.locator('.exam-result').count(), 0)
  await choice.locator('.n-radio').nth(3).click()
  await choice.getByRole('button', { name: '提交', exact: true }).click()
  await until(
    async () => (await choice.locator('.exam-result').count()) === 1,
    'objective submission',
  )
  const judgment = page.locator('.exam-question').nth(2)
  await judgment.locator('.n-radio').nth(1).click()
  await judgment.getByRole('button', { name: '提交', exact: true }).click()
  await until(
    async () => (await judgment.locator('.exam-result').count()) === 1,
    'true false submission',
  )
  await page.locator('.exam-questions').evaluate((el) => {
    el.scrollTop = 0
  })
  const containment = await page.locator('.exam-modal').evaluate((el) => {
    const rect = el.getBoundingClientRect()
    const questions = el.querySelector('.exam-questions')
    const questionRect = questions.getBoundingClientRect()
    const headerRect = el.querySelector('.n-card-header').getBoundingClientRect()
    return {
      top: rect.top,
      bottom: rect.bottom,
      viewportHeight: innerHeight,
      questionTop: questionRect.top,
      questionBottom: questionRect.bottom,
      headerTop: headerRect.top,
      scrollHeight: questions.scrollHeight,
      clientHeight: questions.clientHeight,
    }
  })
  assert.ok(
    containment.top >= 0 && containment.bottom <= containment.viewportHeight + 1,
    'the complete modal remains in the viewport',
  )
  assert.ok(containment.headerTop >= containment.top, 'the title stays visible above the scroller')
  assert.ok(
    containment.questionTop >= containment.top && containment.questionBottom <= containment.bottom,
    'questions remain inside the modal',
  )
  assert.ok(
    containment.scrollHeight > containment.clientHeight,
    'long papers scroll inside the question area',
  )

  await page.screenshot({ path: path.join(project, 'dist/exam-smoke.png') })
  await application.close()
  application = await launch()
  page = await application.firstWindow()
  await page.locator('.sidebar').waitFor()
  const restored = await page.evaluate((i) => window.zhijiApi.exams.get(i), identity)
  assert.equal(restored.questions[0].answer.result.score, 88)
  assert.equal(restored.questions[1].answer.result.correct, true)
  assert.equal(restored.questions[2].answer.result.correct, false)
  assert.equal(restored.questions[0].answer.value, 'Promise 表示异步操作未来的结果。')
  const diagnosticZip = path.join(staging, 'diagnostics.zip')
  await application.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file })
  }, diagnosticZip)
  await page.getByText('设置', { exact: true }).click()
  await page.getByRole('button', { name: '导出诊断包', exact: true }).click()
  await page.getByText('诊断包已导出。', { exact: true }).waitFor()
  const entries = await new Promise((resolve, reject) => {
    const files = {}
    yauzl.open(diagnosticZip, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(error)
      zip.on('error', reject)
      zip.on('entry', (entry) =>
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) return reject(error)
          const chunks = []
          stream.on('data', (chunk) => chunks.push(chunk))
          stream.on('error', reject)
          stream.on('end', () => {
            files[entry.fileName] = Buffer.concat(chunks).toString('utf8')
            zip.readEntry()
          })
        }),
      )
      zip.on('end', () => resolve(files))
      zip.readEntry()
    })
  })
  const manifest = JSON.parse(entries['manifest.json'])
  assert.equal(manifest.schemaVersion, 1)
  assert.equal(manifest.environment.databaseVersion, 4)
  assert.equal(manifest.health.degraded, false)
  assert.ok(
    Object.keys(entries).every((name) => name === 'manifest.json' || name.startsWith('logs/')),
  )
  const exportedEvents = Object.entries(entries)
    .filter(([name]) => name.startsWith('logs/'))
    .flatMap(([, content]) =>
      content
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    )
    .filter((event) => event.eventId)
  const keyError = exportedEvents.find((event) => event.code === 'AI_API_KEY_EMPTY')
  assert.ok(keyError?.error?.stack?.length, 'original preflight stack must be retained')
  assert.ok(exportedEvents.some((event) => event.process === 'mcp' && event.traceId))
  const gradeStart = exportedEvents.find(
    (event) => event.operation === 'exam.grade' && event.outcome === 'started',
  )
  assert.ok(
    exportedEvents.some(
      (event) => event.operation === 'exam.grade-worker' && event.traceId === gradeStart?.traceId,
    ),
    'grade worker must retain the request trace',
  )
  assert.ok(
    !JSON.stringify(entries).includes('Promise 表示异步操作未来的结果。'),
    'answers must not enter diagnostics',
  )
  const archive = path.join(staging, 'exam.jobtrail-backup')
  await application.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file })
  }, archive)
  assert.equal(await page.evaluate(() => window.zhijiApi.backup.export()), 'exported')
  await page.evaluate((id) => window.zhijiApi.agent.delete(id), conversationId)
  await application.evaluate(({ app, dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
    app.relaunch = () => {}
  }, archive)
  const closed = application.waitForEvent('close')
  assert.equal(
    await page.evaluate(async () => {
      const remove = window.zhijiApi.backup.onImportConfirmation((request) => {
        void window.zhijiApi.backup.confirmImport(request.requestId, true)
      })
      try {
        return await window.zhijiApi.backup.import()
      } finally {
        remove()
      }
    }),
    'restarting',
  )
  await closed
  application = await launch()
  page = await application.firstWindow()
  await page.locator('.sidebar').waitFor()
  const imported = await page.evaluate((i) => window.zhijiApi.exams.get(i), identity)
  assert.deepEqual(
    imported,
    restored,
    'backup restores the deleted paper, every answer and grading result',
  )
  const reset = await page.evaluate((i) => window.zhijiApi.exams.reset(i), identity)
  assert.equal(reset.questions.length, 3)
  assert.ok(reset.questions.every((q) => q.answer.value === null && q.answer.result === null))
  console.log(
    'PASS: packaged v1 startup migration, /study, MCP paper updates, fixed 70% × 90% modal with persistent mask, incremental card/modal, concurrent AI grading, objective submissions, restart persistence, current-schema backup/export/import/restart and reset',
  )
} catch (error) {
  if (application) {
    const page = await application.firstWindow()
    await page
      .screenshot({ path: path.join(project, 'dist/exam-smoke-failure.png') })
      .catch(() => {})
  }
  throw error
} finally {
  releaseGeneration?.()
  await application?.close().catch(() => {})
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()))
  assert.ok(path.resolve(staging).startsWith(path.join(project, 'dist') + path.sep))
  fs.rmSync(staging, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 })
}
