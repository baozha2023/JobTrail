export const onboardingMessages = {
  'zh-CN': {
    title: '使用引导',
    description: '重新了解职迹的功能入口和岗位发现流程。',
    restartApp: '重新开始基础引导',
    restartDiscovery: '重新开始岗位发现引导',
    skip: '跳过',
    previous: '上一步',
    next: '下一步',
    done: '完成',
    retry: '重试',
    pause: '暂时退出',
    saveError: '引导进度保存失败，请重试。暂时退出会保留上次保存的进度。',
    app: {
      opportunities: {
        title: '求职记录',
        description: '集中管理岗位、投递时间和求职状态，关联公司、简历与日程，查看每次状态变化。',
      },
      calendar: {
        title: '日历',
        description:
          '安排面试、笔试和其他日程，设置 Windows 本地提醒，也可以将日程关联到求职记录。',
      },
      statuses: {
        title: '状态管理',
        description: '维护求职记录使用的状态名称、颜色和顺序，在这里整理适合自己的求职流程。',
      },
      industries: {
        title: '行业分类',
        description: '查看两级行业分类，管理二级行业和同级顺序，为公司分类与筛选提供选项。',
      },
      resumes: {
        title: '简历版本',
        description: '导入 PDF、DOC 或 DOCX 简历，管理多个版本，并记录每次投递使用的简历。',
      },
      companies: {
        title: '公司管理',
        description: '浏览和管理公司、行业与地点，收藏招聘官网，跟踪哪些官网已经查看过。',
      },
      discovery: {
        title: '岗位发现',
        description:
          '登录招聘平台后主动搜索岗位、查看详情并保存为求职记录。首次进入时会有专项引导。',
      },
      agent: {
        title: '智能体',
        description: '配置模型后，通过聊天整理求职信息、引用本地资料，也可以生成笔试练习。',
      },
      settings: {
        title: '设置',
        description:
          '调整主题与语言，配置模型和 MCP，更新公司目录、备份数据。这里也可以重新开始两套使用引导。',
      },
    },
    discovery: {
      accounts: {
        title: '先登录招聘平台',
        description: '通过账号管理登录需要使用的平台。登录状态会影响可选择的搜索平台。',
      },
      'account-list': {
        title: '平台账号',
        description:
          '这里列出各招聘平台及登录状态。选择平台可登录或查看账号状态，退出操作会清除该平台的本机会话。',
      },
      'qr-panel': {
        title: '扫码登录区域',
        description:
          '选择平台后，官方二维码会显示在这里。支持微信时优先显示微信，微信按钮在左、App 在右；可用方式以平台为准。本次引导不会申请二维码。',
      },
      platforms: {
        title: '选择搜索平台',
        description: '只有已登录的平台可以勾选。可以同时搜索多个平台，也可以取消不需要的平台。',
      },
      keyword: {
        title: '岗位关键词',
        description:
          '输入想要查找的岗位关键词，例如岗位名称或技术方向。提交搜索后，当前查询条件会锁定。',
      },
      city: {
        title: '工作城市',
        description: '城市候选取所选平台共同支持的城市。可以留空；切换平台后需要重新选择城市。',
      },
      salary: {
        title: '薪资筛选',
        description:
          '按需填写薪资上下限，也可以留空。已提交的查询会保留原条件，新的条件请通过“新搜索”设置。',
      },
      search: {
        title: '搜索与续查',
        description:
          '点击后开始搜索；已有结果时可以继续搜索更多岗位。搜索进行中可取消，结束或取消后条件仍保持锁定。',
      },
      results: {
        title: '搜索结果',
        description:
          '岗位会逐批出现在这里。可按相关性、薪资或发现时间排序，并翻页查看；点击岗位可查看详情。',
      },
      details: {
        title: '岗位详情',
        description:
          '这里展示选中岗位的详情，也可以打开官方网页，或保存为求职记录。没有搜索结果时会显示空白提示。',
      },
      'new-search': {
        title: '开始新的查询',
        description: '新搜索会取消当前采集并重置条件、列表和详情，保留搜索历史与已保存的求职记录。',
      },
      history: {
        title: '搜索历史',
        description:
          '在这里查看以往的搜索及岗位，继续可用的查询，或删除不再需要的历史。现在可以开始探索岗位了。',
      },
    },
  },
  'en-US': {
    title: 'Guided tours',
    description: 'Explore JobTrail navigation and the job discovery workflow again.',
    restartApp: 'Restart the app tour',
    restartDiscovery: 'Restart the discovery tour',
    skip: 'Skip',
    previous: 'Previous',
    next: 'Next',
    done: 'Finish',
    retry: 'Retry',
    pause: 'Pause',
    saveError: 'Tour progress could not be saved. Retry, or pause and keep your last saved step.',
    app: {
      opportunities: {
        title: 'Opportunities',
        description:
          'Manage jobs, application dates and statuses. Link companies, resumes and events, and review your status history.',
      },
      calendar: {
        title: 'Calendar',
        description:
          'Plan interviews, assessments and other events with local Windows reminders. Events can be linked to opportunities.',
      },
      statuses: {
        title: 'Statuses',
        description: 'Manage status names, colors and order to organize your application workflow.',
      },
      industries: {
        title: 'Industries',
        description:
          'Browse the two-level industry directory and manage second-level categories and their order for company filtering.',
      },
      resumes: {
        title: 'Resume versions',
        description:
          'Import PDF, DOC or DOCX resumes, manage versions and track which resume you used for each application.',
      },
      companies: {
        title: 'Companies',
        description:
          'Manage companies, industries and locations, bookmark career sites and track which sites you have visited.',
      },
      discovery: {
        title: 'Job discovery',
        description:
          'Sign in to recruitment platforms, search for jobs, read details and save opportunities. A dedicated tour starts on your first visit.',
      },
      agent: {
        title: 'Agent',
        description:
          'Configure your model to organize job information in chat, reference local materials and generate practice assessments.',
      },
      settings: {
        title: 'Settings',
        description:
          'Choose your theme and language, configure models and MCP, update the company catalog and back up your data. Both tours can be restarted here.',
      },
    },
    discovery: {
      accounts: {
        title: 'Sign in first',
        description:
          'Use account management to sign in to the platforms you want to search. Your login status determines which platforms are available.',
      },
      'account-list': {
        title: 'Platform accounts',
        description:
          'The recruitment platforms and their login statuses appear here. Select a platform to sign in or review its status. Signing out clears its local session.',
      },
      'qr-panel': {
        title: 'Scan to sign in',
        description:
          'After choosing a platform, its official QR code appears here. Where supported, WeChat is preferred and shown on the left, with App on the right. Available methods depend on the platform. This tour does not request a QR code.',
      },
      platforms: {
        title: 'Search platforms',
        description:
          'Only signed-in platforms can be selected. Search multiple platforms together or deselect any you do not need.',
      },
      keyword: {
        title: 'Job keywords',
        description:
          'Enter a job title or skill to search for. Submitting a search locks the current query conditions.',
      },
      city: {
        title: 'Work location',
        description:
          'Available cities are shared by the selected platforms. You can leave this blank. Changing platforms clears the selected city.',
      },
      salary: {
        title: 'Salary filters',
        description:
          'Set optional minimum and maximum salaries. Submitted queries keep their original conditions; use New search to change them.',
      },
      search: {
        title: 'Search and continue',
        description:
          'Start a search, then search for more jobs when results are available. You can cancel an active search. Conditions remain locked after completion or cancellation.',
      },
      results: {
        title: 'Search results',
        description:
          'Jobs appear here in batches. Sort by relevance, salary or discovery time, browse pages and select a job to read its details.',
      },
      details: {
        title: 'Job details',
        description:
          'Read the selected job, open its official page or save it as an opportunity. An empty-state message appears before a job is selected.',
      },
      'new-search': {
        title: 'Start a new query',
        description:
          'New search cancels the current collection and resets conditions, results and details. Search history and saved opportunities are kept.',
      },
      history: {
        title: 'Search history',
        description:
          'Review previous searches and jobs, continue available queries or delete history you no longer need. You are ready to explore jobs.',
      },
    },
  },
}
