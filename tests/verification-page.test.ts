// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { verificationPageScript } from '../src/main/discovery/adapters/liepin'

function read(html: string) {
  document.documentElement.innerHTML = html
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 300,
    height: 200,
  } as DOMRect)
  return window.eval(verificationPageScript())
}
afterEach(() => vi.restoreAllMocks())
it('rejects the exact Liepin soft 404 despite its mascot and homepage button', () => {
  expect(
    read(
      '<title>猎聘安全中心</title><h1>我们找遍了所有地方</h1><p>此页面似乎不存在</p><img src="mascot"><button>返回首页</button>',
    ),
  ).toBe('not_found')
})
it('requires visible verification controls and waits for an SPA to mount', () => {
  expect(read('<title>猎聘安全中心</title><div id="root"></div>')).toBe('blank')
  expect(read('<title>猎聘安全中心</title><p>正在加载安全验证</p>')).toBe('loading')
  expect(
    read(
      '<title>安全中心-验证码</title><p>请拖动滑块完成验证</p><div class="captcha"><canvas></canvas></div>',
    ),
  ).toBe('challenge')
})
it('does not mistake a home or sign-in page for a verification challenge', () => {
  expect(read('<h1>登录猎聘</h1><input type="password"><button>登录</button>')).toBe('loading')
  expect(read('<h1>猎聘首页</h1><button>搜索岗位</button>')).toBe('loading')
})
