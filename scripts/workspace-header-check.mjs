import assert from 'node:assert/strict'

export async function checkWorkspaceHeader(page) {
  const route = [
    ['岗位发现', ['新搜索', '账号管理', '搜索历史']],
    ['简历版本', ['导入']],
    ['求职记录', ['新增']],
    ['公司管理', ['新增']],
    ['状态管理', ['新增']],
    ['行业分类', ['新增']],
    ['岗位发现', ['新搜索', '账号管理', '搜索历史']],
    ['设置', []],
    ['日历', []],
    ['简历版本', ['导入']],
  ]
  for (const [view, buttons] of [...route, ...route]) {
    await page.locator('.sidebar').getByText(view, { exact: true }).click()
    await page.waitForFunction(
      (title) => document.querySelector('.page-header h1')?.textContent === title,
      view,
    )
    assert.deepEqual(
      (await page.locator('.page-header button').allTextContents()).map((text) => text.trim()),
      buttons,
      `Header actions after navigating to ${view}`,
    )
    const contained = await page.locator('.page-header-actions').evaluate((element) => {
      const box = element.getBoundingClientRect()
      // Fractional display scaling can round parent and child bounds differently.
      const tolerance = 0.01
      return (
        box.right <= window.innerWidth + tolerance &&
        Array.from(element.querySelectorAll('button')).every((button) => {
          const rect = button.getBoundingClientRect()
          return (
            rect.left >= box.left - tolerance &&
            rect.right <= box.right + tolerance &&
            rect.width > 0
          )
        })
      )
    })
    assert.equal(contained, true, `Header buttons must fit the viewport on ${view}`)
  }
  await page.locator('.sidebar').getByText('求职记录', { exact: true }).click()
}
