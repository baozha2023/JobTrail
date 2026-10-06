import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { _electron as electron } from 'playwright'
import { linkPackagedProgram, withoutSystemEdge } from './packaged-test-helpers.mjs'

const project = path.resolve(import.meta.dirname, '..')
const source = path.join(project, 'dist', 'win-unpacked')
const version = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8')).version
const staging = fs.mkdtempSync(path.join(project, 'dist', '.desktop-smoke-'))
const dataRoot = path.join(staging, 'JobTrail')
const runtime = path.join(dataRoot, '.runtime', 'current')
const screenshots = path.join(project, 'dist', 'qa')
const errors = []
let application

async function launch() {
  const env = withoutSystemEdge({ ...process.env, APPDATA: staging }, staging)
  delete env.ELECTRON_RUN_AS_NODE
  application = await electron.launch({
    executablePath: path.join(runtime, 'zhiji.exe'),
    args: [`--user-data-dir=${path.join(staging, 'chromium')}`],
    env,
  })
  const page = await application.firstWindow()
  page.setDefaultTimeout(15000)
  page.on('pageerror', (error) => errors.push(error.message))
  await page.locator('.sidebar').waitFor()
  assert.equal(await page.evaluate(() => window.velopackApi.getVersion()), version)
  await page.locator('.n-spin-body').waitFor({ state: 'hidden' })
  await page.locator('.n-data-table-loading-wrapper').waitFor({ state: 'hidden' })
  assert.equal(await page.locator('.n-message--error').count(), 0, 'Startup must not show errors')
  return page
}

