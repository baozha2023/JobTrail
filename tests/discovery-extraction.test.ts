// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://www.zhipin.com/"}
import { platformAdapter } from '../src/main/discovery/adapter-registry'
import { afterEach, expect, it, vi } from 'vitest'
import { type PageSnapshot } from '../src/main/discovery/extraction'
import type { JobPlatform } from '../src/shared/job-discovery'

function read(html: string, platform: JobPlatform = 'wuyou'): PageSnapshot {
  document.documentElement.innerHTML = html
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 400,
    height: 200,
  } as DOMRect)
  for (const element of document.querySelectorAll<HTMLElement>('[data-rendered-text]'))
    Object.defineProperty(element, 'innerText', { value: element.dataset.renderedText })
  return window.eval(platformAdapter(platform).pageScript(true))
}
afterEach(() => vi.restoreAllMocks())
it('preserves empty rendered title and JD when their sized containers contain only hidden text', () => {
  const page = read(
    '<div class="cn"><div class="jTitle"><h1 data-rendered-text="" style="width:200px;height:30px"><span style="display:none">隐藏标题</span></h1></div></div><div class="bmsg job_msg" data-rendered-text="" style="width:200px;height:30px"><span style="display:none">隐藏职责</span></div>',
  )
  expect(page.detail).toMatchObject({ title: '', jd: '', detailRead: false })
})
it('uses the rendered field text when hidden descendants also have text content', () => {
  const page = read(
    '<div class="cn"><div class="jTitle"><h1 data-rendered-text="当前岗位">当前岗位<span style="display:none">隐藏提示</span></h1></div></div><div class="bmsg job_msg" data-rendered-text="当前职责">当前职责<span style="display:none">隐藏正文</span></div>',
  )
  expect(page.detail).toMatchObject({ title: '当前岗位', jd: '当前职责', detailRead: true })
})
it('keeps the textContent fallback when the DOM does not provide innerText', () => {
  read(
    '<div class="cn"><div class="jTitle"><h1>当前岗位</h1></div></div><div class="bmsg job_msg">当前职责</div>',
  )
  for (const element of document.querySelectorAll('h1,.bmsg.job_msg'))
    Object.defineProperty(element, 'innerText', { value: undefined })
  const page = window.eval(platformAdapter('wuyou').pageScript(true)) as PageSnapshot
  expect(page.detail).toMatchObject({ title: '当前岗位', jd: '当前职责', detailRead: true })
})
it.each([
  '<h1 data-rendered-text=""><span style="display:none">访问验证</span></h1>',
  '<div class="job-status" data-rendered-text=""><span style="display:none">已下架</span></div>',
  '<button data-rendered-text=""><span style="display:none">退出登录</span></button>',
  '<div class="job-sec"><button data-rendered-text=""><span style="display:none">展开全部</span></button></div>',
])('ignores hidden-only page-state text inside a rendered container: %s', (html) => {
  const page = read(`${html}<div class="bmsg job_msg">当前职责</div>`)
  expect(page).toMatchObject({
    challenge: false,
    offline: false,
    authenticated: false,
    detail: { jd: '当前职责', detailRead: true },
  })
})
it.each([
  {
    platform: 'boss',
    html: '<div class="job-banner"><span class="text-experiece" data-rendered-text=""><span style="display:none">4天/周 3个月</span></span></div><div class="job-sec-text">当前职责</div>',
    expected: { experience: '', employment: '', jd: '当前职责', detailRead: true },
  },
  {
    platform: 'liepin',
    html: '<main><aside><div class="company-info-container"><div class="company-card"><div class="content"><div class="name ellipsis-1" data-rendered-text=""><span style="display:none">隐藏公司</span></div></div></div></div></aside></main><div class="job-intro-container"><div class="paragraph">当前职责</div></div>',
    expected: { company: '', jd: '当前职责', detailRead: true },
  },
  {
    platform: 'iguopin',
    html: '<div class="job-content"><div class="right"><div class="job-company-wrap"><div class="job-company-desc"><div class="company-title" data-rendered-text=""><span style="display:none">隐藏公司</span></div></div></div></div></div><div class="job-intro-section"><div class="job-duty">当前职责</div></div>',
    expected: { company: '', jd: '当前职责', detailRead: true },
  },
  {
    platform: 'zhilian',
    html: '<section class="summary-planes"><ul class="summary-planes__info"><li data-rendered-text=""><span style="display:none">中专/中技</span></li></ul></section><div class="describtion-card__detail-content">当前职责</div>',
    expected: { education: '', jd: '当前职责', detailRead: true },
  },
  {
    platform: 'ncss',
    html: '<h1 id="jobName">当前岗位</h1><div class="jobdetail-box"><div class="mainContent" data-rendered-text=""><span style="display:none">隐藏正文</span></div></div>',
    expected: { title: '当前岗位', jd: '', detailRead: false },
  },
] as const)(
  'keeps empty rendered text in the $platform detail wrapper',
  ({ platform, html, expected }) => {
    expect(read(html, platform).detail).toMatchObject(expected)
  },
)
it('recognizes the BOSS security redirect even while its verification UI is loading', () => {
  window.history.replaceState({}, '', '/web/passport/zp/security.html')
  try {
    expect(read('<title>请稍候 - BOSS直聘</title><p>正在加载中...</p>', 'boss').challenge).toBe(
      true,
    )
  } finally {
    window.history.replaceState({}, '', '/')
  }
})
it('extracts the observed BOSS header leaves without using recommended job terms', () => {
  const page = read(
    '<div class="recommend-jobs"><div class="job-banner"><span class="text-desc text-experiece">5-10年</span><span class="text-desc text-degree">博士</span></div></div><div class="job-banner"><div class="job-name"><h1>Java开发工程师</h1></div><span class="salary">15-25K</span><a class="text-desc text-city">北京</a><span class="text-desc text-experiece">1-3年</span><span class="text-desc text-degree">本科</span></div><div class="job-sec-text">负责系统开发与维护。</div>',
    'boss',
  )
  expect(page.detail).toMatchObject({
    title: 'Java开发工程师',
    city: '北京',
    salary: '15-25K',
    experience: '1-3年',
    education: '本科',
    jd: '负责系统开发与维护。',
    detailRead: true,
  })
})
it('ignores hidden BOSS header leaves when extracting experience and education', () => {
  const page = read(
    '<div class="job-banner" style="display:none"><span class="text-desc text-experiece">1-3年</span><span class="text-desc text-degree">本科</span></div><div class="job-sec-text">负责系统开发与维护。</div>',
    'boss',
  )
  expect(page.detail).toMatchObject({
    experience: '',
    education: '',
    jd: '负责系统开发与维护。',
    detailRead: true,
  })
})
it('preserves BOSS internship attendance in the JD and keeps it out of work experience', () => {
  const page = read(
    '<div class="job-banner"><a class="text-desc text-city">北京</a><span class="text-desc text-experiece">4天/周 3个月</span><span class="text-desc text-degree">本科</span></div><div class="job-detail-section"><div class="job-sec-text">负责Java开发。</div></div><div class="company-info-box"><div class="job-sec-text fold-text">公司介绍。</div></div>',
    'boss',
  )
  expect(page.detail).toMatchObject({
    city: '北京',
    education: '本科',
    experience: '',
    employment: '实习',
    jd: '4天/周 3个月\n负责Java开发。',
    detailRead: true,
    missing: { experience: 'not_provided' },
  })
})
it.each(['display:none', 'opacity:0'])(
  'ignores BOSS internship attendance in hidden headers (%s)',
  (style) => {
    const page = read(
      `<div class="job-banner" style="${style}"><span class="text-desc text-experiece">4天/周 3个月</span></div><div class="job-banner"><span class="text-desc text-experiece">1-3年</span><span class="text-desc text-degree">本科</span></div><div class="job-sec-text">负责Java开发。</div>`,
      'boss',
    )
    expect(page.detail).toMatchObject({
      experience: '1-3年',
      education: '本科',
      employment: '',
      jd: '负责Java开发。',
    })
    expect(page.detail.missing).toBeUndefined()
  },
)
it('ignores BOSS internship attendance in recommended jobs and unrelated content', () => {
  const page = read(
    '<div class="recommend-jobs"><div class="job-banner"><span class="text-desc text-experiece">4天/周 3个月</span></div></div><div class="job-banner"><span class="text-desc text-experiece">3-5年</span></div><div class="job-sec-text">负责Java开发。产品展示支持4天/周 3个月的日历计划。</div>',
    'boss',
  )
  expect(page.detail).toMatchObject({
    experience: '3-5年',
    employment: '',
    jd: '负责Java开发。产品展示支持4天/周 3个月的日历计划。',
  })
  expect(page.detail.missing).toBeUndefined()
})
it.each(['4天/周', '3个月', '8天/周 3个月', '4天/周 0个月'])(
  'requires the complete BOSS internship attendance format before inferring employment: %s',
  (attendance) => {
    const page = read(
      `<div class="job-banner"><span class="text-desc text-experiece">${attendance}</span></div><div class="job-sec-text">负责Java开发。</div>`,
      'boss',
    )
    expect(page.detail.employment).toBe('')
    expect(page.detail.jd).toBe('负责Java开发。')
    expect(page.detail.missing).toBeUndefined()
  },
)
it('keeps BOSS details incomplete when attendance is present without a JD', () => {
  const page = read(
    '<div class="job-banner"><span class="text-desc text-experiece">4天/周 3个月</span></div>',
    'boss',
  )
  expect(page.detail).toMatchObject({
    experience: '',
    employment: '实习',
    jd: '',
    detailRead: false,
    missing: { experience: 'not_provided' },
  })
})
it.each([
  ['empty', '<div class="job-sec-text"></div>'],
  ['missing', ''],
])('keeps BOSS company information out when the job description is %s', (_reason, description) => {
  const page = read(
    `<div class="job-banner"><span class="text-desc text-experiece">4天/周 3个月</span><span class="text-desc text-degree">本科</span></div><div class="job-detail-section"><h3>职位描述</h3>${description}</div><div class="detail-section-item company-info-box"><h3>公司介绍</h3><div class="job-sec-text fold-text">公司致力于提供企业信息化服务。</div></div>`,
    'boss',
  )
  expect(page.detail).toMatchObject({
    experience: '',
    education: '本科',
    employment: '实习',
    jd: '',
    detailRead: false,
    missing: { experience: 'not_provided' },
  })
})
it('reads the BOSS job description independently of an earlier company information section', () => {
  const page = read(
    '<div class="detail-section-item company-info-box"><h3>公司介绍</h3><div class="job-sec-text fold-text">公司致力于提供企业信息化服务。</div></div><div class="job-banner"><span class="text-desc text-experiece">3-5年</span><span class="text-desc text-degree">本科</span></div><div class="job-detail-section"><h3>职位描述</h3><div class="job-sec-text">负责Java开发与系统维护。</div></div>',
    'boss',
  )
  expect(page.detail).toMatchObject({
    experience: '3-5年',
    education: '本科',
    employment: '',
    jd: '负责Java开发与系统维护。',
    detailRead: true,
  })
})
it('extracts the observed Liepin internship header without using earlier related job fields', () => {
  const page = read(
    `<div class="related-jobs">
      <div class="job-title-box"><h1>其他岗位</h1></div>
      <span class="salary">50-80K</span><div class="company-name">其他公司</div>
      <div class="job-dq-box">其他城市</div>
      <div class="job-properties"><span>5-10年</span><span>博士</span></div>
    </div>
    <div class="job-apply-content">
      <div class="name-box"><div class="name ellipsis-2"><span class="job-title ellipsis-2">Java</span></div><span class="salary">200-250元/天</span></div>
      <div class="job-properties"><span>北京-海淀区</span><span>实习</span><span>5天/周</span><span>6个月</span><span>硕士</span><span>学生可投</span></div>
    </div>
    <div class="company-info-container"><div class="company-card"><div class="content"><div class="name ellipsis-1">当前公司</div></div></div></div>
    <div class="job-intro-container"><div class="paragraph">负责Java开发。</div></div>`,
    'liepin',
  )
  expect(page.detail).toMatchObject({
    title: 'Java',
    company: '当前公司',
    city: '北京-海淀区',
    salary: '200-250元/天',
    experience: '',
    education: '硕士',
    employment: '实习',
    recruitment: '',
    jd: '负责Java开发。',
    detailRead: true,
  })
})
it.each(['3-5年', '经验不限'])(
  'reads Liepin experience and education from the current header tags: %s',
  (experience) => {
    const page = read(
      `<div class="job-apply-content">
        <div class="name-box"><div class="name ellipsis-2"><span class="job-title ellipsis-2">Java开发工程师</span></div><span class="salary">20-30K</span></div>
        <div class="job-properties"><span>上海-徐汇区</span><span>${experience}</span><span>本科</span></div>
      </div>
      <div class="company-info-container"><div class="company-card"><div class="content"><div class="name ellipsis-1">当前公司</div></div></div></div>
      <div class="job-intro-container"><div class="paragraph">负责接口开发。</div></div>`,
      'liepin',
    )
    expect(page.detail).toMatchObject({
      title: 'Java开发工程师',
      company: '当前公司',
      city: '上海-徐汇区',
      salary: '20-30K',
      experience,
      education: '本科',
      employment: '',
      jd: '负责接口开发。',
      detailRead: true,
    })
  },
)
it('leaves hidden Liepin header fields empty instead of using related job fields', () => {
  const page = read(
    `<div class="related-jobs"><div class="job-title-box"><h1>其他岗位</h1></div><span class="salary">50-80K</span><div class="company-name">其他公司</div><div class="job-dq-box">其他城市</div><div class="job-properties"><span>5-10年</span><span>博士</span></div></div>
    <div style="display:none">
      <div class="job-apply-content"><div class="name-box"><div class="name ellipsis-2"><span class="job-title ellipsis-2">Java</span></div><span class="salary">20-30K</span></div><div class="job-properties"><span>北京</span><span>3-5年</span><span>本科</span></div></div>
      <div class="company-info-container"><div class="company-card"><div class="content"><div class="name ellipsis-1">当前公司</div></div></div></div>
    </div>
    <div class="job-intro-container"><div class="paragraph">负责接口开发。</div></div>`,
    'liepin',
  )
  expect(page.detail).toMatchObject({
    title: '',
    company: '',
    city: '',
    salary: '',
    experience: '',
    education: '',
    employment: '',
    jd: '负责接口开发。',
    detailRead: true,
  })
})
it('reads the current Liepin company card from the main aside after recommended companies', () => {
  const page = read(
    '<aside class="recommend-jobs"><div class="company-info-container"><div class="company-card"><div class="content"><div class="name ellipsis-1">推荐公司</div></div></div></div></aside><main><aside><div class="company-info-container"><div class="company-card"><div class="content"><div class="name ellipsis-1">慧策|旺店通(掌上先机)</div></div></div></div></aside></main><div class="job-intro-container"><div class="paragraph">负责Java开发。</div></div>',
    'liepin',
  )
  expect(page.detail).toMatchObject({
    company: '慧策|旺店通(掌上先机)',
    jd: '负责Java开发。',
    detailRead: true,
  })
})
it.each(['recommend-jobs', 'job-list', 'company-intro'])(
  'does not read a Liepin company card inside an excluded %s section',
  (sectionClass) => {
    const page = read(
      `<main><aside class="${sectionClass}"><div class="company-info-container"><div class="company-card"><div class="content"><div class="name ellipsis-1">其他公司</div></div></div></div></aside></main><div class="job-intro-container"><div class="paragraph">负责Java开发。</div></div>`,
      'liepin',
    )
    expect(page.detail).toMatchObject({ company: '', jd: '负责Java开发。', detailRead: true })
  },
)
it.each(['display:none', 'opacity:0', 'visibility:hidden'])(
  'does not read the Liepin company card from a hidden aside with %s',
  (style) => {
    const page = read(
      `<main><aside style="${style}"><div class="company-info-container"><div class="company-card"><div class="content"><div class="name ellipsis-1">当前公司</div></div></div></div></aside></main><div class="job-intro-container"><div class="paragraph">负责Java开发。</div></div>`,
      'liepin',
    )
    expect(page.detail).toMatchObject({ company: '', jd: '负责Java开发。', detailRead: true })
  },
)
it.each([
  { state: 'login', html: '<input type="password">' },
  { state: 'challenge', html: '<h2>安全验证</h2>' },
  { state: 'offline', html: '<p>该职位已下架。</p>' },
] as const)('keeps the Liepin company card unread while the page is $state', ({ state, html }) => {
  const page = read(
    `${html}<main><aside><div class="company-info-container"><div class="company-card"><div class="content"><div class="name ellipsis-1">当前公司</div></div></div></div></aside></main><div class="job-intro-container"><div class="paragraph">负责Java开发。</div></div>`,
    'liepin',
  )
  expect(page[state]).toBe(true)
  expect(page.detail).toEqual({})
})
it('extracts the current Zhilian detail contract without reading recommended jobs', () => {
  const page = read(
    '<section class="summary-planes"><h1 class="summary-planes__title">Java</h1><span class="summary-planes__salary">1.4-2.8万·14薪</span><ul class="summary-planes__info"><li><a class="workCity-link">北京</a><span>朝阳区</span></li><li>酒仙桥</li><li>3-5年</li><li>本科</li></ul></section><a class="company-info__name">当前公司</a><div class="describtion-card__detail-content">负责Java开发。任职要求：掌握Spring。</div><div class="jobs-deliver"><div class="job-education">博士</div><div class="salary">80K</div></div>',
    'zhilian',
  )
  expect(page.detail).toMatchObject({
    title: 'Java',
    company: '当前公司',
    city: '北京',
    salary: '1.4-2.8万·14薪',
    education: '本科',
    experience: '3-5年',
    jd: '负责Java开发。任职要求：掌握Spring。',
    detailRead: true,
  })
})
it('reads the observed Zhilian vocational education directly from the internship header', () => {
  const page = read(
    '<main><section class="summary-planes"><h1 class="summary-planes__title">python开发,java开发</h1><span class="summary-planes__salary">150-200元/天</span><ul class="summary-planes__info"><li><a class="workCity-link">北京</a><span>海淀区</span></li><li>中专/中技</li><li>实习</li><li>6个月</li><li>5天/周</li></ul></section><a class="company-info__name">当前公司</a><div class="describtion-card__detail-content">负责软件开发。</div></main>',
    'zhilian',
  )
  expect(page.detail).toMatchObject({
    title: 'python开发,java开发',
    company: '当前公司',
    city: '北京',
    salary: '150-200元/天',
    education: '中专/中技',
    experience: '',
    employment: '实习',
    recruitment: '',
    jd: '负责软件开发。',
    detailRead: true,
  })
})
it.each(['recommend-jobs', 'jobs-deliver', 'job-list', 'company-intro'])(
  'does not use vocational education from an earlier Zhilian %s section',
  (sectionClass) => {
    const page = read(
      `<div class="${sectionClass}"><section class="summary-planes"><ul class="summary-planes__info"><li>中专/中技</li></ul></section></div><main><section class="summary-planes"><ul class="summary-planes__info"><li>3-5年</li><li>本科</li></ul></section><div class="describtion-card__detail-content">负责软件开发。</div></main>`,
      'zhilian',
    )
    expect(page.detail).toMatchObject({
      education: '本科',
      experience: '3-5年',
      jd: '负责软件开发。',
      detailRead: true,
    })
  },
)
it.each(['display:none', 'opacity:0', 'visibility:hidden'])(
  'does not read vocational education from a hidden Zhilian header with %s',
  (style) => {
    const page = read(
      `<main><section class="summary-planes" style="${style}"><ul class="summary-planes__info"><li>中专/中技</li></ul></section><div class="describtion-card__detail-content">负责软件开发。</div></main>`,
      'zhilian',
    )
    expect(page.detail).toMatchObject({ education: '', jd: '负责软件开发。', detailRead: true })
  },
)
it('does not read Zhilian vocational education from an aside or outside the summary header', () => {
  const page = read(
    '<aside><section class="summary-planes"><ul class="summary-planes__info"><li>中专/中技</li></ul></section></aside><ul class="summary-planes__info"><li>中专/中技</li></ul><div class="describtion-card__detail-content">负责软件开发。</div>',
    'zhilian',
  )
  expect(page.detail).toMatchObject({ education: '', jd: '负责软件开发。', detailRead: true })
})
it.each([
  { state: 'login', html: '<input type="password">' },
  { state: 'challenge', html: '<h2>安全验证</h2>' },
  { state: 'offline', html: '<p>该职位已下架。</p>' },
] as const)(
  'does not read Zhilian vocational education while the page is $state',
  ({ state, html }) => {
    const page = read(
      `${html}<main><section class="summary-planes"><ul class="summary-planes__info"><li>中专/中技</li></ul></section><div class="describtion-card__detail-content">负责软件开发。</div></main>`,
      'zhilian',
    )
    expect(page[state]).toBe(true)
    expect(page.detail).toEqual({})
  },
)
it('reads the observed 51job detail header and employer before the address map', () => {
  const page = read(
    '<div class="recommend-jobs"><div class="cn"><div class="jTitle"><h1>推荐岗位</h1><strong>80K</strong></div><p class="msg ltype"><span class="type_2">上海</span><span class="type_3">5年及以上</span><span class="type_4">博士</span></p></div><div class="corp-card"><div class="initiator"><div class="com_msg"><a class="com_name">推荐公司</a></div></div></div><div class="bmsg job_msg">推荐职责</div></div><div class="job-address">上班地址：北京石景山地图查看公交路线</div><div class="cn"><div class="jTitle"><h1>北京JAVA程序员</h1><strong>5-7千</strong></div><p class="msg ltype"><span class="type_2">北京-石景山区</span><span class="type_3">1年及以上</span><span class="type_4">本科</span></p></div><div class="corp-card tBorderTop_box"><div class="initiator"><div class="com_msg"><a class="com_name himg">湖南天砺信息技术有限公司</a></div></div></div><div class="job-detail tBorderTop_box"><div class="bmsg job_msg">负责Java程序开发与维护。</div></div>',
    'wuyou',
  )
  expect(page.detail).toMatchObject({
    title: '北京JAVA程序员',
    company: '湖南天砺信息技术有限公司',
    city: '北京-石景山区',
    salary: '5-7千',
    experience: '1年及以上',
    education: '本科',
    employment: '',
    recruitment: '',
    jd: '负责Java程序开发与维护。',
    detailRead: true,
  })
})
it('does not read 51job address maps or unrelated generic field names as detail header fields', () => {
  const page = read(
    '<div class="job-name"><h1>其他标题</h1></div><div class="company-name">其他公司</div><div class="job-address">上班地址：北京石景山地图查看公交路线</div><span class="salary">80K</span><span class="job-experience">5年及以上</span><span class="job-education">博士</span><div class="bmsg job_msg">负责Java程序开发与维护。</div>',
    'wuyou',
  )
  expect(page.detail).toMatchObject({
    title: '',
    company: '',
    city: '',
    salary: '',
    experience: '',
    education: '',
    jd: '负责Java程序开发与维护。',
    detailRead: true,
  })
})
it('reads 51job employment only from the current detail header tags', () => {
  const page = read(
    '<div class="job-properties"><span>实习</span></div><div class="cn"><p class="msg ltype"><span>全职</span></p></div><div class="bmsg job_msg">负责Java开发。</div>',
    'wuyou',
  )
  expect(page.detail).toMatchObject({ employment: '全职', jd: '负责Java开发。', detailRead: true })
})
it.each(['display:none', 'opacity:0', 'visibility:hidden'])(
  'does not read the hidden 51job detail header or company with %s',
  (style) => {
    const page = read(
      `<div style="${style}"><div class="cn"><div class="jTitle"><h1>北京JAVA程序员</h1><strong>5-7千</strong></div><p class="msg ltype"><span class="type_2">北京-石景山区</span><span class="type_3">1年及以上</span><span class="type_4">本科</span></p></div><div class="corp-card"><div class="initiator"><div class="com_msg"><a class="com_name">当前公司</a></div></div></div></div><div class="job-address">上班地址：北京地图查看路线</div><div class="bmsg job_msg">负责Java开发。</div>`,
      'wuyou',
    )
    expect(page.detail).toMatchObject({
      title: '',
      company: '',
      city: '',
      salary: '',
      experience: '',
      education: '',
      jd: '负责Java开发。',
      detailRead: true,
    })
  },
)
it.each([
  { state: 'login', html: '<input type="password">' },
  { state: 'challenge', html: '<h2>安全验证</h2>' },
  { state: 'offline', html: '<p>该职位已下架。</p>' },
] as const)('leaves the 51job detail unread while the page is $state', ({ state, html }) => {
  const page = read(
    `${html}<div class="cn"><div class="jTitle"><h1>北京JAVA程序员</h1><strong>5-7千</strong></div><p class="msg ltype"><span class="type_2">北京-石景山区</span><span class="type_3">1年及以上</span><span class="type_4">本科</span></p></div><div class="corp-card"><div class="initiator"><div class="com_msg"><a class="com_name">当前公司</a></div></div></div><div class="bmsg job_msg">负责Java开发。</div>`,
    'wuyou',
  )
  expect(page[state]).toBe(true)
  expect(page.detail).toEqual({})
})
it('reads the observed Guopin employer card without replacing it with the department', () => {
  const page = read(
    '<div class="job-search-wrap"><div class="job-content"><div class="right"><div class="job-company-wrap"><div class="job-company-desc"><div class="company-title">推荐单位</div></div></div></div></div></div><div class="job-detail-wrap"><div class="address-section"><span class="address">北京-丰台区</span><span class="address">智能技术中心</span></div></div><div class="job-content"><div class="left"><div class="job-intro-section"><div class="job-duty">负责Java开发与测试。</div></div></div><div class="right"><div class="section job-company-wrap"><div class="section-title">单位信息</div><div class="section-content"><div class="job-company-top"><div class="job-company-desc"><a><div class="company-title substring2">北京计算机技术及应用研究所</div></a></div></div></div></div></div></div>',
    'iguopin',
  )
  expect(page.detail).toMatchObject({
    company: '北京计算机技术及应用研究所',
    city: '北京-丰台区',
    jd: '负责Java开发与测试。',
    detailRead: true,
  })
})
it.each([
  '<span class="address">北京-丰台区</span>',
  '<span class="address">北京-丰台区</span><span class="address">智能技术中心</span>',
])('does not use Guopin address or department nodes as the employer: %s', (addresses) => {
  const page = read(
    `<div class="job-detail-wrap"><div class="address-section">${addresses}</div></div><div class="job-intro-section"><div class="job-duty">负责Java开发。</div></div>`,
    'iguopin',
  )
  expect(page.detail).toMatchObject({ company: '', jd: '负责Java开发。', detailRead: true })
})
it.each(['job-search-wrap', 'job-competition-analysis-wrap', 'recommend-jobs'])(
  'does not read a Guopin employer card in an excluded %s area',
  (sectionClass) => {
    const page = read(
      `<div class="${sectionClass}"><div class="job-content"><div class="right"><div class="job-company-wrap"><div class="job-company-desc"><div class="company-title">其他单位</div></div></div></div></div></div><div class="job-intro-section"><div class="job-duty">负责Java开发。</div></div>`,
      'iguopin',
    )
    expect(page.detail).toMatchObject({ company: '', jd: '负责Java开发。', detailRead: true })
  },
)
it.each(['display:none', 'opacity:0', 'visibility:hidden'])(
  'does not read a hidden Guopin employer card with %s',
  (style) => {
    const page = read(
      `<div class="job-content"><div class="right" style="${style}"><div class="job-company-wrap"><div class="job-company-desc"><div class="company-title">当前单位</div></div></div></div></div><div class="job-intro-section"><div class="job-duty">负责Java开发。</div></div>`,
      'iguopin',
    )
    expect(page.detail).toMatchObject({ company: '', jd: '负责Java开发。', detailRead: true })
  },
)
it.each([
  { state: 'login', html: '<input type="password">' },
  { state: 'challenge', html: '<h2>安全验证</h2>' },
  { state: 'offline', html: '<p>该职位已下架。</p>' },
] as const)('leaves the Guopin employer unread while the page is $state', ({ state, html }) => {
  const page = read(
    `${html}<div class="job-content"><div class="right"><div class="job-company-wrap"><div class="job-company-desc"><div class="company-title">当前单位</div></div></div></div></div><div class="job-intro-section"><div class="job-duty">负责Java开发。</div></div>`,
    'iguopin',
  )
  expect(page[state]).toBe(true)
  expect(page.detail).toEqual({})
})
it('reads the observed Shixiseng company and unrestricted education with no experience requirement', () => {
  const page = read(
    '<div class="job-header"><div class="new_job_name"><span>Java实习生</span></div><div class="job_msg"><span class="job_money">150-200/天</span><span class="job_position">北京</span><span class="job_academic">不限</span><span class="job_week">5天／周</span><span class="job_time">实习3个月</span></div></div><div class="job-content"><div class="content_left"><div class="job_part"><div class="job_detail">职责：开发。</div><div class="job_detail">要求：掌握Java。</div><div class="job_detail">提供实习证明。</div></div></div><div class="content_right"><div class="job-about"><div class="con-job"><div class="com_intro"><a class="com-name">汇杰科技</a></div></div></div></div></div>',
    'shixiseng',
  )
  expect(page.detail).toMatchObject({
    title: 'Java实习生',
    company: '汇杰科技',
    city: '北京',
    salary: '150-200/天',
    education: '不限',
    experience: '',
    missing: { experience: 'not_provided' },
    detailRead: true,
  })
  expect(page.detail.jd).toBe('5天／周\n实习3个月\n职责：开发。要求：掌握Java。提供实习证明。')
})
it('reads the current Yupao original JD section and header tags independently of AI text', () => {
  window.history.replaceState({}, '', '/zhaogong/511166684.html')
  try {
    const data = {
      props: {
        pageProps: {
          ppJobInfo: {
            id: 511166684,
            title: 'Java开发工程师',
            salary: '1.5-2万/月',
            tags: ['5-10年', '本科', 'Java', 'SpringCloud'],
            desc: 'AI改写正文',
            fullData: {
              jobId: 511166684,
              title: 'Java开发工程师',
              companyBrandName: '当前公司',
              address: '北京',
              detail: '负责Java服务开发，掌握Spring。',
              showTags: [{ name: 'Java' }],
              infoSeoExtra: { detail: 'AI改写正文' },
            },
          },
        },
      },
    }
    const page = read(
      `<main><div><div class="agba"><div class="adeci">职位详情 微信扫码分享 举报</div><div class="adede"><span>5-10年</span><span>本科</span><span>Java</span></div><div class="adeee">负责Java服务开发，掌握Spring。</div><div class="adefb">AI改写的其他正文。</div><div class="addfd">招聘者</div></div></div><aside><div class="agba"><div class="adeee">推荐岗位正文。</div></div></aside></main><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script>`,
      'yupao',
    )
    expect(page.detail).toMatchObject({
      title: 'Java开发工程师',
      company: '当前公司',
      city: '北京',
      salary: '1.5-2万/月',
      experience: '5-10年',
      education: '本科',
      recruitment: '',
      employment: '',
      jd: '负责Java服务开发，掌握Spring。',
      detailRead: true,
      missing: {},
    })
  } finally {
    window.history.replaceState({}, '', '/')
  }
})
it('recognizes a short status label with nested text inside a job status element', () => {
  expect(read('<div class="job-status"><span>已下架</span></div>').offline).toBe(true)
  expect(read('<p>已下架</p>').offline).toBe(false)
})
it('never extracts a verification heading as the job title on the original job URL', () => {
  const page = read('<title>访问验证</title><h1>访问验证</h1><p>请拖动滑块完成拼图</p>')
  expect(page.challenge).toBe(true)
  expect(page.detail).toEqual({})
})
it('extracts a real job heading and complete description only from job nodes', () => {
  const page = read(
    '<title>Java岗位</title><div class="cn"><div class="jTitle"><h1>Java开发工程师</h1></div></div><div class="bmsg job_msg">负责接口开发与系统维护。</div>',
  )
  expect(page.challenge).toBe(false)
  expect(page.detail).toMatchObject({
    title: 'Java开发工程师',
    jd: '负责接口开发与系统维护。',
    detailRead: true,
  })
})
it('keeps login restrictions separate from parsing failures', () => {
  const page = read(
    '<h1>登录</h1><input type="password"><div class="bmsg job_msg">登录后查看</div>',
  )
  expect(page.login).toBe(true)
  expect(page.detail).toEqual({})
})
it.each([
  '<div class="bmsg job_msg">负责安全验证、人机验证与账号异常检测模块开发。</div>',
  '<div class="bmsg job_msg"><h2>安全验证</h2><p>负责验证模块开发。</p></div>',
  '<aside>推荐岗位：负责安全验证模块开发。</aside><div class="bmsg job_msg">岗位职责</div>',
  '<div style="display:none">请完成验证</div><div class="bmsg job_msg">岗位职责</div>',
])('does not treat job content, recommendations or hidden text as a challenge: %s', (html) => {
  const page = read(html)
  expect(page.challenge).toBe(false)
  expect(page.detail.detailRead).toBe(true)
})
it('still recognizes a visible challenge alongside the job description', () => {
  const page = read(
    '<div class="bmsg job_msg">岗位职责</div><div><span>请完成</span><b>验证</b></div>',
  )
  expect(page.challenge).toBe(true)
  expect(page.detail).toEqual({})
})
it.each(['boss', 'liepin', 'zhilian', 'wuyou', 'iguopin', 'shixiseng'] as const)(
  'ignores a preloaded transparent captcha but detects it when revealed on %s',
  (platform) => {
    const page = read(
      '<div id="captcha-container" style="position:absolute;top:-1000000px;opacity:0"><div><iframe src="https://turing.captcha.gtimg.com/"></iframe><span>请完成验证</span></div></div>',
      platform,
    )
    expect(page.challenge).toBe(false)
    const container = document.getElementById('captcha-container')!
    container.style.opacity = '1'
    container.style.top = '0'
    const revealed = window.eval(platformAdapter(platform).pageScript(true)) as PageSnapshot
    expect(revealed.challenge).toBe(true)
    expect(revealed.detail).toEqual({})
  },
)
it.each(['opacity:0', 'display:none', 'visibility:hidden'])(
  'ignores nested verification, login and offline evidence in a hidden container: %s',
  (style) => {
    const page = read(
      `<div style="${style}"><div><iframe src="https://turing.captcha.gtimg.com/"></iframe><span>请完成验证</span><input type="password"><p>职位已下架</p></div></div><div class="bmsg job_msg">完整岗位职责</div>`,
    )
    expect(page).toMatchObject({ login: false, challenge: false, offline: false })
    expect(page.detail).toMatchObject({ jd: '完整岗位职责', detailRead: true })
  },
)
it('preserves a complete JD above 30,000 characters without silently truncating it', () => {
  const jd = '职责。'.repeat(11000)
  const page = read(`<div class="bmsg job_msg">${jd}</div>`)
  expect(page.detail.jd?.length).toBe(jd.length)
  expect(page.detail.jd === jd).toBe(true)
  expect(page.detail.detailRead).toBe(true)
})
it('does not overwrite the selected job fields with matching selectors from recommendations', () => {
  const page = read(
    '<aside><div class="salary">80K</div><div class="company-name">推荐公司</div><span class="job-education">博士</span></aside><div class="cn"><div class="jTitle"><h1>当前岗位</h1><strong>15K</strong></div></div><div class="corp-card"><div class="initiator"><div class="com_msg"><a class="com_name">当前公司</a></div></div></div><div class="bmsg job_msg">当前职责</div>',
  )
  expect(page.detail).toMatchObject({
    title: '当前岗位',
    salary: '15K',
    company: '当前公司',
    education: '',
  })
})
it.each([
  ['boss', '职位已关闭'],
  ['liepin', '该职位已下线'],
  ['zhilian', '该职位已失效，看看其他机会吧'],
  ['wuyou', '您访问的职位已过期'],
] as const)('recognizes explicit %s job unavailability', (platform, message) => {
  const page = read(`<div class="job-status">${message}</div>`, platform)
  expect(page.offline).toBe(true)
  expect(page.detail).toEqual({})
})
it.each([
  '<div class="bmsg job_msg"><p>该职位已关闭</p></div>',
  '<div class="recommend-jobs"><p>该职位已关闭</p></div>',
  '<div style="display:none">该职位已关闭</div>',
  '<h1>页面不存在</h1>',
  '<h1>服务器错误</h1>',
  '',
  '<input type="password"><p>该职位已关闭</p>',
  '<h1>安全验证</h1><p>该职位已关闭</p>',
])(
  'never treats JD, recommendations, login, validation or site errors as delisting: %s',
  (html) => {
    expect(read(html).offline).toBe(false)
  },
)
