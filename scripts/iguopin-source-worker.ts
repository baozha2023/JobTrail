/** Source parser diagnostics only. Anonymous site access never enters the business runtime. */
import { app, BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { IguopinSearch, iguopinAdapter } from '../src/main/discovery/adapters/iguopin'
import { SearchPage } from '../src/main/discovery/search-page'
import { protectPlatformPage, platformPreferences } from '../src/main/discovery/platform-browser'
import { AccountSessions } from '../src/main/discovery/account-session'
import { record } from '../src/main/discovery/parsing'
const root = path.resolve('dist/qa')
fs.mkdirSync(root, { recursive: true })
app.setPath('userData', fs.mkdtempSync(path.join(root, 'iguopin-source-')))
app.on('window-all-closed', () => {})
async function main() {
  await app.whenReady()
  const accounts = new AccountSessions(app.getPath('userData'))
  const isolated = await accounts.get('iguopin')
  const results: unknown[] = []
  let exitCode = 0
  try {
    for (const city of ['', '北京', '石家庄']) {
      const view = new BrowserWindow({
        show: false,
        width: 1280,
        height: 900,
        webPreferences: platformPreferences(isolated),
      })
      protectPlatformPage(view.webContents, 'iguopin')
      view.webContents.debugger.on('message', (_event, name, value) => {
        const request = record(record(value).request)
        if (name === 'Network.requestWillBeSent' && String(request.url).includes('/api/jobs/')) {
          const data = JSON.parse(String(request.postData || '{}'))
          const search = record(data.search)
          console.log(
            JSON.stringify({
              request: new URL(String(request.url)).pathname,
              method: request.method,
              searchKeys: Object.keys(search),
              city: search.district,
              page: search.page,
            }),
          )
        }
      })
      try {
        const search = new IguopinSearch(
          new SearchPage(view.webContents, iguopinAdapter.pageScript(false)),
          { keyword: '运营', city },
        )
        for (let page = 1; page <= 3; page++) {
          const batch = await search.read(AbortSignal.timeout(60000))
          const value = {
            city,
            page: batch.page,
            jobs: batch.jobs.length,
            raw: batch.rawCount,
            hasMore: batch.hasMore,
            submittedCity: batch.submitted.cityCode,
          }
          results.push(value)
          console.log(JSON.stringify(value))
          search.commit(batch)
          if (!batch.hasMore) break
        }
      } finally {
        view.destroy()
      }
    }
    fs.writeFileSync(
      path.join(root, 'iguopin-source-results.json'),
      JSON.stringify({ at: new Date().toISOString(), results }, null, 2),
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'source_failed')
    exitCode = 1
  } finally {
    await accounts.closeConnections()
    app.exit(exitCode)
  }
}
void main().catch(() => app.exit(1))
