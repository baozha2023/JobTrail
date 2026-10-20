import type { PageSnapshot } from '../../extraction'
import type { VerificationPolicy } from '../../adapter'

export function ncssPageScript(detail: boolean): string {
  return `(${readNcssPage.toString()})(${JSON.stringify(detail)})`
}
function readNcssPage(detail: boolean): PageSnapshot {
  const visible = (e: Element) => {
    if (!e.getBoundingClientRect().width) return false
    for (let p: Element | null = e; p; p = p.parentElement) {
      const s = getComputedStyle(p)
      if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false
    }
    return true
  }
  const currentJob = (e: Element) =>
    visible(e) && !e.closest('aside,.modal,[role="dialog"],.recommend,.recommendation')
  const text = (selector: string) =>
    [...document.querySelectorAll(selector)]
      .filter(currentJob)
      .map((e) => (e.textContent ?? '').trim())
      .find(Boolean) ?? ''
  const flags = (selector: string) =>
    [...document.querySelectorAll(selector)].map((e) => (e.textContent ?? '').trim())
  const loginFlags = flags('#mask4'),
    studentFlags = flags('#maskUser')
  const headings = [...document.querySelectorAll('h1,h2,.captcha,.verify,.error-message')]
    .filter((e) => visible(e) && !e.closest('.jobdetail-box,.modal'))
    .map((e) => e.textContent ?? '')
    .join(' ')
  const challenge =
    /captcha|verify|security-check/i.test(location.pathname) ||
    /安全验证|人机验证|请完成验证|访问过于频繁/.test(headings)
  const authenticated =
    !challenge &&
    loginFlags.length > 0 &&
    studentFlags.length > 0 &&
    loginFlags.every((v) => v === 'true') &&
    studentFlags.every((v) => v === 'true')
  const login =
    !challenge &&
    !authenticated &&
    (location.hostname === 'account.chsi.com.cn' ||
      /\/student\/signin\.html/.test(location.pathname) ||
      loginFlags.includes('false') ||
      studentFlags.includes('false'))
  const offline =
    detail &&
    !login &&
    !challenge &&
    !!text('.job-status,.jobdetail-notfound,h1,h2') &&
    /^(?:该|此)?(?:职位|岗位)(?:已下架|已关闭|已失效|已过期|不存在)[。！!\s]*$/.test(
      text('.job-status,.jobdetail-notfound,h1,h2'),
    )
  const data: PageSnapshot['detail'] = {}
  if (detail && !login && !challenge && !offline && document.querySelector('#jobName')) {
    data.title = text('#jobName')
    data.company = text('#realCorpName')
    data.city = text('.job .site-tag')
    data.salary = text('.job .salary li:first-child span')
    const terms = [...document.querySelectorAll('.job .salary li')]
      .filter(currentJob)
      .map((e) => (e.textContent ?? '').trim())
    data.education =
      terms.find((v) =>
        /^(?:不限|学历不限|专科|本科|硕士|博士|研究生|大专|中专|高中)(?:及以上|以上)?$/.test(v),
      ) ?? ''
    const employment = text('.job .work:first-child li:nth-child(2) span')
    data.employment = ['全职', '兼职', '实习'].includes(employment) ? employment : ''
    data.jd = [...document.querySelectorAll('.jobdetail-box .mainContent')]
      .filter(currentJob)
      .map((e) => ((e as HTMLElement).innerText || e.textContent || '').trim())
      .filter(Boolean)
      .join('\n\n')
    data.detailRead = !!data.jd && !/展开全部|展开更多|登录后查看/.test(data.jd)
  }
  return { url: location.href, authenticated, login, challenge, offline, detail: data }
}
export function ncssLoginUrl(value: string): boolean {
  try {
    const u = new URL(value)
    if (u.protocol !== 'https:' || u.username || u.password || u.port || value.length > 10240)
      return false
    if (u.hostname === 'job.ncss.cn') return /^\/student\//.test(u.pathname)
    if (u.hostname === 'account.chsi.com.cn') return /^\/(?:passport\/|account\/)/.test(u.pathname)
    return u.hostname === 'open.weixin.qq.com' && u.pathname === '/connect/qrconnect'
  } catch {
    return false
  }
}
export const ncssVerification: VerificationPolicy = {
  acceptsUrl: (value) => (value && ncssLoginUrl(value) ? value : null),
  allowsNavigation: ncssLoginUrl,
  referrer: 'https://job.ncss.cn/',
  pageScript: () =>
    `(()=>{if(!document.body||!document.body.children.length)return 'blank';if(document.readyState==='loading')return 'loading';return 'challenge'})()`,
}
