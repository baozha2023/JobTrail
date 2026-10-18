import { pageScript, type PageRules } from '../../extraction'

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
    experience: '.job-detail-wrap .work-year',
  },
  foldedSelector: '.job-detail-infos button,.job-detail-infos .expand',
  excludedSelector: '.job-detail-right-wrap,.recommend-job,.recommend-list,header,footer',
}
export function nowcoderPageScript(detail: boolean): string {
  if (!detail) return pageScript(rules, false)
  return `(()=>{
    const state=${pageScript(rules, true)};
    if(state.login||state.challenge||state.offline)return state;
    const visible=e=>!!e&&e.getBoundingClientRect().width>0&&getComputedStyle(e).visibility!=='hidden';
    const company=document.querySelector('.job-detail-right-wrap .company-card .fs-20');
    if(visible(company))state.detail.company=company.textContent.trim();
    const header=document.querySelector('.job-detail-wrap .extra');
    if(header){const tags=[...header.querySelectorAll('span')].filter(visible).map(e=>e.textContent.trim());
      if(state.detail.employment==='实习')state.detail.recruitment='实习';
      const terms=tags.filter(t=>/天.*周|周.*天|至少.*月|转正/.test(t));
      if(terms.length&&state.detail.jd)state.detail.jd=[...terms,state.detail.jd].join('\\n');
    }
    return state;
  })()`
}
