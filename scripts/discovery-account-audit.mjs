import assert from 'node:assert/strict'
const equal = (actual, expected, message) =>
  assert.deepEqual(
    JSON.parse(JSON.stringify(actual)),
    JSON.parse(JSON.stringify(expected)),
    message,
  )

// Explicitly invoked live-account QA. No cookies, request headers, QR codes or
// account response bodies are captured. Only official job-list fields are kept.
export function observeJobResponses(application) {
  const batches = [],
    errors = []
  const watch = (page) => {
    page.on('response', async (response) => {
      const url = new URL(response.url())
      const targets = {
        '/wapi/zpgeek/search/joblist.json': 'boss',
        '/api/com.liepin.searchfront4c.pc-search-job': 'liepin',
        '/c/i/search/positions': 'zhilian',
        '/api/job/search-pc': 'wuyou',
        '/api/jobs/v1/recom-job': 'iguopin',
        '/app/interns/search/v2': 'shixiseng',
      }
      const platform = targets[url.pathname]
      if (!platform) return
      try {
        const request = response.request()
        let form
        try {
          form = JSON.parse(request.postData() || '{}')
        } catch {
          form = Object.fromEntries(new URLSearchParams(request.postData()))
        }
        const q =
          platform === 'liepin'
            ? form.data?.mainSearchPcConditionForm
            : platform === 'iguopin'
              ? form.search
              : ['wuyou', 'shixiseng'].includes(platform)
                ? Object.fromEntries(url.searchParams)
                : form
        const query = Object.fromEntries(
          Object.entries(q || {}).filter(([k]) =>
            /^(key|keyword|query|city|dq|district|jobArea|page|pageNum|currentPage|pageIndex|S_SOU_FULL_INDEX|S_SOU_WORK_CITY|eventScenario)$/.test(
              k,
            ),
          ),
        )
        const body = await response.json()
        const rows =
          platform === 'boss'
            ? body.zpData?.jobList
            : platform === 'liepin'
              ? body.data?.data?.jobCardList
              : platform === 'zhilian'
                ? body.data?.list
                : platform === 'wuyou'
                  ? body.resultbody?.job?.items
                  : platform === 'iguopin'
                    ? body.data?.list
                    : body.msg?.data
        if (!Array.isArray(rows)) return
        const pick = (row, keys) =>
          Object.fromEntries(keys.filter((k) => row[k] !== undefined).map((k) => [k, row[k]]))
        const keys = {
          boss: [
            'encryptJobId',
            'jobName',
            'brandName',
            'cityName',
            'areaDistrict',
            'businessDistrict',
            'salaryDesc',
            'jobExperience',
            'jobDegree',
          ],
          zhilian: [
            'positionUrl',
            'name',
            'companyName',
            'workCity',
            'salary60',
            'workingExp',
            'education',
            'jobSummary',
          ],
          wuyou: [
            'jobId',
            'jobHref',
            'jobName',
            'companyName',
            'jobAreaString',
            'provideSalaryString',
            'workYearString',
            'degreeString',
            'termStr',
            'jobDescribe',
            'isPromotion',
          ],
          iguopin: [
            'job_id',
            'job_name',
            'company_name',
            'district_list',
            'min_wage',
            'max_wage',
            'wage_unit_cn',
            'months',
            'is_negotiable',
            'experience_cn',
            'education_cn',
            'recruitment_type_cn',
            'nature_cn',
            'contents',
          ],
          shixiseng: [
            'uuid',
            'name',
            'cname',
            'city',
            'degree',
            'minsalary',
            'maxsalary',
            'talkFace',
            'ad_type',
          ],
        }
        batches.push({
          platform,
          query,
          at: Date.now(),
          rows: rows.map((row) =>
            platform === 'liepin'
              ? {
                  job: pick(row.job || {}, [
                    'link',
                    'title',
                    'dq',
                    'salary',
                    'requireWorkYears',
                    'requireEduLevel',
                  ]),
                  comp: pick(row.comp || {}, ['compName']),
                }
              : pick(row, keys[platform]),
          ),
        })
      } catch {
        errors.push({ platform, reason: 'response_body_unavailable' })
      }
    })
  }
  application.on('window', watch)
  for (const page of application.windows()) watch(page)
  return { batches, errors }
}

