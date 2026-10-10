// @vitest-environment jsdom
import { platformAdapter } from '../src/main/discovery/adapter-registry'
import type { WebContents } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  commonCities,
  cityCatalogs,
  platformCities,
  platformCity,
} from '../src/shared/discovery-cities'
import { createCityLookup, intersectCityCatalogs } from '../src/shared/discovery-city-catalog'
import { platforms } from '../src/shared/job-discovery'
import { cityCode, cityName } from '../src/shared/discovery-cities'
import { BossSearch } from '../src/main/discovery/adapters/boss'
import { LiepinSearch } from '../src/main/discovery/adapters/liepin'
import { ZhilianSearch } from '../src/main/discovery/adapters/zhilian'
import { WuyouSearch } from '../src/main/discovery/adapters/wuyou'
import { SearchPage } from '../src/main/discovery/search-page'

describe('official discovery city catalog', () => {
  it('keeps adapter capabilities and renderer metadata aligned for every city and alias', () => {
    for (const platform of platforms) {
      const lookup = platformAdapter(platform).cities
      expect(lookup.all).toEqual(platformCities(platform))
      for (const city of lookup.all) {
        expect(lookup.name(city.code)).toBe(city.name)
        for (const name of [city.name, ...(city.aliases ?? [])]) {
          expect(lookup.find(name)).toEqual(platformCity(platform, name))
          expect(lookup.code(name)).toBe(cityCode(platform, name))
        }
      }
      expect(lookup.find('不存在的城市')).toBeUndefined()
      expect(lookup.name('unknown-code')).toBe('unknown-code')
    }
  })
  it('keeps overlapping native codes and ambiguous aliases local to their catalog', () => {
    const first = {
      name: '甲',
      province: '甲',
      initial: 'J',
      platformName: '甲市',
      code: '1',
      aliases: ['旧称'],
    }
    const second = { ...first, name: '乙', platformName: '乙市', initial: 'Y' }
    const a = createCityLookup({ verifiedAt: '', sources: [], cities: [first] })
    const b = createCityLookup({ verifiedAt: '', sources: [], cities: [second] })
    expect(a.name('1')).toBe('甲')
    expect(b.name('1')).toBe('乙')
    expect(a.find('旧称')?.name).toBe('甲')
    expect(b.find('旧称')?.name).toBe('乙')
    const ambiguous = createCityLookup({
      verifiedAt: '',
      sources: [],
      cities: [first, { ...second, code: '2' }],
    })
    expect(ambiguous.find('旧称')).toBeUndefined()
    expect(a.find('旧称')?.name).toBe('甲')
  })
  it('preserves independent platform coverage instead of truncating to the intersection', () => {
    expect(commonCities([])).toEqual([])
    expect(commonCities(platforms).map((c) => c.name)).toContain('三沙')
    expect(commonCities(['boss']).map((c) => c.name)).toContain('白杨')
    expect(commonCities(['boss', 'liepin']).map((c) => c.name)).not.toContain('白杨')
    expect(commonCities(['wuyou']).map((c) => c.name)).toContain('昆山')
    expect(commonCities(['liepin', 'wuyou']).map((c) => c.name)).toContain('雄安')
    expect(commonCities(platforms).map((c) => c.name)).not.toContain('雄安')
    expect(commonCities(['boss', 'liepin'])).toEqual(commonCities(['liepin', 'boss', 'boss']))
    expect(
      commonCities(platforms)
        .slice(0, 4)
        .map((c) => c.name),
    ).toEqual(['北京', '上海', '天津', '重庆'])
  })
  it('covers all provincial groups with unique, reversible platform identities', () => {
    const labels = new Map<string, { province: string; initial: string }>()
    for (const platform of platforms) {
      const catalog = cityCatalogs[platform]
      expect(catalog.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(catalog.sources.length).toBeGreaterThan(0)
      const cities = platformCities(platform)
      expect(new Set(cities.map((c) => c.province)).size).toBe(34)
      expect(new Set(cities.map((c) => c.name)).size).toBe(cities.length)
      expect(cities.map((c) => c.name)).not.toContain('全国')
      expect(commonCities([platform]).map((c) => c.name)).toEqual(cities.map((c) => c.name))
      const codes = cities.map(({ name }) => cityCode(platform, name))
      expect(new Set(codes).size).toBe(codes.length)
      for (const { name, province, initial, platformName, aliases } of cities) {
        const label = { province, initial }
        if (labels.has(name)) expect(label).toEqual(labels.get(name))
        else labels.set(name, label)
        expect(initial).toMatch(/^[A-Z]$/)
        expect(platformName).not.toBe('')
        const code = cityCode(platform, name)!
        if (platform === 'shixiseng') expect(code).toBe(platformName)
        else expect(code).toMatch(/^\d+(?:\.\d+)*$/)
        expect(cityName(platform, code)).toBe(name)
        // Hsinchu/Chiayi cities and counties are separate official choices.
        if (!['新竹县', '嘉义县'].includes(name))
          expect(name).not.toMatch(/(?:自治区|自治州|自治县|地区|新区|开发区|省|市|县|盟)$/)
        for (const alias of aliases ?? []) expect(cityCode(platform, alias)).toBe(code)
      }
    }
    expect(commonCities([...platforms].reverse())).toEqual(commonCities(platforms))
  })
  it('intersects only selected catalogs using exact canonical name strings', () => {
    const a = { name: '甲城', province: '甲', initial: 'J' }
    const b = { name: '乙城', province: '乙', initial: 'Y' }
    const registry = { first: [a], second: [a, b], future: [b] }
    expect(intersectCityCatalogs([registry.first, registry.second])).toEqual([a])
    expect(intersectCityCatalogs([registry.first, registry.second, registry.future])).toEqual([])
    expect(intersectCityCatalogs([registry.first, []])).toEqual([])
    expect(intersectCityCatalogs([[a], [{ ...a, province: '另一分组' }]])).toEqual([a])
    expect(intersectCityCatalogs([[a], [{ ...a, name: '甲城市' }]])).toEqual([])
  })
  it('does not use website names, aliases, codes or administrative hierarchy for intersection', () => {
    const city = {
      name: '恩施',
      province: '湖北',
      initial: 'E',
      code: 'same-code',
      platformName: '恩施州',
      aliases: ['恩施土家族苗族自治州'],
    }
    for (const name of ['恩施州', '恩施土家族苗族自治州', '恩施市', ' 恩施 ']) {
      expect(intersectCityCatalogs([[city], [{ ...city, name }]])).toEqual([])
    }
    expect(
      intersectCityCatalogs([
        [{ name: '台湾', province: '台湾', initial: 'T' }],
        [{ name: '台北', province: '台湾', initial: 'T' }],
      ]),
    ).toEqual([])
  })
  it('uses the new platforms canonical source names while retaining their native search values', () => {
    for (const platform of ['iguopin', 'shixiseng'] as const) {
      const names = platformCities(platform).map((city) => city.name)
      for (const name of ['恩施', '锡林郭勒', '大理', '巴音郭楞', '北屯']) {
        expect(names).toContain(name)
        expect(commonCities(['boss', platform]).map((city) => city.name)).toContain(name)
      }
    }
    expect(platformCity('iguopin', '雄安')).toMatchObject({
      name: '雄安',
      platformName: '雄安新区',
      code: '000000.130000.131200',
    })
    expect(platformCity('shixiseng', '平潭')).toMatchObject({
      name: '平潭',
      platformName: '平潭综合实验区',
      code: '平潭综合实验区',
    })
    for (const name of ['新竹', '嘉义']) {
      expect(cityCode('shixiseng', name)).toBe(name)
      expect(cityCode('shixiseng', name + '县')).toBe(name + '县')
      expect(commonCities(['shixiseng']).map((city) => city.name)).toEqual(
        expect.arrayContaining([name, name + '县']),
      )
    }
    const oldSites = ['boss', 'liepin', 'zhilian', 'wuyou'] as const
    const original = commonCities(oldSites)
    expect(commonCities([...oldSites, 'iguopin'])).toEqual(original)
    expect(commonCities([...oldSites, 'shixiseng'])).toEqual(
      original.filter((city) => platformCities('shixiseng').some((c) => c.name === city.name)),
    )
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
    expect(platformCity('liepin', '天津')).toBe(platformCity('liepin', '天津市'))
    expect(platformCity('liepin', '恩施土家族苗族自治州')).toMatchObject({
      name: '恩施',
      code: '170180',
      platformName: '恩施州',
    })
    expect(commonCities(platforms).map((c) => c.name)).toContain('恩施')
    expect(commonCities(platforms).map((c) => c.name)).not.toContain('恩施州')
    expect(platformCity('zhilian', '北屯市')).toMatchObject({ code: '932', province: '新疆' })
    expect(cityCode('zhilian', '北屯区')).toBeUndefined()
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
