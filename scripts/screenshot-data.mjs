// Fictional, deterministic presentation data for the real renderer. These are
// not live search results, authenticated accounts, or actual model responses.
export function installScreenshotData(version) {
  const noop = async () => undefined
  const subscribe = () => () => {}
  const now = Date.now()
  const stamp = { createdAt: now, updatedAt: now }
  const platforms = ['boss', 'liepin', 'zhilian', 'wuyou', 'iguopin', 'shixiseng']
  const statuses = ['感兴趣', '待投递', '已投递', '初筛', '笔试', '一面', 'Offer'].map(
    (label, i) => ({
      ...stamp,
      id: i + 1,
      label,
      sortOrder: i,
      isBuiltin: true,
    }),
  )
  const industries = [
    [1, null, '信息传输、软件和信息技术服务业'],
    [2, 1, '软件和信息技术服务业'],
    [3, 1, '互联网和相关服务'],
    [4, null, '制造业'],
    [5, 4, '计算机、通信和其他电子设备制造业'],
    [6, null, '科学研究和技术服务业'],
    [7, 6, '研究和试验发展'],
  ].map(([id, parentId, name], sortOrder) => ({
    ...stamp,
    id,
    parentId,
    name,
    sortOrder,
    isBuiltin: true,
  }))
  const companies = ['云帆科技', '知行网络', '远山智能', '青禾软件', '星河科技', '启明数字'].map(
    (name, i) => ({
      ...stamp,
      id: i + 1,
      name: `${name}（示例）`,
      aliases: [],
      industryIds: [i === 2 ? 5 : 2],
      industryName: i === 2 ? '计算机、通信和其他电子设备制造业' : '软件和信息技术服务业',
      locations: [['上海', '杭州'], ['北京', '上海'], ['深圳'], ['上海'], ['杭州'], ['北京']][i],
      careerUrl: `https://example.com/careers/${i + 1}`,
      isBuiltin: false,
      isFavorite: i < 3,
      lastReadAt: i < 2 ? now : null,
    }),
  )
  const resumes = ['前端开发 · v3', '全栈开发 · v2', '桌面客户端 · v1'].map((name, i) => ({
    ...stamp,
    id: i + 1,
    name,
    relativePath: `sample-${i}.pdf`,
    sizeBytes: 128000 + i * 24000,
    sha256: null,
    note: [
      '突出 Vue、TypeScript 与性能优化项目',
      '补充 Node.js 与数据库实践',
      '整理 Electron 桌面项目经历',
    ][i],
    sortOrder: i,
  }))
  const opportunities = companies.slice(0, 5).map((company, i) => ({
    ...stamp,
    id: i + 1,
    companyId: company.id,
    companyName: company.name,
    title: [
      '前端开发工程师',
      'Web 开发工程师',
      '桌面客户端工程师',
      '全栈开发工程师',
      '前端开发实习生',
    ][i],
    department: '产品研发部',
    location: company.locations[0],
    source: '示例数据',
    jobUrl: null,
    description: '用于界面展示的虚构岗位。',
    statusId: [6, 5, 3, 2, 1][i],
    statusLabel: statuses[[5, 4, 2, 1, 0][i]].label,
    resumeVersionId: 1,
    resumeVersionName: resumes[0].name,
    discoveredAt: now - 86400000 * (7 + i),
    appliedAt: i < 3 ? now - 86400000 * (3 + i) : null,
    deadlineAt: null,
    notes: null,
  }))
  const events = [
    [11, '简历复盘', '准备', 0],
    [13, '前端技术面试', '面试', 0],
    [15, '在线笔试', '笔试', 1],
    [19, '项目经历沟通', '面试', 2],
    [23, '投递截止', '截止日期', 3],
  ].map(([day, title, eventType, index], i) => ({
    ...stamp,
    id: i + 1,
    title,
    eventType,
    opportunityId: opportunities[index].id,
    opportunityTitle: opportunities[index].title,
    opportunityJobUrl: null,
    companyName: companies[index].name,
    startAt: new Date(2026, 9, day, 14).getTime(),
    endAt: new Date(2026, 9, day, 15).getTime(),
    isAllDay: false,
    timezone: 'Asia/Shanghai',
    location: '线上',
    description: '示例日程',
    reminderMinutes: 30,
    isCompleted: false,
  }))
  const jobs = platforms.map((platform, i) => ({
    id: `sample-job-${i}`,
    observationId: i + 1,
    platform,
    externalId: `sample-${i}`,
    url: `https://example.com/jobs/${i}`,
    title: [
      '前端开发工程师',
      '高级前端工程师',
      'Web 前端开发',
      '前端研发工程师',
      '前端开发工程师',
      '前端开发实习生',
    ][i],
    company: companies[i].name,
    city: '上海',
    salary: ['18–28K·14薪', '25–35K·15薪', '15–25K', '20–30K', '16–24K', '200–300元/天'][i],
    salaryMin: i === 5 ? null : 18000,
    salaryMax: i === 5 ? null : 28000,
    experience: i === 5 ? '在校生' : '3–5年',
    education: '本科',
    recruitment: i === 5 ? '实习' : '社招',
    employment: i === 5 ? '实习' : '全职',
    jd: '岗位职责\n1. 负责 Web 产品的前端研发，建设清晰、易用的业务界面。\n2. 使用 Vue 3、TypeScript 开发可维护的组件与交互。\n3. 与产品、设计和后端协作，持续改善页面性能与体验。\n\n任职要求\n1. 熟悉 JavaScript、HTML、CSS，具备扎实的前端基础。\n2. 熟悉 Vue 或 React，有组件化开发与工程实践经验。\n3. 重视代码质量，能够清楚表达方案并参与团队协作。\n\n加分项\n有桌面客户端、自动化测试或性能优化经验。\n\n本岗位为产品截图使用的虚构示例，不代表招聘平台上的真实职位。',
    detailRead: true,
    detailReadAt: now,
    readAt: now,
    missing: {},
    removedFromCurrentSearch: false,
    savedOpportunityId: i === 2 ? 2 : null,
    possibleDuplicate: false,
  }))
  let run = null
  const paginate = (items, query = {}) => ({
    items,
    total: items.length,
    page: query.page ?? 1,
    pageSize: query.pageSize ?? 10,
  })
  const config = {
    configVersion: 2,
    onboarding: {
      app: { status: 'completed', stepId: null },
      discovery: { status: 'completed', stepId: null },
    },
    themeMode: 'light',
    statusFlowTheme: 'ocean',
    locale: 'zh-CN',
    closeBehavior: 'tray',
    launchAtStartup: false,
    companyReadValidityMonths: 3,
    mcp: { enabled: true, requireWriteConfirmation: true },
    ai: {
      baseUrl: '',
      modelId: '',
      apiKey: '',
      multimodal: false,
      contextWindowK: 128,
      compactThresholdPercent: 80,
    },
  }
  const conversation = {
    ...stamp,
    id: 'sample-conversation',
    title: '前端岗位准备（示例）',
    activity: 'idle',
  }
  window.windowControlsApi = { minimize: noop, toggleMaximize: noop, close: noop }
  window.velopackApi = {
    getVersion: async () => version,
    rendererHealthy: async () => true,
    onProgress: subscribe,
  }
  window.zhijiApi = {
    config: { get: async () => config },
    statuses: { list: async () => statuses },
    industries: { list: async () => industries },
    resumes: { list: async () => resumes },
    companies: {
      list: async () => companies,
      search: async (query) => paginate(companies, query),
      searchLocations: async (query) => paginate(['上海', '北京', '杭州', '深圳'], query),
    },
    opportunities: {
      list: async () => opportunities,
      search: async (query) => paginate(opportunities, query),
    },
    calendar: { list: async () => events, onReminderClick: subscribe },
    companyCatalog: {
      getStatus: async () => ({ version: null, publishedAt: null, syncedAt: null }),
      onProgress: subscribe,
    },
    system: { isDevelopment: async () => false, openExternal: noop },
    mcp: {
      getConnectionInfo: async () => ({
        enabled: true,
        requireWriteConfirmation: true,
        command: 'JobTrail.exe',
        args: ['--mcp'],
      }),
    },
    data: { onExternalChange: subscribe },
    backup: { onImportConfirmation: subscribe },
    exams: { onChanged: subscribe },
    agent: {
      onEvent: subscribe,
      list: async () => [conversation],
      create: async () => conversation,
      history: async () => ({
        pending: null,
        running: false,
        usage: {
          inputTokens: 3200,
          outputTokens: 640,
          cacheReadTokens: 0,
          contextTokens: 3840,
          contextEstimated: true,
          contextWindowTokens: 128000,
        },
        messages: [
          {
            id: 'sample-user',
            role: 'user',
            parts: [
              { kind: 'resume', id: 1, name: resumes[0].name },
              { kind: 'opportunity', id: 1, name: opportunities[0].title },
              { kind: 'text', text: '请结合这份简历和岗位，帮我梳理面试准备方向。' },
            ],
            attachments: [],
          },
          {
            id: 'sample-assistant',
            role: 'assistant',
            text: '以下是示例对话，用于展示岗位与简历引用。\n\n### 建议按这三个方向准备\n\n1. **项目表达**：选一个 Vue 3 + TypeScript 项目，说明你的职责、关键选择和结果。\n2. **技术基础**：复习组件通信、异步任务与浏览器渲染，准备解释实际遇到的问题。\n3. **岗位匹配**：整理性能优化、测试与团队协作的案例，结合岗位要求逐项补充。\n\n你还可以使用 `/resume-match` 分析简历匹配度，或使用 `/study` 生成笔试练习。',
            attachments: [],
          },
        ],
      }),
    },
    discovery: {
      status: async () =>
        platforms.map((platform) => ({
          platform,
          state: 'authenticated',
          checkedAt: now,
          generation: 1,
          evidence: 'screenshot_fixture',
          capabilities: { cities: [], remoteFilters: [], qr: 'website' },
          limitations: [],
        })),
      start: async ({ query, requestId }) => {
        run = {
          id: 'd19717c3-4144-4452-81f0-c4dc9d56ae45',
          requestId,
          query,
          state: 'completed',
          ...stamp,
          sources: platforms.map((platform) => ({
            platform,
            state: 'completed',
            count: 1,
            batches: 1,
            sourcePage: 1,
            rawCount: 1,
            validCount: 1,
            duplicateCount: 0,
            rejectedCount: 0,
            salaryExcluded: { out_of_range: 0, day: 0, hour: 0, foreign: 0, unknown: 0 },
            cursor: null,
            generation: 1,
            remote: { keyword: query.keyword, city: query.city, cityCode: '' },
            message: '',
            cachedAt: null,
          })),
        }
        return run
      },
      run: async () => run,
      list: async (query) => ({
        ...paginate(jobs, query),
        viewId: 'd97d1ff4-385d-48a2-b142-a1b92f93dd38',
      }),
      detail: async ({ jobId }) => jobs.find((job) => job.id === jobId),
      history: async () => paginate(run ? [run] : []),
      verification: async () => null,
      browser: noop,
      region: noop,
      onBrowserLoading: subscribe,
    },
  }
}