export async function settle(page, id, timeout = 120000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const run = await page.evaluate((id) => window.zhijiApi.discovery.run(id), id)
    if (!['queued', 'running'].includes(run.state)) return run
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('Search round did not settle')
}

function expectedFields(platform, row) {
  switch (platform) {
    case 'boss':
      return {
        title: row.jobName,
        company: row.brandName,
        city: [row.cityName, row.areaDistrict, row.businessDistrict].filter(Boolean).join('·'),
        salary: row.salaryDesc,
        experience: row.jobExperience,
        education: row.jobDegree,
      }
    case 'liepin':
      return {
        title: row.job.title,
        company: row.comp.compName,
        city: row.job.dq,
        salary: row.job.salary,
        experience: row.job.requireWorkYears,
        education: row.job.requireEduLevel,
      }
    case 'zhilian':
      return {
        title: row.name,
        company: row.companyName,
        city: row.workCity,
        salary: row.salary60,
        experience: row.workingExp,
        education: row.education,
        jd: row.jobSummary,
      }
    case 'wuyou':
      return {
        title: row.jobName,
        company: row.companyName,
        city: row.jobAreaString,
        salary: row.provideSalaryString,
        experience: row.workYearString,
        education: row.degreeString,
        employment: row.termStr,
        jd: row.jobDescribe,
      }
    case 'iguopin':
      return {
        title: row.job_name,
        company: row.company_name,
        city: [...new Set((row.district_list || []).map((l) => l.area_cn))].join('、'),
        experience: row.experience_cn,
        education: row.education_cn,
        recruitment: row.recruitment_type_cn,
        jd: row.contents,
      }
    case 'shixiseng':
      return {
        company: row.cname,
        city: row.city,
        education: row.degree,
        employment: '实习',
        salary:
          row.talkFace === 0 || row.talkFace === '0'
            ? '薪资面议'
            : `${row.minsalary === row.maxsalary ? row.minsalary : row.minsalary + '-' + row.maxsalary}/天`,
      }
  }
}

