import cityCatalog from '../../../../shared/discovery-cities/nowcoder.json'
import { createCityLookup } from '../../../../shared/discovery-city-catalog'
import {
  SourceError,
  type NativeQuery,
  type PlatformSearch,
  type SearchRequest,
  type SearchTransport,
  type SourceBatch,
} from '../../adapter'
import { nowcoderOrigin, nowcoderResponse } from './parsing'

const cities = createCityLookup(cityCatalog)
const endpoint = `${nowcoderOrigin}/np-api/u/job/square-search`
export function nowcoderForm(query: NativeQuery, page: number): string {
  const city = query.city ? cities.find(query.city) : undefined
  if (query.city && !city) throw new SourceError('unsupported_city')
  // Omission is intentional: the official endpoint returns all three recruitment types.
  return new URLSearchParams({
    page: String(page),
    pageSize: '20',
    query: query.keyword,
    jobCity: city?.code ?? '',
    random: 'false',
    recommend: 'false',
    requestFrom: '1',
    order: '0',
    pageSource: '5001',
  }).toString()
}
export function nowcoderRequest(
  request: SearchRequest,
  query: NativeQuery,
  page: number,
): boolean | null {
  if (request.url !== endpoint || request.method !== 'POST') return null
  const actual = new URLSearchParams(request.body),
    expected = new URLSearchParams(nowcoderForm(query, page))
  // Channel initialization may finish after our controlled mixed request. Its
  // typed response must not invalidate the pending mixed response in SearchPage.
  if (actual.has('recruitType')) return null
  return (
    [...actual.keys()].length === [...expected.keys()].length &&
    [...expected].every(
      ([key, value]) => actual.getAll(key).length === 1 && actual.get(key) === value,
    )
  )
}
export class NowcoderSearch implements PlatformSearch {
  private pageNumber = 1
  private loaded = false
  private pending?: SourceBatch
  constructor(
    private page: SearchTransport,
    private query: NativeQuery,
  ) {}
  async read(signal: AbortSignal): Promise<SourceBatch> {
    signal.throwIfAborted()
    if (this.pending) return this.pending
    const body = nowcoderForm(this.query, this.pageNumber)
    if (!this.loaded) {
      await this.page.load(`${nowcoderOrigin}/jobs/school/jobs`, signal)
      this.loaded = true
    }
    // This fixed read-only, same-origin request shares the isolated website Session.
    // CDP's existing bounded response reader owns parsing and query/page correlation.
    const parsed = await this.page.response(
      {
        request: (r) => nowcoderRequest(r, this.query, this.pageNumber),
        response: (value) => nowcoderResponse(value, this.pageNumber),
      },
      async () => {
        const started = await this.page.evaluate<boolean>(
          `(async()=>{
        if(location.origin!==${JSON.stringify(nowcoderOrigin)})return false;
        const response=await fetch(${JSON.stringify(endpoint)},{method:'POST',credentials:'include',redirect:'error',
          headers:{'Content-Type':'application/x-www-form-urlencoded'},body:${JSON.stringify(body)},
          signal:AbortSignal.timeout(20000)});
        if(!response.body)throw new Error('empty_response_body');
        const reader=response.body.getReader();let size=0;
        try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.length;
          if(size>4000000)throw new Error('response_too_large');}}
        finally{await reader.cancel()}
        return true;
      })()`,
          signal,
        )
        if (!started) throw new SourceError('scope_unverified', 'unexpected_search_origin')
      },
      signal,
    )
    await this.page.guard(signal)
    signal.throwIfAborted()
    this.pending = {
      ...parsed,
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
