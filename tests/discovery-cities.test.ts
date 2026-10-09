// @vitest-environment jsdom
import { platformAdapter } from '../src/main/discovery/adapter-registry'
import type { WebContents } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  discoveryCities,
  discoveryCity,
  platformCity,
  discoveryCityNames,
} from '../src/shared/discovery-cities'
import { platforms } from '../src/shared/job-discovery'
import { cityCode, cityName } from '../src/shared/discovery-cities'
import { BossSearch } from '../src/main/discovery/adapters/boss'
import { LiepinSearch } from '../src/main/discovery/adapters/liepin'
import { ZhilianSearch } from '../src/main/discovery/adapters/zhilian'
import { WuyouSearch } from '../src/main/discovery/adapters/wuyou'
import { SearchPage } from '../src/main/discovery/search-page'

describe('official discovery city catalog', () => {
  it('stores only final cities with a complete mapping for every platform', () => {
    expect(discoveryCityNames).toHaveLength(363)
    expect(discoveryCityNames).not.toContain('三沙')
    expect(discoveryCityNames).toContain('天津')
    for (const city of discoveryCities) {
      expect(Object.keys(city.platforms).sort()).toEqual([...platforms].sort())
    }
  })
  it('covers all provincial groups with unique, reversible platform identities', () => {
    expect(discoveryCities).toHaveLength(363)
    expect(new Set(discoveryCities.map((c) => c.province)).size).toBe(34)
    expect(new Set(discoveryCities.map((c) => c.name)).size).toBe(discoveryCities.length)
    for (const platform of platforms) {
      const cities = discoveryCityNames
      expect(cities).not.toContain('全国')
      const codes = cities.map((name) => cityCode(platform, name))
      expect(new Set(codes).size).toBe(codes.length)
      for (const name of cities) {
        const code = cityCode(platform, name)!
        expect(code).toMatch(/^\d+$/)
        expect(cityName(platform, code)).toBe(name)
      }
    }
  })
  it.each([
    ['zhilian', '广州', '763'],
    ['zhilian', '杭州', '653'],
    ['zhilian', '南京', '635'],
    ['zhilian', '武汉', '736'],
    ['zhilian', '西安', '854'],
    ['wuyou', '广州', '030200'],
    ['wuyou', '西安', '200200'],
    ['wuyou', '重庆', '060000'],
  ] as const)('uses the official %s code for %s', (platform, name, code) => {
    expect(cityCode(platform, name)).toBe(code)
  })
  it('preserves leading zeros, optional municipal suffixes and prefecture identity', () => {
    expect(cityCode('liepin', '天津市')).toBe('030')
    expect(discoveryCity('天津')).toBe(discoveryCity('天津市'))
    expect(platformCity('liepin', '恩施土家族苗族自治州')).toMatchObject({
      code: '170180',
      name: '恩施州',
    })
    expect(cityCode('zhilian', '北屯市')).toBeUndefined() // 北屯区 in Taiwan is not 北屯市 in Xinjiang.
    expect(cityCode('boss', '')).toBeUndefined()
    expect(cityCode('boss', '全国')).toBeUndefined()
  })
})

