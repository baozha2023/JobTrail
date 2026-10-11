import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { chromium } from 'playwright'
import { installScreenshotData } from './screenshot-data.mjs'

// Render the current Vue app with an in-memory preload fixture. Never launch the
// desktop main process, read user data, sign into websites, or call a model.
const root = path.resolve(import.meta.dirname, '..')
const output = path.join(root, 'docs/screenshots')
const server = await createServer({
  configFile: false,
  root: path.join(root, 'src/renderer'),
  plugins: [vue()],
  server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } },
  cacheDir: path.join(root, '.cache/screenshot-vite'),
})
let browser
try {
  await server.listen()
  const origin = server.resolvedUrls.local[0]
  browser = await chromium.launch({ channel: 'msedge', headless: true, chromiumSandbox: true })
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 1,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: 'light',
    reducedMotion: 'reduce',
  })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await page.route('**/*', (route) =>
    new URL(route.request().url()).origin === new URL(origin).origin
      ? route.continue()
      : route.abort(),
  )
  await page.clock.setFixedTime(new Date('2026-10-11T10:00:00+08:00'))
  const { version } = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
  await page.addInitScript(installScreenshotData, version)
  await page.goto(origin)
  await page.locator('.sidebar').waitFor()
  await page.getByText('云帆科技（示例）', { exact: true }).first().waitFor()
  await fs.mkdir(output, { recursive: true })
  const screens = [
    ['applications', '求职记录'],
    ['calendar', '日历'],
    ['companies', '公司管理'],
    ['discovery', '岗位发现'],
    ['industries', '行业分类'],
    ['resumes', '简历版本'],
    ['assistant', '智能体'],
  ]
  for (const [id, name] of screens) {
    await page.locator('.sidebar').getByText(name, { exact: true }).click()
    await page.locator('.n-spin-body').waitFor({ state: 'hidden' })
    await page.locator('.n-data-table-loading-wrapper').waitFor({ state: 'hidden' })
    if (id === 'discovery') {
      await page.getByPlaceholder('关键词', { exact: true }).fill('前端开发')
      await page.locator('.discovery-search .n-select').click()
      await page
        .locator('.n-base-select-option')
        .filter({ hasText: /^上海$/ })
        .click()
      await page.locator('.n-base-select-menu:visible').waitFor({ state: 'hidden' })
      await page.getByRole('button', { name: '搜索岗位', exact: true }).click()
      await page.locator('.discovery-job').first().click()
      await page.getByText('岗位职责', { exact: false }).first().waitFor()
    }
    if (id === 'industries') {
      for (const trigger of await page.locator('.n-data-table-expand-trigger').all()) {
        await trigger.click()
      }
    }
    if (id === 'assistant') {
      await page.getByRole('button', { name: '前端岗位准备（示例）', exact: true }).click()
      await page.getByText('建议按这三个方向准备', { exact: false }).waitFor()
    }
    await page.evaluate(async () => {
      await document.fonts.ready
      await Promise.all([...document.images].map((image) => image.decode()))
    })
    await page.mouse.move(0, 0)
    await page.locator('.n-base-select-menu:visible').waitFor({ state: 'hidden' })
    assert.equal(await page.locator('.n-message--error').count(), 0, name)
    assert.deepEqual(errors, [], name)
    await page.screenshot({ path: path.join(output, `${id}.png`), animations: 'disabled' })
    console.log(`Captured ${id}.png (1600 × 1000)`)
  }
} finally {
  await browser?.close()
  await server.close()
}
