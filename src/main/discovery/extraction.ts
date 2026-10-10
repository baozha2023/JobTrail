import type { RawJob } from '../../shared/job-discovery'
export interface PageSnapshot {
  url: string
  authenticated: boolean
  login: boolean
  challenge: boolean
  offline: boolean
  detail: Partial<RawJob>
}
export interface PageRules {
  challengeUrl?: string
  loginSelector: string
  loginUrl: string
  loginUrlNeedsText: boolean
  authenticatedSelector: string
  descriptionSelector: string
  statusSelector: string
  tagsSelector: string
  fields: Record<'title' | 'company' | 'city' | 'salary' | 'experience' | 'education', string>
  foldedSelector: string
  excludedSelector: string
}
export function pageScript(rules: PageRules, detail: boolean): string {
  return `(${readPage.toString()})(${JSON.stringify(rules)},${detail})`
}
function readPage(rules: PageRules, detail: boolean): PageSnapshot {
  const visible = (e: Element) => {
    const rect = e.getBoundingClientRect(),
      style = getComputedStyle(e)
    if (
      rect.width <= 0 ||
      rect.height <= 0 ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse'
    )
      return false
    // Preloaded verification frames can retain their size inside transparent containers.
    // Opacity and display on any ancestor affect rendering; offscreen JD content remains readable.
    for (let node: Element | null = e; node; node = node.parentElement) {
      const ancestorStyle = node === e ? style : getComputedStyle(node)
      if (ancestorStyle.display === 'none' || ancestorStyle.opacity === '0') return false
    }
    return true
  }
  const text = (e: Element | null) =>
    ((e as HTMLElement)?.innerText || e?.textContent || '').trim().replace(/\u00a0/g, ' ')
  const jobNodes = (root: ParentNode, selectors: string) =>
    Array.from(root.querySelectorAll(selectors)).filter(
      (node) => visible(node) && !node.closest(rules.excludedSelector),
    )
  const jobText = (root: ParentNode, selectors: string) =>
    jobNodes(root, selectors).map(text).find(Boolean) || ''
  const has = (selectors: string) => Array.from(document.querySelectorAll(selectors)).some(visible)
  // Job descriptions and recommendations are content, not page-state evidence.
  const stateElement = (element: Element) =>
    visible(element) && !element.closest(rules.descriptionSelector + ',' + rules.excludedSelector)
  const pageText = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const element = node.parentElement
      return element && stateElement(element) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
    },
  })
  let body = ''
  while (body.length < 40000) {
    const node = pageText.nextNode()
    if (!node) break
    body += (node.textContent ?? '').slice(0, 40000 - body.length)
  }
  const challenge =
    (!!rules.challengeUrl && new RegExp(rules.challengeUrl).test(location.href)) ||
    /captcha|verify|security-check/i.test(location.pathname) ||
    /滑动验证|请完成验证|访问过于频繁|账号异常|安全验证|行为异常|人机验证/.test(body) ||
    /^(访问验证|安全验证|人机验证)(\s|$)/.test(document.title.trim()) ||
    Array.from(document.querySelectorAll('h1,h2')).some(
      (element) => stateElement(element) && /^(访问验证|安全验证|人机验证)$/.test(text(element)),
    ) ||
    has('iframe[src*="captcha"],iframe[src*="verify"]')
  const login =
    has(rules.loginSelector) ||
    (!!rules.loginUrl &&
      new RegExp(rules.loginUrl).test(location.href) &&
      (!rules.loginUrlNeedsText || /登录|验证码/.test(body)))
  const authenticated =
    !challenge &&
    !login &&
    (has(rules.authenticatedSelector) ||
      Array.from(document.querySelectorAll('button,a')).some(
        (e) => visible(e) && /^退出登录$/.test(text(e)),
      ))
  const descriptionSelector = rules.descriptionSelector
  const fields = (root: ParentNode) => {
    const tags = jobNodes(root, rules.tagsSelector).map(text)
    const experience =
      tags.find((v) =>
        /^(经验不限|不限经验|不限|应届|应届生|应届毕业生|在校生|在校\/应届|\d+[-~至]\d+年|\d+年以上|\d+年以内)$/.test(
          v,
        ),
      ) || jobText(root, rules.fields.experience)
    const education =
      tags.find((v) =>
        /^(学历不限|不限学历|博士|硕士|研究生|本科|大专|中专|高中|初中)(及以上|以上)?$/.test(v),
      ) || jobText(root, rules.fields.education)
    return {
      experience,
      education,
      recruitment: tags.find((v) => /^(校招|校园招聘|社招|社会招聘)$/.test(v)) || '',
      employment: tags.find((v) => /^(全职|兼职|实习|劳务|外包)$/.test(v)) || '',
    }
  }
  const description = jobText(document, descriptionSelector)
  // Require a visible, explicit job-status message outside JD and recommendations.
  // Generic 404s, redirects, empty pages and network errors do not prove delisting.
  const offlineMessage =
    /^(?:(?:抱歉|很抱歉|对不起)[，,！!：:\s]*)?(?:您(?:访问|查看)的)?(?:该|此|本)?(?:职位|岗位)(?:信息)?(?:已(?:经)?(?:下架|下线|关闭|失效|过期|删除|停止招聘|结束招聘|招满|不存在)|不存在|不再招聘)(?:[，,。.!！\s]|$)/
  const statusSelector = rules.statusSelector
  const offline =
    detail &&
    !challenge &&
    !login &&
    Array.from(document.querySelectorAll('h1,h2,h3,p,div,span,button')).some((node) => {
      if (!visible(node) || node.closest(descriptionSelector + ',' + rules.excludedSelector))
        return false
      const value = text(node)
      if (
        node.matches(statusSelector) &&
        /^(?:已下架|已下线|已关闭|已失效|已过期|停止招聘)$/.test(value)
      )
        return true
      if (
        value.length > 120 ||
        Array.from(node.children).some((child) => visible(child) && text(child) === value)
      )
        return false
      return offlineMessage.test(value)
    })
  const folded =
    /展开全部|展开更多|登录后查看/.test(description) ||
    Array.from(document.querySelectorAll(rules.foldedSelector)).some(
      (e) => visible(e) && /展开|登录/.test(text(e)),
    )
  const data: Partial<RawJob> =
    detail && !challenge && !login && !offline
      ? {
          ...fields(document),
          title: jobText(document, rules.fields.title),
          company: jobText(document, rules.fields.company),
          city: jobText(document, rules.fields.city),
          salary: jobText(document, rules.fields.salary),
          jd: description,
          detailRead: !!description && !folded,
        }
      : {}
  return { url: location.href, authenticated, login, challenge, offline, detail: data }
}
