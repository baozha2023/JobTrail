import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { build } from 'vite'
import { _electron as electron } from 'playwright'
import { decodeTestConfig, encodeTestConfig, privateTestKey } from './config-test-helpers.mjs'
import { linkPackagedProgram } from './packaged-test-helpers.mjs'

// Use the original release exporters, never relabel an archive produced by the new exporter.
const releases = [
  { version: '1.0.0', commit: '3acb686', databaseVersion: 1 },
  { version: '1.1.0', commit: 'd277149', databaseVersion: 1 },
  { version: '1.2.0', commit: 'a430f37', databaseVersion: 1 },
  { version: '1.3.0', commit: '466709b', databaseVersion: 2 },
  { version: '1.4.0', commit: '4fd2727', databaseVersion: 2 },
]
const project = path.resolve(import.meta.dirname, '..')
const clientVersion = JSON.parse(
  fs.readFileSync(path.join(project, 'package.json'), 'utf8'),
).version
const work = fs.mkdtempSync(path.join(project, 'dist', '.compatibility-'))
const artifacts = path.join(project, 'dist', 'compatibility')
const evidence = []
let application
fs.mkdirSync(artifacts, { recursive: true })

async function launch(root, supervisedUpgrade = false) {
  const runtime = path.join(root, '.runtime', 'current')
  if (!fs.existsSync(runtime)) {
    linkPackagedProgram(path.join(project, 'dist', 'win-unpacked'), runtime)
    fs.copyFileSync(
      path.join(project, 'native/bootstrap/target/debug/launcher.exe'),
      path.join(root, 'JobTrail.exe'),
    )
  }
  const env = { ...process.env, APPDATA: path.dirname(root), LOCALAPPDATA: path.dirname(root) }
  delete env.ELECTRON_RUN_AS_NODE
  const freeze = path.join(root, '.runtime/state/update-freeze')
  if (supervisedUpgrade) {
    fs.mkdirSync(path.dirname(freeze), { recursive: true })
    fs.writeFileSync(freeze, '')
    env.JOBTRAIL_LAUNCH_TOKEN = randomUUID()
  }
  application = await electron.launch({
    executablePath: path.join(runtime, 'zhiji.exe'),
    args: [`--user-data-dir=${path.join(path.dirname(root), 'chromium')}`],
    env,
  })
  const page = await application.firstWindow()
  page.setDefaultTimeout(30000)
  await page.locator('.sidebar').waitFor()
  assert.equal(await page.evaluate(() => window.velopackApi.getVersion()), clientVersion)
  assert.equal(await page.locator('.n-message--error').count(), 0)
  if (supervisedUpgrade) {
    assert.ok(fs.existsSync(freeze), 'the desktop must preserve the root supervisor freeze')
    // The supervising launcher owns this file and releases it after startup health succeeds.
    fs.rmSync(freeze)
  }
  return page
}

async function verify(root, expected) {
  const actual = await application.evaluate(
    ({ app }, { root, tables }) => {
      const require = process
        .getBuiltinModule('module')
        .createRequire(app.getAppPath() + '/package.json')
      const path = require('node:path')
      const Database = require(path.join(app.getAppPath(), 'node_modules/better-sqlite3'))
      const db = new Database(path.join(root, 'data/zhiji.db'), { readonly: true })
      try {
        return JSON.parse(
          JSON.stringify({
            version: db.pragma('user_version', { simple: true }),
            rows: Object.fromEntries(
              tables.map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]),
            ),
          }),
        )
      } finally {
        db.close()
      }
    },
    { root, tables: Object.keys(expected.rows) },
  )
  assert.equal(actual.version, 3)
  assert.deepEqual(actual.rows, expected.rows)
  assert.deepEqual(
    decodeTestConfig(fs.readFileSync(path.join(root, 'config.json'), 'utf8')),
    expected.config,
  )
  for (const [relative, hash] of Object.entries(expected.files))
    assert.equal(
      createHash('sha256')
        .update(fs.readFileSync(path.join(root, relative)))
        .digest('hex'),
      hash,
    )
  const page = await application.firstWindow()
  const histories = await page.evaluate(async () => {
    const chats = await window.zhijiApi.agent.list()
    return Promise.all(chats.map((c) => window.zhijiApi.agent.history(c.id)))
  })
  assert.ok(
    histories.some((h) => h.pending?.kind === 'question'),
    'pending checkpoint survives',
  )
  assert.ok(
    histories.some((h) => h.messages.some((m) => m.attachments?.length)),
    'attachment reference survives',
  )
}

