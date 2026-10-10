export const featureErrors = {
  'zh-CN': {
    DISCOVERY_UNSUPPORTED_CITY: '所选城市不被全部招聘网站支持，请重新选择城市或调整网站。',
    DISCOVERY_JOB_OFFLINE: '已下架',
    DISCOVERY_UNAVAILABLE: '岗位发现运行时不可用，请启动桌面应用后重试',
    DISCOVERY_FAILED: '岗位读取未完成，请查看来源状态并重试',
    WEB_BROWSER_UNAVAILABLE:
      '无法启动 Microsoft Edge，动态网页读取不可用。请确认已安装并更新 Edge；若仍失败，请修复安装或检查组织的浏览器策略。',
    EXAM_INVALID: '题目或答案格式无效，请检查后重试',
    EXAM_COUNTS_TOO_SMALL: '各题型的目标数量不能少于已生成的题目数量',
    EXAM_CONFLICT: '答案已变化，请刷新试卷后重试',
    EXAM_NOT_FOUND: '试卷或题目不存在',
    EXAM_ALREADY_GRADING: '该题正在判题，请稍候',
    EXAM_UNAVAILABLE: '判题暂不可用，请稍后重试',
    EXAM_GRADING_FAILED: 'AI 判题失败，请重试',
    PERSISTENCE_INVALID: '数据结构或配置损坏，已保留原数据',
    PERSISTENCE_BUSY: '数据维护正在进行，请稍后重试',
    PERSISTENCE_UNSUPPORTED: '此数据版本不受支持，请使用兼容的新版客户端',
    PERSISTENCE_FAILED: '数据检查或升级失败，请查看日志后重新启动',
  },
  'en-US': {
    DISCOVERY_UNSUPPORTED_CITY:
      'This city is not supported by every selected site. Choose another city or change the sites.',
    DISCOVERY_JOB_OFFLINE: 'No longer available',
    DISCOVERY_UNAVAILABLE: 'Job discovery is unavailable. Start the desktop app and retry.',
    DISCOVERY_FAILED: 'Job retrieval did not complete. Check source status and retry.',
    WEB_BROWSER_UNAVAILABLE:
      'Microsoft Edge could not start, so dynamic web reading is unavailable. Install or update Edge; if the problem persists, repair the installation or check your organization’s browser policies.',
    EXAM_INVALID: 'Invalid question or answer. Check your input and retry.',
    EXAM_COUNTS_TOO_SMALL:
      'The target count for each question type cannot be lower than the number already generated.',
    EXAM_CONFLICT: 'The answer has changed. Refresh the paper and retry.',
    EXAM_NOT_FOUND: 'The paper or question was not found.',
    EXAM_ALREADY_GRADING: 'This answer is already being graded.',
    EXAM_UNAVAILABLE: 'Grading is temporarily unavailable. Please retry later.',
    EXAM_GRADING_FAILED: 'AI grading failed. Please retry.',
    PERSISTENCE_INVALID:
      'The database or configuration is invalid. Original data has been preserved.',
    PERSISTENCE_BUSY: 'Data maintenance is in progress. Please retry later.',
    PERSISTENCE_UNSUPPORTED: 'This data version is unsupported. Use a compatible newer client.',
    PERSISTENCE_FAILED: 'Data validation or upgrade failed. Check the logs and restart.',
  },
} as const