describe('official city control paths', () => {
  beforeEach(() => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      return { width: this.hasAttribute('hidden') ? 0 : 100, height: 30 } as DOMRect
    })
  })
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  function page(html: string) {
    document.body.innerHTML = html
    const transport = new SearchPage(
      {
        isDestroyed: () => false,
        executeJavaScript: async (script: string) => (0, eval)(script),
        sendInputEvent: () => {},
      } as unknown as WebContents,
      platformAdapter('boss').pageScript(false),
    )
    vi.spyOn(transport, 'load').mockResolvedValue(undefined)
    vi.spyOn(transport, 'fill').mockResolvedValue(undefined)
    vi.spyOn(transport, 'response').mockImplementation(async (_reader, action) => {
      await action()
      return {
        jobs: [],
        sourceIds: [],
        page: 1,
        rawCount: 0,
        duplicateCount: 0,
        rejectedCount: 0,
        hasMore: false,
        evidence: 'search_response',
        submitted: { cityCode: '' },
      } as never
    })
    return transport
  }
  function click(selector: string, handler: () => void) {
    document.querySelector(selector)!.addEventListener('click', handler)
  }
  it('BOSS selects a non-hot city through its official alphabet group', async () => {
    const transport =
      page(`<button class="btn-search"></button><div class="job-search-form"><input></div>
      <span class="cur-city-label">北京</span><button class="city-label"></button>
      <div class="city-select-dialog"><ul class="city-list-hot"><li>北京</li></ul>
      <ul class="city-char-list"><li>ABCD</li><li id="letters">WXYZ</li></ul><div class="list-select-list"></div></div>`)
    const selected = vi.fn()
    click('#letters', () => {
      document.querySelector('.list-select-list')!.innerHTML = '<a>温州</a>'
      click('.list-select-list a', selected)
    })
    await new BossSearch(transport, { keyword: 'Java', city: '温州' }).read(
      AbortSignal.timeout(2000),
    )
    expect(selected).toHaveBeenCalledOnce()
  })
  it('Liepin enters the province, then confirms the entire city rather than a district', async () => {
    const transport =
      page(`<div class="search-job-bar-container"><span>搜索</span></div><li data-selector="filter-option-item" data-key="dq" data-code="010">北京</li>
      <div id="filter-option-other-city"><span>其他</span></div>
      <ul class="ant-city-menu-list"><li data-code="070">浙江</li></ul><div class="data-list"></div>`)
    const selected = vi.fn()
    click('[data-code="070"]', () => {
      document.querySelector('.data-list')!.innerHTML =
        '<li id="code_070040"><span class="ant-tag">温州</span></li>'
      click('#code_070040 .ant-tag', () => {
        document.querySelector('.data-list')!.innerHTML =
          '<span class="ant-tag">全温州</span><span class="ant-tag">鹿城区</span>'
        click('.data-list .ant-tag', selected)
      })
    })
    expect(cityCode('liepin', '温州')).toBe('070040')
    await new LiepinSearch(transport, { keyword: 'Java', city: '温州' }).read(
      AbortSignal.timeout(2000),
    )
    expect(selected).toHaveBeenCalledOnce()
  })
  it('Zhilian distinguishes Jilin province from Jilin city in separate columns', async () => {
    const transport =
      page(`<input class="query-sug__input"><div class="filter-region-box"><button class="filter-select-box__trigger"></button></div>
      <div class="s-dialog" aria-label="请选择地区"><ul class="s-cascader__options"><li class="s-cascader__option-content">吉林</li></ul>
      <ul class="s-cascader__options" id="city-column"></ul><div id="districts"></div></div>`)
    const selected = vi.fn()
    click('.s-cascader__option-content', () => {
      document.querySelector('#city-column')!.innerHTML =
        '<li class="s-cascader__option-content">吉林市</li>'
      click('#city-column li', () => {
        document.querySelector('#districts')!.innerHTML =
          '<li class="s-checkbutton__item">全吉林市</li><li class="s-checkbutton__item">昌邑区</li>'
        click('.s-checkbutton__item', selected)
      })
    })
    await new ZhilianSearch(transport, { keyword: 'Java', city: '吉林' }).read(
      AbortSignal.timeout(2000),
    )
    expect(selected).toHaveBeenCalledOnce()
  })
  it('51job clears the previous selection and selects a city outside the hot list', async () => {
    const transport =
      page(`<div class="c_area"><a class="ch on">北京</a><button class="allcity"></button></div><input class="shadedword">
      <div class="el-dialog"><div class="selected_list_wrapper"><div class="selected_list_wrapper_tag"><span class="el-tag">北京<i class="el-tag__close"></i></span></div></div>
      <span class="resumeDialog__top-city">上海</span><span class="resumeDialog__right-city">温州</span><button class="confirm_button"></button></div>`)
    click('.el-tag__close', () => {
      document.querySelector('.selected_list_wrapper_tag')!.innerHTML = ''
    })
    click('.resumeDialog__right-city', () => {
      document.querySelector('.selected_list_wrapper_tag')!.innerHTML =
        '<span class="el-tag">温州</span>'
    })
    const confirm = vi.fn()
    click('.confirm_button', confirm)
    await new WuyouSearch(transport, { keyword: 'Java', city: '温州' }).read(
      AbortSignal.timeout(2000),
    )
    expect(confirm).toHaveBeenCalledOnce()
    expect(document.querySelector('.selected_list_wrapper_tag')!.textContent).toBe('温州')
  })
})
