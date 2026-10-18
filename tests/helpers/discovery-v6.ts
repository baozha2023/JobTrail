import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { seedDiscoveryV4 } from './discovery-v4'
import { DiscoveryRepository } from '../../src/main/discovery/repository'
import { searchQuerySchema, type JobPlatform } from '../../src/shared/job-discovery'

/** Traceable synthetic v6 data: frozen v2 fixture + released migrations + seven platforms.
 * No live account or scraped job content is included. The v1/v2 fixture bytes stay frozen.
 */
export function seedDiscoveryV6(db: Database.Database) {
  seedDiscoveryV4(db)
  const urls: Partial<Record<JobPlatform, string>> = {
    iguopin: 'https://www.iguopin.com/job/detail?id=123456',
    shixiseng: 'https://www.shixiseng.com/intern/inn_v6fixture',
    yupao: 'https://www.yupao.com/zhaogong/123456.html',
  }
  const repo = new DiscoveryRepository(db)
  const run = repo.create(
    searchQuerySchema.parse({ keyword: '合成岗位', platforms: Object.keys(urls) }),
    randomUUID(),
  )
  for (const platform of Object.keys(urls) as JobPlatform[]) {
    repo.observe(
      {
        platform,
        url: urls[platform]!,
        title: '合成岗位',
        company: '迁移样本公司',
        city: '北京',
        salary: '15-20K/月',
        experience: '',
        education: '本科',
        recruitment: '校招',
        employment: '',
        jd: '合成原始职责与要求',
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
      batches: 1,
      sourcePage: 1,
      rawCount: 1,
      validCount: 1,
      generation: 3,
      cursor: 'synthetic-cursor',
      remote: { keyword: '合成岗位', city: '', cityCode: '' },
    })
    repo.platform({
      ...repo.status().find((s) => s.platform === platform)!,
      state: 'authenticated',
      generation: 3,
      checkedAt: 1234,
      evidence: 'official_qr_login_confirmed',
    })
  }
  repo.state(run.id, 'partial')
  return run
}
