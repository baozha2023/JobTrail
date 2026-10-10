// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { platformAdapter } from '../src/main/discovery/adapter-registry'
import type { AccountTransport } from '../src/main/discovery/adapter'
import type { PageSnapshot } from '../src/main/discovery/extraction'

// Minimal, anonymized account controls observed on the official sites on 2026-10-10.
// Execute the real extraction script instead of supplying an authenticated snapshot.
const accounts = [
  {
    platform: 'liepin',
    url: 'https://www.liepin.com/',
    html: '<ul class="header-quick-menu-login"><li><span class="header-quick-menu-username">测试用户</span><img class="header-quick-menu-user-photo"></li></ul>',
  },
  {
    platform: 'zhilian',
    url: 'https://www.zhaopin.com/',
    html: '<div class="home-header__c-login"><div class="c-login__top"><span class="c-login__top__name">测试用户</span><span class="c-login__top__photo"><img class="c-login__top__img"></span></div><ul style="display:none"><li><a>退出</a></li></ul></div>',
  },
  {
    platform: 'wuyou',
    url: 'https://we.51job.com/pc/search',
    html: '<div class="user-info el-popover__reference"><a><div class="img-wrap"><img></div><span class="name-span">测试用户</span></a></div><div class="user-popover" style="display:none"><a>退出登录</a></div>',
  },
] as const

function pageTransport(html: string) {
  document.documentElement.innerHTML = `<head><title>招聘网站</title></head><body>${html}</body>`
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 400,
    height: 200,
  } as DOMRect)
  const page = vi.fn(
    async (_url: string, script: string): Promise<PageSnapshot> => window.eval(script),
  )
  const transport: AccountTransport = {
    page,
    cookie: vi.fn(),
    json: vi.fn(),
  }
  return { page, transport }
}
afterEach(() => vi.restoreAllMocks())

it.each(accounts)(
  'recognizes the current $platform account controls at its account entry',
  async ({ platform, url, html }) => {
    const { page, transport } = pageTransport(html)
    expect(await platformAdapter(platform).checkSession(transport)).toBe('authenticated')
    expect(page).toHaveBeenCalledExactlyOnceWith(url, expect.any(String))
  },
)

it.each(accounts)(
  'does not accept hidden $platform account controls',
  async ({ platform, html }) => {
    const { transport } = pageTransport(`<div style="display:none">${html}</div>`)
    expect(await platformAdapter(platform).checkSession(transport)).toBe('unknown')
  },
)

it.each(accounts)(
  'does not accept unrelated avatars or hidden logout menus for $platform',
  async ({ platform }) => {
    const { transport } = pageTransport(
      '<aside><img class="user-avatar"><img class="userAvatar"></aside><div style="display:none"><a href="/logout">退出登录</a></div>',
    )
    expect(await platformAdapter(platform).checkSession(transport)).toBe('unknown')
  },
)

it.each(accounts)(
  'prioritizes visible login and verification over $platform account controls',
  async ({ platform, html }) => {
    const { transport } = pageTransport(html + '<input type="password">')
    expect(await platformAdapter(platform).checkSession(transport)).toBe('login_required')
    document.body.insertAdjacentHTML('beforeend', '<h1>安全验证</h1>')
    expect(await platformAdapter(platform).checkSession(transport)).toBe('challenge')
  },
)

it('does not accept an empty 51job account placeholder', async () => {
  const { transport } = pageTransport(
    '<div class="user-info"><span class="name-span"></span></div>',
  )
  expect(await platformAdapter('wuyou').checkSession(transport)).toBe('unknown')
})

it('recognizes the visible 51job phone login form without requiring a password input', async () => {
  const { transport } = pageTransport(
    '<div class="login-card"><div class="phone-login-form"><input type="tel"><input placeholder="验证码"></div><div class="account-login-form" style="display:none"><input type="password"></div></div>',
  )
  expect(await platformAdapter('wuyou').checkSession(transport)).toBe('login_required')
})
