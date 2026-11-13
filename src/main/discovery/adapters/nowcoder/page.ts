import { pageScript, type PageRules, type PageSnapshot } from '../../extraction'

const rules: PageRules = {
  loginSelector: '.login-container,.qr-code-scan,.sparta-login-form,.new-sparta-login-form',
  loginUrl: '://www\\.nowcoder\\.com/(?:login|loginPage)(?:[/?]|$)',
  loginUrlNeedsText: false,
  authenticatedSelector: '.nc-nav-header-avatar',
  descriptionSelector: '.job-detail-infos',
  statusSelector: '.job-detail-wrap .job-status,.job-detail-wrap button',
  tagsSelector: '.job-detail-wrap .extra>span',
  fields: {
    title: '.job-detail-wrap h1.title',
    company: '.job-detail-wrap [data-unused-company]',
    city: '.job-detail-wrap .extra>span.el-tooltip',
    salary: '.job-detail-wrap .salary',
    education: '.job-detail-wrap .edu-level',
    experience: '[data-unused-experience]',
  },
  foldedSelector: '.job-detail-infos button,.job-detail-infos .expand',
  excludedSelector: '.job-detail-right-wrap,.recommend-job,.recommend-list,header,footer',
}
export function nowcoderPageScript(detail: boolean): string {
  if (!detail) return pageScript(rules, false)
  return `(${readNowcoderPage.toString()})(${pageScript(rules, true)},${JSON.stringify(rules.excludedSelector)})`
}

function readNowcoderPage(state: PageSnapshot, excludedSelector: string): PageSnapshot {
  if (state.login || state.challenge || state.offline) return state
  const visible = (element: Element | null): element is Element => {
    if (!element) return false
    const rect = element.getBoundingClientRect(),
      style = getComputedStyle(element)
    if (rect.width <= 0 || rect.height <= 0 || /hidden|collapse/.test(style.visibility))
      return false
    for (let node: Element | null = element; node; node = node.parentElement) {
      const ancestorStyle = node === element ? style : getComputedStyle(node)
      if (ancestorStyle.display === 'none' || ancestorStyle.opacity === '0') return false
    }
    return true
  }
  const text = (element: Element) =>
    ((element as HTMLElement).innerText ?? element.textContent ?? '').trim()
  const company = document.querySelector('.job-detail-right-wrap .company-card .fs-20')
  if (visible(company)) state.detail.company = text(company)
  const header = [...document.querySelectorAll('.job-detail-wrap .extra')].find(
    (element) => visible(element) && !element.closest(excludedSelector),
  )
  const tags = header ? [...header.querySelectorAll(':scope > span')].filter(visible) : []
  const labels = tags.map(text)
  // Education and city occupy the same header row as unclassed experience spans.
  state.detail.experience =
    tags
      .filter((element) => !element.matches('.edu-level,.el-tooltip'))
      .map(text)
      .find((value) =>
        /^(经验不限|不限经验|不限|应届|应届生|应届毕业生|在校生|在校\/应届|\d+[-~至]\d+年|\d+年以上|\d+年以内)$/.test(
          value,
        ),
      ) || ''
  if (!state.detail.experience && labels.some(Boolean))
    state.detail.missing = { ...state.detail.missing, experience: 'not_provided' }
  if (header) {
    if (state.detail.employment === '实习') state.detail.recruitment = '实习'
    const terms = labels.filter((value) => /天.*周|周.*天|(?:至少|最少).*月|转正/.test(value))
    if (terms.length && state.detail.jd) state.detail.jd = [...terms, state.detail.jd].join('\n')
  }
  return state
}
