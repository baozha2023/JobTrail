import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { DiscoveryRepository } from '../../src/main/discovery/repository'
import { searchQuerySchema, type JobPlatform } from '../../src/shared/job-discovery'

/** Synthetic records admitted by the frozen, released v4 contract. */
export function seedDiscoveryV4(db: Database.Database) {
  const repo = new DiscoveryRepository(db)
  const urls: Record<string, string> = {
    boss: 'https://www.zhipin.com/job_detail/migration.html',
    liepin: 'https://www.liepin.com/job/1970000001.shtml',
    zhilian: 'https://jobs.zhaopin.com/CC000000000J00000000001.htm',
    wuyou: 'https://jobs.51job.com/shanghai/157000000.html',
  }
  const platforms = Object.keys(urls) as JobPlatform[]
  const run = repo.create(searchQuerySchema.parse({ keyword: '运营', platforms }), randomUUID())
  for (const platform of platforms) {
    repo.observe(
      {
        platform,
        url: urls[platform],
        title: '运营',
        company: '迁移样本公司',
        city: '上海',
        salary: '8-12K',
        education: '本科',
        experience: '经验不限',
        employment: '全职',
        recruitment: '社招',
        jd: '完整职责与要求',
        detailRead: true,
      },
      run.id,
      1234,
      'detail',
    )
    const source = repo.run(run.id).sources.find((s) => s.platform === platform)!
    repo.source(run.id, {
      ...source,
      state: 'partial',
      batches: 2,
      sourcePage: 2,
      rawCount: 1,
      validCount: 1,
      generation: 7,
      cursor: 'page:3',
      remote: { keyword: '运营', city: '', cityCode: '' },
    })
    repo.platform({
      ...repo.status().find((s) => s.platform === platform)!,
      state: 'authenticated',
      generation: 7,
      checkedAt: 1234,
      evidence: 'official_qr_login_confirmed',
      limitations: [],
    })
  }
  repo.state(run.id, 'partial')
  const view = repo.list({ runId: run.id })
  const opportunity = db.prepare('SELECT id FROM opportunities ORDER BY id LIMIT 1').get() as {
    id: number
  }
  repo.link(view.items[0], opportunity.id)
  return { run, view }
}
