// @vitest-environment jsdom
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
  return window.eval(platformAdapter(platform).pageScript(true))
}
afterEach(() => vi.restoreAllMocks())
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
    '<title>Java岗位</title><div class="cn"><h1>Java开发工程师</h1></div><div class="bmsg job_msg">负责接口开发与系统维护。</div>',
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
it('preserves a complete JD above 30,000 characters without silently truncating it', () => {
  const jd = '职责。'.repeat(11000)
  const page = read(`<div class="bmsg job_msg">${jd}</div>`)
  expect(page.detail.jd?.length).toBe(jd.length)
  expect(page.detail.jd === jd).toBe(true)
  expect(page.detail.detailRead).toBe(true)
})
it('does not overwrite the selected job fields with matching selectors from recommendations', () => {
  const page = read(
    '<aside><div class="salary">80K</div><div class="company-name">推荐公司</div><span class="job-education">博士</span></aside><div class="cn"><h1>当前岗位</h1><strong>15K</strong></div><div class="company-name">当前公司</div><div class="bmsg job_msg">当前职责</div>',
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
