// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { shixisengAdapter } from '../src/main/discovery/adapters/shixiseng'
import type { PageSnapshot } from '../src/main/discovery/extraction'
import { normalizeJob } from '../src/main/discovery/normalization'
beforeEach(() => {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    height: 20,
    width: 100,
  } as DOMRect)
  document.body.innerHTML =
    '<div class="job-header"><div class="new_job_name"><span>运营实习生</span></div><div class="job_msg"><span class="job_position">北京、上海</span><span class="job_money">150-200/天</span><span class="job_academic">本科</span><span class="job_week">3天／周</span><span class="job_time">实习6个月</span></div></div><div class="job-content"><div class="content_left"><div class="job_part"><div class="job_detail">岗位职责：运营</div><div class="job_detail">岗位要求：沟通能力</div><div class="job_detail">其他：实习证明</div></div></div><div class="content_right"><div class="job-about"><div class="con-job"><div class="com_intro"><a class="com-name">样例公司</a></div></div></div></div></div><div class="resume_apply">投递简历</div><div class="recommend">推荐岗位详情</div>'
})
afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})
const read = () => (0, eval)(shixisengAdapter.pageScript(true)) as PageSnapshot
it('reads every JD section and internship terms without turning duration into experience', () => {
  const value = read()
  expect(value.detail).toMatchObject({
    title: '运营实习生',
    company: '样例公司',
    city: '北京、上海',
    salary: '150-200/天',
    education: '本科',
    experience: '',
    detailRead: true,
  })
  for (const part of [
    '岗位职责：运营',
    '岗位要求：沟通能力',
    '其他：实习证明',
    '3天／周',
    '实习6个月',
  ])
    expect(value.detail.jd).toContain(part)
  expect(value.detail.jd).not.toContain('推荐岗位')
})
it('only treats the official visible job status as delisting', () => {
  document.querySelector('.job_detail')!.textContent = '项目研究：当前职位已下线'
  document
    .querySelector('.job_detail')!
    .insertAdjacentHTML('beforeend', '<span class="resume_apply">当前职位已下线</span>')
  expect(read().offline).toBe(false)
  const status = document.querySelector('body > .resume_apply') as HTMLElement
  status.textContent = '当前职位已下线'
  status.style.visibility = 'hidden'
  expect(read().offline).toBe(false)
  status.style.visibility = 'visible'
  expect(read()).toMatchObject({ offline: true, detail: {} })
})
it('does not label encoded or folded JD as a complete description', () => {
  document.querySelector('.job_detail')!.textContent = '职责\ue001'
  expect(read().detail).toMatchObject({ jd: '', detailRead: false, missing: { jd: 'parse_error' } })
  document.querySelector('.job_detail')!.textContent = '登录后查看完整内容'
  expect(read().detail.detailRead).toBe(false)
})
it('keeps the JD incomplete when an attendance requirement still contains an unresolved glyph', () => {
  document.querySelector('.job_time')!.textContent = '实习\ue001个月'
  expect(read().detail).toMatchObject({
    jd: '',
    detailRead: false,
    missing: { jd: 'parse_error' },
  })
})
it('keeps decorative glyphs outside the JD and attendance requirements out of the completeness check', () => {
  document
    .querySelector('.job-header')!
    .insertAdjacentHTML('beforeend', '<i aria-hidden="true">\ue001</i>')
  const snapshot = read()
  expect(snapshot.detail.detailRead).toBe(true)
  expect(snapshot.detail.jd).toContain('3天／周\n实习6个月')
  expect(snapshot.detail.missing?.jd).toBeUndefined()
})
it('clears a previously saved experience value that came from unrestricted education', () => {
  document.querySelector('.job_academic')!.textContent = '不限'
  const snapshot = read()
  expect(snapshot.detail).toMatchObject({
    education: '不限',
    experience: '',
    missing: { experience: 'not_provided' },
  })
  const raw = {
    platform: 'shixiseng' as const,
    url: 'https://www.shixiseng.com/intern/inn_example',
    title: '运营实习生',
    company: '样例公司',
    city: '北京、上海',
    salary: '150-200/天',
    education: '不限',
    experience: '不限',
    recruitment: '',
    employment: '实习',
    jd: '旧正文',
    detailRead: true,
  }
  const previous = normalizeJob(raw, 1)
  const refreshed = normalizeJob({ ...raw, ...snapshot.detail }, 2, previous)
  expect(refreshed).toMatchObject({
    education: '不限',
    experience: '',
    missing: { experience: 'not_provided' },
  })
})
it('reads experience only from a dedicated visible node in the current header', () => {
  document.body.insertAdjacentHTML('afterbegin', '<span class="job-experience">5-10年</span>')
  document
    .querySelector('.job-header')!
    .insertAdjacentHTML('beforeend', '<span class="job-experience">经验不限</span>')
  expect(read().detail).toMatchObject({ experience: '经验不限', education: '本科' })
})
it('excludes hidden-only text in rendered company, experience and attendance containers', () => {
  document
    .querySelector('.job-header')!
    .insertAdjacentHTML('beforeend', '<span class="job-experience">5-10年</span>')
  for (const element of document.querySelectorAll(
    '.com-name,.job-experience,.job_week,.job_time',
  )) {
    element.innerHTML = `<span style="display:none">${element.textContent}</span>`
    Object.defineProperty(element, 'innerText', { value: '' })
  }
  const snapshot = read()
  expect(snapshot.detail).toMatchObject({
    company: '',
    experience: '',
    missing: { experience: 'not_provided' },
    detailRead: true,
  })
  expect(snapshot.detail.jd).toBe('岗位职责：运营岗位要求：沟通能力其他：实习证明')
})
it('keeps an empty rendered header inconclusive when only hidden requirements exist', () => {
  const header = document.querySelector('.job_msg')!
  header.innerHTML = '<span style="display:none">不限</span>'
  Object.defineProperty(header, 'innerText', { value: '' })
  expect(read().detail).toMatchObject({ experience: '', detailRead: true })
  expect(read().detail.missing?.experience).toBeUndefined()
})
it('ignores a hidden delisting message inside a rendered status container', () => {
  const status = document.querySelector('body > .resume_apply')!
  status.innerHTML = '<span style="display:none">当前职位已下线</span>'
  Object.defineProperty(status, 'innerText', { value: '' })
  expect(read()).toMatchObject({ offline: false, detail: { detailRead: true } })
})
it('keeps missing experience inconclusive without a populated visible main header', () => {
  document.querySelector('.job-header')!.remove()
  expect(read().detail.missing?.experience).toBeUndefined()
  document.body.innerHTML = '<div class="job-header"><div class="job_msg"></div></div>'
  expect(read().detail.missing?.experience).toBeUndefined()
  document.body.innerHTML =
    '<div class="recommend"><div class="job-header"><div class="job_msg"><span>不限</span></div></div></div>'
  expect(read().detail.missing?.experience).toBeUndefined()
  document.body.innerHTML = ''
  expect(read().detail.missing?.experience).toBeUndefined()
})
it('does not append hidden, unrelated or recommended attendance terms', () => {
  document.body.insertAdjacentHTML(
    'afterbegin',
    '<div class="job_msg"><span class="job_week">1天／周</span></div><div class="recommend"><div class="job-header"><div class="job_msg"><span class="job_week">2天／周</span><span class="job_time">实习9个月</span></div></div></div>',
  )
  document
    .querySelector('body > .job-header')!
    .insertAdjacentHTML(
      'beforeend',
      '<div style="display:none"><div class="job_msg"><span class="job_week">6天／周</span></div></div>',
    )
  const value = read()
  expect(value.detail.jd).toContain('3天／周\n实习6个月')
  for (const text of ['1天／周', '2天／周', '实习9个月', '6天／周'])
    expect(value.detail.jd).not.toContain(text)
})
it('reads the current company card after earlier unrelated or recommended company names', () => {
  document.body.insertAdjacentHTML(
    'afterbegin',
    '<a class="com-name">无关公司</a><div class="recommend"><div class="job-content"><div class="content_right"><div class="job-about"><div class="com_intro"><a class="com-name">推荐公司</a></div></div></div></div></div>',
  )
  expect(read().detail.company).toBe('样例公司')
})
it('keeps the right-side company area excluded from the JD and other detail fields', () => {
  const right = document.querySelector('.content_right')!
  right.insertAdjacentHTML(
    'beforeend',
    '<div class="job_part"><div class="job_detail">公司介绍内容</div></div><div class="job-header"><div class="new_job_name"><span>其他岗位</span></div><span class="job_position">上海</span><span class="job-experience">5-10年</span><div class="job_msg"><span class="job_week">7天／周</span></div></div>',
  )
  right.parentElement!.prepend(right)
  const value = read()
  expect(value.detail).toMatchObject({
    title: '运营实习生',
    company: '样例公司',
    city: '北京、上海',
    experience: '',
  })
  expect(value.detail.jd).not.toContain('公司介绍内容')
  expect(value.detail.jd).not.toContain('7天／周')
})
it.each(['display:none', 'opacity:0', 'visibility:hidden'])(
  'ignores company, experience and attendance nodes hidden by an ancestor with %s',
  (style) => {
    document.querySelector('.content_right')!.setAttribute('style', style)
    const terms = document.createElement('div')
    terms.setAttribute('style', style)
    terms.append(document.querySelector('.job_week')!, document.querySelector('.job_time')!)
    document.querySelector('.job_msg')!.append(terms)
    document
      .querySelector('.job-header')!
      .insertAdjacentHTML(
        'beforeend',
        `<div style="${style}"><span class="job-experience">3-5年</span></div>`,
      )
    const value = read()
    expect(value.detail).toMatchObject({
      company: '',
      experience: '',
      missing: { experience: 'not_provided' },
    })
    expect(value.detail.jd).not.toContain('3天／周')
    expect(value.detail.jd).not.toContain('实习6个月')
  },
)
it.each(['display:none', 'opacity:0', 'visibility:hidden'])(
  'does not report delisting from a status hidden by an ancestor with %s',
  (style) => {
    document.querySelector('body > .resume_apply')!.outerHTML =
      `<div style="${style}"><div class="resume_apply">当前职位已下线</div></div>`
    expect(read()).toMatchObject({ offline: false, detail: { company: '样例公司' } })
  },
)
it.each([
  { state: 'login', html: '<div class="login-dialog-wrap--is-show">登录</div>' },
  { state: 'challenge', html: '<h2>安全验证</h2>' },
  { state: 'offline', html: '<div class="resume_apply">当前职位已下线</div>' },
] as const)(
  'does not extract company or header terms while the page is $state',
  ({ state, html }) => {
    document.body.insertAdjacentHTML('afterbegin', html)
    const value = read()
    expect(value[state]).toBe(true)
    expect(value.detail).toEqual({})
  },
)