function rowIdentity(platform, row) {
  return platform === 'boss'
    ? row.encryptJobId
    : platform === 'iguopin'
      ? row.job_id
      : platform === 'shixiseng'
        ? row.uuid
        : platform === 'wuyou'
          ? row.jobId
          : platform === 'zhilian'
            ? row.positionUrl?.match(/\/([^/]+)\.htm(?:[?#]|$)/)?.[1]
            : row.job.link?.split(/[?#]/)[0]
}

export async function auditRun(application, page, id, capture, previous) {
  const run = await settle(page, id)
  for (const sourcePage of application.windows()) {
    if (!sourcePage.url().startsWith('https://www.zhaopin.com/jobs')) continue
    const initial = await sourcePage
      .evaluate(() => {
        const state = window.__INITIAL_STATE__
        if (!state || state.pageMode !== 'search' || !Array.isArray(state.positionList)) return null
        return {
          keyword: state.queryParams?.kw,
          city: state.queryParams?.jl,
          rows: state.positionList.map((row) =>
            Object.fromEntries(
              [
                'positionUrl',
                'name',
                'companyName',
                'workCity',
                'salary60',
                'workingExp',
                'education',
                'jobSummary',
              ].map((key) => [key, row[key]]),
            ),
          ),
        }
      })
      .catch(() => null)
    if (initial)
      capture.batches.push({
        platform: 'zhilian',
        query: { keyword: initial.keyword, city: initial.city },
        at: Date.now(),
        rows: initial.rows,
      })
  }
  const checks = [],
    failures = []
  const check = (label, action) => {
    try {
      action()
      checks.push(label)
    } catch (error) {
      failures.push({ check: label, error: error.message })
    }
  }
  const first = await page.evaluate(
    (id) => window.zhijiApi.discovery.list({ runId: id, pageSize: 10 }),
    id,
  )
  const traverse = async (size) => {
    const jobs = []
    for (let index = 1; index <= Math.max(1, Math.ceil(first.total / size)); index++) {
      const result = await page.evaluate((args) => window.zhijiApi.discovery.list(args), {
        runId: id,
        viewId: first.viewId,
        pageSize: size,
        page: index,
      })
      assert.equal(result.total, first.total)
      jobs.push(...result.items)
    }
    return jobs
  }
  const jobs = await traverse(10),
    ids = jobs.map((j) => j.id)
  check('unique jobs across display pages', () => assert.equal(new Set(ids).size, ids.length))
  for (const size of [20, 50]) {
    const other = await traverse(size)
    check(`same ordered observations at page size ${size}`, () => equal(other, jobs))
  }
  const stored = await application.evaluate(({ app }, id) => {
    const require = process
      .getBuiltinModule('module')
      .createRequire(app.getAppPath() + '/package.json')
    const db = new (require('better-sqlite3'))(app.getAppPath() + '/data/zhiji.db', {
      readonly: true,
    })
    try {
      return db
        .prepare(
          'SELECT r.job_id AS id,o.id AS observationId,o.payload FROM discovery_results r JOIN discovery_observations o ON o.id=r.observation_id WHERE r.run_id=?',
        )
        .all(id)
    } finally {
      db.close()
    }
  }, id)
  check('database identity set equals every displayed row', () =>
    equal(stored.map((j) => j.id).sort(), [...ids].sort()),
  )
  for (const job of jobs) {
    const db = stored.find((r) => r.id === job.id)
    check(`stored fields ${job.platform}:${job.externalId}`, () => {
      const payload = JSON.parse(db.payload)
      for (const [key, value] of Object.entries(payload)) equal(job[key], value, key)
      assert.equal(job.observationId, db.observationId)
      for (const key of [
        'title',
        'company',
        'city',
        'salary',
        'experience',
        'education',
        'recruitment',
        'employment',
        'jd',
      ]) {
        if (!job[key]) assert.ok(job.missing[key], `missing reason: ${key}`)
      }
    })
    if (run.query.city)
      check(`city ${job.platform}:${job.externalId}`, () =>
        assert.ok(
          job.city
            .split(/[、,，;；/]/)
            .some(
              (city) =>
                city.split(/[-·•]/)[0].replace(/市$/, '') === run.query.city.replace(/市$/, ''),
            ),
        ),
      )
    if (run.query.salaryMin !== undefined || run.query.salaryMax !== undefined)
      check(`salary ${job.platform}:${job.externalId}`, () => {
        assert.equal(typeof job.salaryMin, 'number')
        assert.ok(!/天|日薪|小时|面议|美元|港元/.test(job.salary))
        assert.ok((job.salaryMax ?? job.salaryMin) >= (run.query.salaryMin ?? 0))
        assert.ok(job.salaryMin <= (run.query.salaryMax ?? Infinity))
      })
  }
  if (previous) {
    const frozen = await page.evaluate((args) => window.zhijiApi.discovery.list(args), {
      runId: id,
      viewId: previous.viewId,
      pageSize: 50,
    })
    check('continuation keeps frozen prefix', () =>
      equal(frozen.items.slice(0, previous.prefix.length), previous.prefix),
    )
  }
  let compared = 0
  const uncovered = []
  for (const job of jobs) {
    const batch = [...capture.batches].reverse().find(
      (b) =>
        b.platform === job.platform &&
        b.rows.some((row) => {
          const identity = rowIdentity(job.platform, row)
          return identity === job.externalId || identity === job.url
        }),
    )
    const row = batch?.rows.find(
      (row) =>
        rowIdentity(job.platform, row) === job.externalId ||
        rowIdentity(job.platform, row) === job.url,
    )
    if (!row) {
      uncovered.push(job.id)
      continue
    }
    const expected = expectedFields(job.platform, row)
    for (const [key, value] of Object.entries(expected)) {
      if (value === undefined || value === '' || (key === 'jd' && job.detailRead)) continue
      check(`source ${job.platform}:${job.externalId}:${key}`, () =>
        assert.equal(job[key], typeof value === 'string' ? value.trim() : value),
      )
      compared++
    }
  }
  return {
    run,
    total: first.total,
    checksPassed: checks.length,
    failures,
    sourceFieldsCompared: compared,
    sourceRowsUncovered: uncovered.length,
    snapshot: { viewId: first.viewId, prefix: jobs.slice(0, 10) },
    jobs,
  }
}
