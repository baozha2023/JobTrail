import catalog from '../../../../shared/discovery-cities/ncss.json'
import { createCityLookup } from '../../../../shared/discovery-city-catalog'
import {
  SourceError,
  type NativeQuery,
  type PlatformSearch,
  type SearchRequest,
  type SearchTransport,
  type SourceBatch,
} from '../../adapter'
import { ncssOrigin, ncssResponse } from './parsing'

const cities = createCityLookup(catalog)
export function ncssParameters(query: NativeQuery, page: number): URLSearchParams {
  const city = query.city ? cities.find(query.city) : undefined
  if (query.city && !city) throw new SourceError('unsupported_city')
  return new URLSearchParams({
    jobType: '',
    areaCode: city?.code ?? '',
    jobName: query.keyword,
    monthPay: '',
    industrySectors: '',
    property: '',
    categoryCode: '',
    memberLevel: '',
    recruitType: '0',
    offset: String(page),
    limit: '10',
    keyUnits: '',
    degreeCode: '',
    sourcesName: '0',
    sourcesType: '',
  })
}
export function ncssRequest(
  request: SearchRequest,
  query: NativeQuery,
  page: number,
): boolean | null {
  const url = new URL(request.url)
  if (
    url.origin !== ncssOrigin ||
    url.pathname !== '/student/jobs/jobslist/ajax/' ||
    request.method !== 'GET'
  )
    return null
  const expected = ncssParameters(query, page),
    actual = url.searchParams
  return (
    [...actual.keys()].every(
      (key) => (key === '_' || expected.has(key)) && actual.getAll(key).length === 1,
    ) && [...expected].every(([key, value]) => actual.get(key) === value)
  )
}
export class NcssSearch implements PlatformSearch {
  private pageNumber = 1
  private loaded = false
  private pending?: SourceBatch
  constructor(
    private page: SearchTransport,
    private query: NativeQuery,
  ) {}
  private async prepare(signal: AbortSignal) {
    await this.page.load(`${ncssOrigin}/student/jobs/index.html`, signal)
    await this.page.until(
      () =>
        this.page.evaluate<boolean>(
          '!!(window.pageInit&&window.parameter&&document.querySelector("#jobSearch"))',
          signal,
        ),
      signal,
    )
    // The page can show a selected logo while its initial request still submits
    // all sources. Click the official controls and correlate the final Search.
    await this.page.click('.sourceList[data-sourcesName="0"]', null, signal)
    await this.page.click('.recruitType[data-type="0"]', null, signal)
    await this.page.click('#jobTypeSelect', null, signal)
    await this.page.click('#jobTypeList li[data-value=""] a', null, signal)
    await this.page.click('.cascader-input', null, signal)
    const city = this.query.city ? cities.find(this.query.city) : undefined
    if (!city) await this.page.click('.hot-citys-sp[data-area=""]', null, signal)
    else {
      const province = city.code.slice(0, 2)
      await this.page.click(
        `.cascader-dl .menu-item[data-key="0"][data-value="${province}"]`,
        null,
        signal,
      )
      if (city.code.length === 4)
        await this.page.click(
          `.cascader-dl .menu-item[data-key="1"][data-value="${city.code}00"]`,
          null,
          signal,
        )
      else if (city.code.length === 6) {
        await this.page.click(
          `.cascader-dl .menu-item[data-key="1"][data-value="${city.parentCode}"]`,
          null,
          signal,
        )
        await this.page.click(
          `.cascader-dl .menu-item[data-key="2"][data-value="${city.code}"]`,
          null,
          signal,
        )
      }
    }
    await this.page.fill('.searchKeywords', this.query.keyword, signal)
    await this.page.until(
      () => this.page.evaluate<boolean>('!!window.jQuery&&jQuery.active===0', signal),
      signal,
      'query_preparation_incomplete',
    )
    this.loaded = true
  }
  async read(signal: AbortSignal): Promise<SourceBatch> {
    signal.throwIfAborted()
    if (this.pending) return this.pending
    ncssParameters(this.query, this.pageNumber)
    if (!this.loaded) await this.prepare(signal)
    const result = await this.page.response(
      {
        request: (request) => ncssRequest(request, this.query, this.pageNumber),
        response: (value) => ncssResponse(value, this.pageNumber),
      },
      () => this.page.click(this.pageNumber === 1 ? '#jobSearch' : '#page a.next', null, signal),
      signal,
    )
    await this.page.guard(signal)
    signal.throwIfAborted()
    this.pending = {
      ...result,
      submitted: { keyword: this.query.keyword, cityCode: cities.code(this.query.city) ?? '' },
    }
    return this.pending
  }
  commit(batch: SourceBatch) {
    if (batch !== this.pending) throw new Error('Uncommitted source batch')
    this.pending = undefined
    this.pageNumber++
  }
}