try {
  linkPackagedProgram(source, runtime)
  // Provide the real launcher without registering this synthetic installation.
  fs.copyFileSync(
    path.join(project, 'native', 'bootstrap', 'target', 'debug', 'launcher.exe'),
    path.join(dataRoot, 'JobTrail.exe'),
  )
  fs.mkdirSync(screenshots, { recursive: true })
  let page = await launch()
  const created = await page.evaluate(async () => {
    const api = window.zhijiApi
    const statuses = await api.statuses.list()
    const company = await api.companies.create({
      name: '正式版验收合成公司',
      locations: ['北京', '上海', '杭州'],
    })
    const opportunity = await api.opportunities.create({
      companyId: company.id,
      title: '正式版验收合成岗位',
      statusId: statuses[0].id,
    })
    const conversation = await api.agent.create()
    await api.agent.history(conversation.id)
    await api.agent.delete(conversation.id)
    return { companyId: company.id, opportunityId: opportunity.id }
  })
  await application.close()
  application = undefined
  page = await launch()
  const persisted = await page.evaluate(
    async (id) => window.zhijiApi.opportunities.get(id),
    created.opportunityId,
  )
  assert.equal(persisted.companyId, created.companyId)
  assert.equal(persisted.title, '正式版验收合成岗位')
  assert.deepEqual(
    await page.evaluate(
      async (id) => (await window.zhijiApi.companies.get(id)).locations,
      created.companyId,
    ),
    ['上海', '北京', '杭州'],
  )
  await page.getByText('正式版验收合成岗位', { exact: true }).waitFor()
  await page.screenshot({ path: path.join(screenshots, 'desktop-opportunities.png') })
  for (const name of ['日历', '公司管理', '状态管理', '行业分类', '简历版本', '智能体', '设置']) {
    await page.locator('.sidebar').getByText(name, { exact: true }).click()
    await page.locator('.n-spin-body').waitFor({ state: 'hidden' })
    await page.locator('.n-data-table-loading-wrapper').waitFor({ state: 'hidden' })
    await page.screenshot({ path: path.join(screenshots, `desktop-${name}.png`) })
    assert.equal(await page.locator('.n-message--error').count(), 0, `${name} must not show errors`)
  }
  // Exercise the actual two-level widgets with a synthetic custom division.
  await page.locator('.sidebar').getByText('行业分类', { exact: true }).click()
  assert.equal(await page.locator('.n-data-table-tbody tr').count(), 20)
  await page.locator('.n-data-table-expand-trigger').first().click()
  await page.getByText('农业', { exact: true }).waitFor()
  assert.equal(await page.locator('.n-data-table-tbody tr').count(), 25)
  await page.getByRole('columnheader', { name: '操作', exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: '新增二级行业' }).count(), 0)
  await page.locator('.page-header').getByRole('button', { name: '新增', exact: true }).click()
  const modal = page.locator('.management-modal')
  await modal.locator('.n-select').click()
  await page
    .locator('.n-base-select-menu:visible')
    .getByText('农、林、牧、渔业', { exact: true })
    .click()
  await modal.getByPlaceholder('请输入行业名称').fill('树形验收二级')
  await modal.getByRole('button', { name: '保存', exact: true }).click()
  await modal.waitFor({ state: 'hidden' })
  await page.getByText('树形验收二级', { exact: true }).waitFor()
  await page.screenshot({ path: path.join(screenshots, 'desktop-industry-tree.png') })
  await page.locator('.sidebar').getByText('公司管理', { exact: true }).click()
  await page.locator('.page-header').getByRole('button', { name: '新增', exact: true }).click()
  await modal.getByPlaceholder('请输入公司名称').fill('树形验收公司')
  await modal.locator('.n-cascader').click()
  const dropdown = page.locator('.n-cascader-menu:visible')
  // A section opens the next column without selecting the section or all children.
  const group = dropdown.locator('.n-cascader-option').filter({ hasText: '农、林、牧、渔业' })
  assert.equal(await group.locator('.n-checkbox').count(), 0)
  await group.click()
  assert.equal(await modal.locator('.n-cascader .n-tag:visible').count(), 0)
  await dropdown.getByText('树形验收二级', { exact: true }).waitFor()
  assert.equal(
    await dropdown.getByText('农、林、牧、渔业 / 树形验收二级', { exact: true }).count(),
    0,
  )
  await page.screenshot({ path: path.join(screenshots, 'desktop-company-cascader.png') })
  await dropdown.getByText('树形验收二级', { exact: true }).click()
  assert.equal(await modal.locator('.n-cascader .n-tag:visible').innerText(), '树形验收二级')
  await modal.getByPlaceholder('请输入公司名称').click()
  const locationInput = modal.locator('.company-location-select input')
  await modal.locator('.company-location-select .n-select').click()
  await locationInput.fill('北京')
  await page.locator('.n-base-select-menu:visible').getByText('北京', { exact: true }).click()
  const customLocation = '苏州·桌面验收地点'
  // Keep the pointer off the menu so Enter cannot rely on mouse hover.
  await modal.getByPlaceholder('请输入公司名称').hover()
  await locationInput.fill(customLocation)
  await page
    .locator('.n-base-select-menu:visible')
    .getByText(customLocation, { exact: true })
    .waitFor()
  await locationInput.press('Enter')
  await modal.getByPlaceholder('请输入公司名称').click()
  await page.screenshot({ path: path.join(screenshots, 'desktop-company-location-editor.png') })
  assert.equal(
    await modal.locator('.company-location-select [role="alert"]').count(),
    0,
    await modal.innerText(),
  )
  assert.equal(
    await modal.locator('.company-location-select .n-tag:visible').count(),
    2,
    await modal.innerText(),
  )
  await modal.getByRole('button', { name: '保存', exact: true }).click()
  await modal.waitFor({ state: 'hidden' })
  const treeCompany = await page.evaluate(async () =>
    (await window.zhijiApi.companies.list()).find((c) => c.name === '树形验收公司'),
  )
  assert.equal(treeCompany.industryIds.length, 1)
  assert.equal(treeCompany.industryName, '农、林、牧、渔业 / 树形验收二级')
  assert.equal(
    Object.hasOwn(treeCompany, 'locations'),
    false,
    'association lists contain summaries only',
  )
  assert.deepEqual(
    await page.evaluate(
      async (id) => (await window.zhijiApi.companies.get(id)).locations,
      treeCompany.id,
    ),
    ['北京', customLocation],
  )
  await page.locator('.company-industry-filter').click()
  assert.equal(await dropdown.locator('.n-checkbox').count(), 0)
  await dropdown.getByText('农、林、牧、渔业', { exact: true }).click()
  await page.getByText('树形验收公司', { exact: true }).waitFor()
  assert.equal(
    await page.locator('.company-industry-filter .n-base-selection-label').innerText(),
    '农、林、牧、渔业',
  )
  await dropdown.getByText('树形验收二级', { exact: true }).click()
  await page.getByText('树形验收公司', { exact: true }).waitFor()
  assert.equal(
    await page.locator('.company-industry-filter .n-base-selection-label').innerText(),
    '树形验收二级',
  )
  await page.screenshot({ path: path.join(screenshots, 'desktop-company-cascader-filter.png') })
  await page.getByRole('heading', { name: '公司管理', exact: true }).click()
  const locationFilter = page.locator('.company-location-select').first()
  await locationFilter.locator('.n-select').click()
  await locationFilter.locator('input').fill('苏州·桌面验收')
  await page
    .locator('.n-base-select-menu:visible')
    .getByText(customLocation, { exact: true })
    .click()
  await page.getByRole('heading', { name: '公司管理', exact: true }).click()
  await page.getByText('树形验收公司', { exact: true }).waitFor()
  assert.equal(await page.locator('.n-data-table-tbody tr').count(), 1)
  await page.screenshot({ path: path.join(screenshots, 'desktop-company-locations.png') })
  await locationFilter.hover()
  await locationFilter.locator('.n-base-clear').click()
  await page.evaluate(async ({ id, industryIds }) => {
    await window.zhijiApi.companies.delete(id)
    await window.zhijiApi.industries.delete(industryIds[0])
  }, treeCompany)
  // Substitute only the catalog download result; exercise the real UI refresh
  // against a newly created industry that is absent from the renderer cache.
  const catalogStatus = await page.evaluate(() => window.zhijiApi.companyCatalog.getStatus())
  const refreshedIndustry = await page.evaluate(async () => {
    const parent = (await window.zhijiApi.industries.list()).find((item) => item.parentId === null)
    return window.zhijiApi.industries.create({ name: '目录刷新验收二级', parentId: parent.id })
  })
  await application.evaluate(({ ipcMain }, status) => {
    ipcMain.removeHandler('company-catalog:update')
    ipcMain.handle('company-catalog:update', () => ({
      ok: true,
      data: { ...status, status: 'updated', added: 0, updated: 0, adopted: 0, unchanged: 0 },
    }))
  }, catalogStatus)
  await page.locator('.sidebar').getByText('设置', { exact: true }).click()
  await page.getByRole('button', { name: '更新内置公司', exact: true }).click()
  const catalogModal = page.locator('.catalog-update-modal')
  await catalogModal.getByText('更新完成', { exact: true }).waitFor()
  await catalogModal.getByRole('button', { name: '关闭', exact: true }).click()
  await catalogModal.waitFor({ state: 'hidden' })
  await page.locator('.sidebar').getByText('公司管理', { exact: true }).click()
  await page.locator('.company-industry-filter').getByText('全部行业', { exact: true }).waitFor()
  assert.equal(await page.locator('.n-message--error').count(), 0)
  await page.locator('.company-industry-filter').click()
  await dropdown.getByText('农、林、牧、渔业', { exact: true }).click()
  await dropdown.getByText('目录刷新验收二级', { exact: true }).waitFor()
  await page.getByRole('heading', { name: '公司管理', exact: true }).click()
  await page.evaluate(async (id) => window.zhijiApi.industries.delete(id), refreshedIndustry.id)
  await page.locator('.sidebar').getByText('设置', { exact: true }).click()
  const backupPath = path.join(staging, 'roundtrip.jobtrail-backup')
  const attachment = await page.evaluate(async () => {
    const conversation = await window.zhijiApi.agent.create()
    const file = await window.zhijiApi.agent.uploadBytes(
      conversation.id,
      'roundtrip.txt',
      'text/plain',
      new TextEncoder().encode('Synthetic packaged backup attachment'),
    )
    await window.zhijiApi.config.update({ companyReadValidityMonths: 7 })
    return { conversationId: conversation.id, attachmentId: file.id }
  })
  // Native dialogs are deterministic here; the real settings buttons, IPC, archive,
  // shutdown, startup restore and SQLite/filesystem remain unmocked.
  await application.evaluate(({ dialog, app }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file })
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
    app.relaunch = () => {}
  }, backupPath)
  await page.getByRole('button', { name: '导出备份', exact: true }).click()
  await page.getByText('备份已导出，请妥善保存。', { exact: true }).waitFor()
  assert.ok(fs.statSync(backupPath).size > 0)
  await page.evaluate(
    async ({ opportunityId, conversationId }) => {
      await window.zhijiApi.opportunities.update(opportunityId, { title: 'Changed after backup' })
      await window.zhijiApi.agent.delete(conversationId)
      await window.zhijiApi.config.update({ companyReadValidityMonths: 2 })
    },
    { ...created, ...attachment },
  )
  const closed = application.waitForEvent('close')
  await page.getByRole('button', { name: '导入备份', exact: true }).click()
  await page
    .locator('.backup-import-modal')
    .getByRole('button', { name: '替换并重启', exact: true })
    .click()
  await closed
  application = undefined
  page = await launch()
  const recovered = await page.evaluate(
    async ({ opportunityId, conversationId, attachmentId }) => {
      const opportunity = await window.zhijiApi.opportunities.get(opportunityId)
      const config = await window.zhijiApi.config.get()
      const conversations = await window.zhijiApi.agent.list()
      // A text attachment has no image preview, but still must resolve successfully.
      await window.zhijiApi.agent.preview(conversationId, attachmentId)
      return {
        title: opportunity.title,
        months: config.companyReadValidityMonths,
        conversationExists: conversations.some((c) => c.id === conversationId),
        locations: (await window.zhijiApi.companies.get(opportunity.companyId)).locations,
      }
    },
    { ...created, ...attachment },
  )
  assert.deepEqual(recovered, {
    title: '正式版验收合成岗位',
    months: 7,
    conversationExists: true,
    locations: ['上海', '北京', '杭州'],
  })
  await page.locator('.sidebar').getByText('设置', { exact: true }).click()
  await page.getByRole('button', { name: '导出备份', exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(screenshots, 'desktop-backup.png') })
  await page.evaluate(async ({ companyId, opportunityId }) => {
    await window.zhijiApi.opportunities.delete(opportunityId)
    await window.zhijiApi.companies.delete(companyId)
  }, created)
  assert.deepEqual(errors, [], 'Renderer must not raise unhandled errors')
  console.log(
    `Packaged desktop smoke passed for ${version}: startup, IPC, persistence, eight views, encrypted backup/import/restart and deletion`,
  )
} finally {
  if (application) await application.close()
  assert.equal(path.dirname(staging), path.join(project, 'dist'))
  fs.rmSync(staging, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