async function importAndRestart(root, archive) {
  await application.evaluate(({ app, dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
    // Let production IPC quit; Playwright starts the new process so it remains observable.
    app.relaunch = () => {}
  }, archive)
  const closed = application.waitForEvent('close')
  assert.equal(
    await (
      await application.firstWindow()
    ).evaluate(async () => {
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
  application = undefined
  await launch(root)
}

try {
  for (const release of releases) {
    const source = path.join(work, `source-${release.version}`)
    fs.mkdirSync(source)
    const gitArchive = path.join(work, `${release.version}.tar`)
    execFileSync('git', ['archive', '--format=tar', '-o', gitArchive, release.commit], {
      cwd: project,
    })
    execFileSync('tar', ['-xf', gitArchive, '-C', source])
    const historicalPackage = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'))
    assert.equal(historicalPackage.version, release.version)
    const root = path.join(work, `historical-${release.version}`, 'JobTrail')
    const baseline = path.join(project, 'tests', 'fixtures', `v${release.databaseVersion}`)
    fs.cpSync(baseline, root, { recursive: true })
    const configuration = decodeTestConfig(
      fs.readFileSync(path.join(root, 'config.json'), 'utf8'),
      Buffer.from('42'.repeat(32), 'hex'),
    )
    configuration.themeMode = 'dark'
    configuration.ai.apiKey = `synthetic-compatibility-${release.version}`
    fs.writeFileSync(path.join(root, 'config.json'), encodeTestConfig(configuration))
    const entry = path.join(source, 'compatibility-entry.ts')
    fs.writeFileSync(
      entry,
      `
import fs from 'node:fs'; import path from 'node:path'; import { createHash } from 'node:crypto';
import { ConfigService } from './src/main/config'; import { DatabaseManager } from './src/main/database';
import { exportBackup } from './src/main/backup-archive';
async function main() {
 const [root, archive, version] = process.argv.slice(2);
 const paths = {root,config:path.join(root,'config.json'),data:path.join(root,'data'),database:path.join(root,'data/zhiji.db'),resumes:path.join(root,'resumes'),chatUploads:path.join(root,'chat-uploads')};
 const config=new ConfigService(paths); const database=new DatabaseManager(paths);
 try {
  if(database.db.pragma('user_version',{simple:true})!==${release.databaseVersion} || config.get().configVersion!==1) throw new Error('Historical version mismatch');
  database.db.prepare('UPDATE companies SET name=? WHERE name=?').run('Compatibility '+version, 'V1 基线样例公司');
  const tables=['builtin_company_catalog_state', 'opportunity_status_events', 'calendar_events', 'calendar_event_reminders', 'statuses','industries','companies','company_industries','company_aliases','resume_versions','opportunities','agent_conversations','agent_chat_events','agent_model_usage','chat_attachments','checkpoints','writes'];
  if (${release.databaseVersion} === 2) tables.push('exam_papers', 'exam_questions', 'exam_answers');
  const files={}; for(const dir of ['resumes','chat-uploads']) for(const file of fs.readdirSync(path.join(root,dir))) files[dir+'/'+file]=createHash('sha256').update(fs.readFileSync(path.join(root,dir,file))).digest('hex');
  fs.writeFileSync(archive+'.expected.json',JSON.stringify({config:config.get(),rows:Object.fromEntries(tables.map(t=>[t,database.db.prepare('SELECT * FROM '+t+' ORDER BY rowid').all()])),files}));
  const work=fs.mkdtempSync(path.join(root,'export-')); const manifest=await exportBackup(paths,database,config,version,archive,work);
  fs.writeFileSync(archive+'.manifest.json',JSON.stringify(manifest));
 } finally {database.close()}
}
main().catch(()=>{console.error('Historical exporter failed');process.exitCode=1});
`,
    )
    const output = path.join(work, `bundle-${release.version}`)
    await build({
      configFile: false,
      logLevel: 'error',
      define: { __CONFIG_ENCRYPTION_KEY__: JSON.stringify(privateTestKey().toString('hex')) },
      build: {
        target: 'node22',
        outDir: output,
        lib: { entry, formats: ['cjs'], fileName: () => 'historical.cjs' },
        rollupOptions: { external: (id) => !id.startsWith('.') && !path.isAbsolute(id) },
      },
    })
    const archive = path.join(artifacts, `${release.version}.jobtrail-backup`)
    execFileSync(
      path.join(project, 'node_modules/electron/dist/electron.exe'),
      [path.join(output, 'historical.cjs'), root, archive, release.version],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 60000, stdio: 'pipe' },
    )
    const expected = JSON.parse(fs.readFileSync(archive + '.expected.json', 'utf8'))
    const manifest = JSON.parse(fs.readFileSync(archive + '.manifest.json', 'utf8'))
    assert.equal(manifest.databaseVersion, release.databaseVersion)
    assert.equal(manifest.configVersion, 1)
    const beforeMcp = fs.readFileSync(path.join(root, 'data/zhiji.db'))
    const beforeConfig = fs.readFileSync(path.join(root, 'config.json'))
    const prematureMcp = spawnSync(
      path.join(project, 'dist/win-unpacked/zhiji.exe'),
      [path.join(project, 'dist/win-unpacked/resources/app.asar/out/main/mcp-node.js')],
      {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          JOBTRAIL_MCP_ROOT: root,
          JOBTRAIL_MCP_VERSION: clientVersion,
        },
        timeout: 15000,
        windowsHide: true,
        encoding: 'utf8',
      },
    )
    assert.equal(prematureMcp.status, 78, 'MCP must refuse old data before desktop migration')
    assert.equal(prematureMcp.stdout, '')
    assert.equal(prematureMcp.stderr, '')
    assert.deepEqual(fs.readFileSync(path.join(root, 'data/zhiji.db')), beforeMcp)
    assert.deepEqual(fs.readFileSync(path.join(root, 'config.json')), beforeConfig)
    // v3 adds no data during migration; v1 also starts with empty exam tables.
    for (const table of [
      'locations',
      'company_locations',
      'exam_papers',
      'exam_questions',
      'exam_answers',
    ])
      expected.rows[table] ??= []
    if (release.version !== '1.0.0') {
      await launch(root, true)
      await verify(root, expected)
      await application.close()
      application = undefined
      await launch(root)
      await verify(root, expected)
      await application.close()
      application = undefined
      evidence.push({
        version: release.version,
        commit: release.commit,
        scenario: 'supervised-startup-upgrade-and-second-launch',
        databaseVersion: 3,
        configVersion: 1,
        result: 'PASS',
      })
    }
    const target = path.join(work, `import-${release.version}`, 'JobTrail')
    const page = await launch(target)
    await page.evaluate(() =>
      window.zhijiApi.companies.create({ name: 'Must be replaced by import' }),
    )
    await importAndRestart(target, archive)
    await verify(target, expected)
    const upgraded = path.join(artifacts, `${release.version}-via-${clientVersion}.jobtrail-backup`)
    await application.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file })
    }, upgraded)
    assert.equal(
      await (await application.firstWindow()).evaluate(() => window.zhijiApi.backup.export()),
      'exported',
    )
    await importAndRestart(target, upgraded)
    await verify(target, expected)
    await application.close()
    application = undefined
    evidence.push({
      version: release.version,
      commit: release.commit,
      scenario: 'historical-export-import-restart-reexport-reimport-restart',
      databaseVersion: 3,
      configVersion: 1,
      result: 'PASS',
    })
    console.log(
      `PASS: ${release.version} original export → ${clientVersion} import/restart → export/import/restart${release.version === '1.0.0' ? '' : '; startup upgrade twice'}`,
    )
    fs.rmSync(archive + '.expected.json')
  }
  fs.writeFileSync(
    path.join(artifacts, 'report.json'),
    JSON.stringify({ testedAt: new Date().toISOString(), clientVersion, evidence }, null, 2) + '\n',
  )
} finally {
  await application?.close().catch(() => {})
  assert.ok(path.resolve(work).startsWith(path.join(project, 'dist') + path.sep))
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 })
}
