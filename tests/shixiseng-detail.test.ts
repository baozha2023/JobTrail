// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { shixisengAdapter } from '../src/main/discovery/adapters/shixiseng'
import type { PageSnapshot } from '../src/main/discovery/extraction'
beforeEach(() => {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    height: 20,
    width: 100,
  } as DOMRect)
  document.body.innerHTML =
    '<div class="new_job_name"><span>运营实习生</span></div><a class="com-name">样例公司</a><div class="job_msg"><span class="job_position">北京、上海</span><span class="job_money">150-200/天</span><span class="job_academic">本科</span><span class="job_week">3天／周</span><span class="job_time">实习6个月</span></div><div class="job_part"><div class="job_detail">岗位职责：运营</div><div class="job_detail">岗位要求：沟通能力</div><div class="job_detail">其他：实习证明</div></div><div class="resume_apply">投递简历</div><div class="recommend">推荐岗位详情</div>'
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
