import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { PDFParse } from 'pdf-parse'

export async function verifyExamPdfExport(application, page, root, project) {
  const output = path.join(project, 'dist', 'exam-pdf-review')
  fs.mkdirSync(output, { recursive: true })
  const chat = await page.evaluate(() => window.zhijiApi.agent.create())
  await page.evaluate((id) => window.zhijiApi.agent.rename(id, 'PDF export acceptance'), chat.id)
  const identity = await application.evaluate(
    async ({ app }, { root, conversationId }) => {
      const { createRequire } = process.getBuiltinModule('node:module')
      const path = process.getBuiltinModule('node:path')
      const { randomUUID } = process.getBuiltinModule('node:crypto')
      const Database = createRequire(path.join(app.getAppPath(), 'package.json'))('better-sqlite3')
      const db = new Database(path.join(root, 'data/zhiji.db'))
      db.pragma('busy_timeout=5000')
      const paperId = randomUUID()
      try {
        db.transaction(() => {
          const now = Date.now()
          db.prepare(
            `INSERT INTO exam_papers(id,conversation_id,request_id,task_id,title,topic,difficulty,counts,status,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
          ).run(
            paperId,
            conversationId,
            randomUUID(),
            randomUUID(),
            '中文 Markdown 导出验收卷',
            'TypeScript 与中文排版',
            '中等',
            JSON.stringify({ single_choice: 1, true_false: 1, short_answer: 3 }),
            'interrupted',
            now,
            now,
          )
          const questions = [
            [
              {
                type: 'single_choice',
                prompt: '**SC_QUESTION** 选择唯一正确的选项。',
                options: ['第一项', '`Promise.resolve(42)`', '第三项', '第四项'],
                correct: 'B',
                explanation: 'SC_EXPLANATION 正确选项为 B。',
              },
              null,
            ],
            [
              {
                type: 'true_false',
                prompt: 'TF_QUESTION 所有异步操作都会立即完成。',
                correct: false,
                explanation: 'TF_EXPLANATION 异步操作需要等待其结果。',
              },
              null,
            ],
            [{ type: 'short_answer', prompt: 'LEGACY_QUESTION 旧题默认答案为空。' }, null],
            [
              {
                type: 'short_answer',
                prompt:
                  'NEW_QUESTION 阅读下列代码与表格。\n\n```ts\nconst promise = Promise.resolve("中文测试 - a very long code line that must wrap without clipping " + "x".repeat(80))\n```\n\n| 项目 | 内容 |\n| --- | --- |\n| 状态 | 待完成、已完成、已拒绝 |\n| 边界 | ' +
                  '宽表格内容'.repeat(25) +
                  ' |\n\n' +
                  Array.from(
                    { length: 24 },
                    (_, index) =>
                      `段落 ${index + 1}：用于验证多页中文正文、长题干和分页。${'异步结果需要通过后续回调处理。'.repeat(4)}`,
                  ).join('\n\n'),
              },
              'DEFAULT_ONLY 默认答案导出标记。\n\n```ts\nawait promise\n```',
            ],
          ]
          const insert = db.prepare(
            'INSERT INTO exam_questions(id,paper_id,request_id,position,content,default_answer) VALUES(?,?,?,?,?,?)',
          )
          questions.forEach(([content, answer], index) => {
            const id = randomUUID()
            insert.run(id, paperId, randomUUID(), index + 1, JSON.stringify(content), answer)
            if (index === 3)
              db.prepare(
                `INSERT INTO exam_answers(question_id,paper_id,value,version,submitted,result,grade_request_id,grade_status,updated_at)
            VALUES(?,?,?,1,1,?,?,'completed',?)`,
              ).run(
                id,
                paperId,
                JSON.stringify('USER_ONLY_DO_NOT_EXPORT'),
                JSON.stringify({
                  score: 88,
                  evaluation: 'EVALUATION_ONLY_DO_NOT_EXPORT',
                  referenceAnswer: 'GRADER_ONLY_DO_NOT_EXPORT',
                }),
                randomUUID(),
                now,
              )
          })
          const card = { id: `exam:${paperId}`, role: 'exam-paper', paperId, attachments: [] }
          db.prepare(
            'INSERT INTO agent_chat_events(id,conversation_id,kind,payload,created_at) VALUES(?,?,?,?,?)',
          ).run(card.id, conversationId, card.role, JSON.stringify(card), now)
        }).immediate()
        return { conversationId, paperId }
      } finally {
        db.close()
      }
    },
    { root, conversationId: chat.id },
  )
  try {
    await page.reload()
    await page.locator('.sidebar').waitFor()
    await page.getByText('智能体', { exact: true }).click()
    await page.locator('.agent-history-row').filter({ hasText: 'PDF export acceptance' }).click()
    await page.locator('.exam-card').first().click()
    const publicPaper = await page.evaluate((input) => window.zhijiApi.exams.get(input), identity)
    assert.ok(!JSON.stringify(publicPaper).includes('DEFAULT_ONLY'))
    for (const placement of ['after_each', 'at_end']) {
      const file = path.join(output, `${placement}.pdf`)
      await application.evaluate(({ dialog }, file) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: file })
      }, file)
      await page.locator('.exam-modal').getByRole('button', { name: '导出', exact: true }).click()
      const options = page.locator('.exam-export-options')
      await options.waitFor()
      assert.equal(await options.locator('input[value="after_each"]').isChecked(), true)
      if (placement === 'at_end') await options.getByText('答案在最后', { exact: true }).click()
      await options.getByRole('button', { name: '导出', exact: true }).click()
      await options.waitFor({ state: 'hidden', timeout: 130000 })
      assert.ok(fs.readFileSync(file).subarray(0, 5).equals(Buffer.from('%PDF-')))
      const parser = new PDFParse({ data: fs.readFileSync(file) })
      try {
        const result = await parser.getText({ pageJoiner: '\n' })
        const text = result.text
        assert.ok(text.includes('未完成') && text.includes('4 / 5'))
        for (const marker of [
          'SC_QUESTION',
          'TF_QUESTION',
          'LEGACY_QUESTION',
          'NEW_QUESTION',
          'SC_EXPLANATION',
          'TF_EXPLANATION',
          'DEFAULT_ONLY',
        ])
          assert.ok(text.includes(marker), marker)
        assert.ok(!/USER_ONLY|GRADER_ONLY|EVALUATION_ONLY/.test(text))
        if (placement === 'after_each')
          assert.ok(text.indexOf('SC_EXPLANATION') < text.indexOf('TF_QUESTION'))
        else {
          assert.ok(text.indexOf('SC_EXPLANATION') > text.indexOf('NEW_QUESTION'))
          assert.ok(result.pages.find((page) => page.text.includes('答案与解析')).num > 1)
        }
        assert.ok(result.total >= 3, 'long Markdown must span pages')
        const screenshots = await parser.getScreenshot({
          partial: [1, 2, result.total],
          desiredWidth: 1000,
          imageDataUrl: false,
          imageBuffer: true,
        })
        for (const screenshot of screenshots.pages)
          fs.writeFileSync(
            path.join(output, `${placement}-${screenshot.pageNumber}.png`),
            screenshot.data,
          )
      } finally {
        await parser.destroy()
      }
    }
    await application.evaluate(({ dialog }) => {
      dialog.showSaveDialog = async () => ({ canceled: true })
    })
    assert.equal(
      await page.evaluate(
        (input) => window.zhijiApi.exams.exportPdf({ ...input, answerPlacement: 'after_each' }),
        identity,
      ),
      'cancelled',
    )
    assert.deepEqual(
      await page.evaluate((input) => window.zhijiApi.exams.get(input), identity),
      publicPaper,
    )
    assert.equal(
      await application.evaluate(
        ({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().filter((window) =>
            window.webContents.getURL().includes('exam-print.html'),
          ).length,
      ),
      0,
    )
    console.log(
      `PASS: packaged PDF layouts, legacy blank, private answer isolation, cancellation and multi-page Markdown; review files: ${output}`,
    )
  } finally {
    await page.evaluate((id) => window.zhijiApi.agent.delete(id), chat.id)
  }
}
