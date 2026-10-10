import { describe, expect, it, vi } from 'vitest'
import { deflateSync } from 'node:zlib'
import {
  shixisengAdapter,
  shixisengAccount,
  shixisengRequest,
  shixisengResponse,
  ShixisengSearch,
} from '../src/main/discovery/adapters/shixiseng'
import type { SearchTransport, SourceBatch } from '../src/main/discovery/adapter'
import { salaryExclusion } from '../src/main/discovery/normalization'
import { shixisengFont } from '../src/main/discovery/adapters/shixiseng/font'

const item = {
  uuid: 'inn_900719925474099312345',
  name: '运营实习生',
  cname: '公司',
  city: '北京、上海',
  minsal: '150',
  maxsal: '200',
  talkFace: '1',
  degree: '本科',
  day: '3',
  month_num: '6',
  i_tags: ['实习证明'],
}
const result = (data: unknown[] = [item], total = 60) => ({
  code: 100,
  msg: { data, total, pageNumber: 20 },
})
function request(query: Record<string, string> = {}) {
  return {
    url:
      'https://www.shixiseng.com/app/interns/search/v2?' +
      new URLSearchParams({
        keyword: '运营',
        type: 'intern',
        city: '全国',
        page: '1',
        salary: '-0',
        ...query,
      }),
    method: 'GET',
    body: '',
  }
}
describe('Shixiseng source contract', () => {
  it('admits only the exact internship query, city and page', () => {
    const q = { keyword: '运营', city: '' }
    expect(shixisengRequest(request(), q, 1)).toBe(true)
    const mismatches: Record<string, string>[] = [
      { type: 'school' },
      { keyword: '产品' },
      { page: '2' },
      { city: '北京' },
      { area: '海淀区' },
      { salary: '100-150' },
      { intern_type: 'xz' },
      { months: '3' },
    ]
    for (const query of mismatches) expect(shixisengRequest(request(query), q, 1)).toBe(false)
    expect(shixisengRequest(request({ city: '北京' }), { ...q, city: '北京' }, 1)).toBe(true)
    expect(
      shixisengRequest(
        { ...request(), url: 'https://www.shixiseng.com/api/v2/recommend/intern' },
        q,
        1,
      ),
    ).toBeNull()
  })
  it('preserves string identities, multiple cities and daily salary without inventing experience', () => {
    const batch = shixisengResponse(result(), 1, ''),
      job = batch.jobs[0]
    expect(job).toMatchObject({
      externalId: item.uuid,
      city: '北京、上海',
      salary: '150-200/天',
      experience: '',
      employment: '实习',
      detailRead: false,
    })
    expect(job.jd).toContain('每周到岗：3天')
    expect(job.jd).toContain('实习时长：6个月')
    expect(
      salaryExclusion(job.salary, { keyword: '运营', city: '', platforms: ['shixiseng'] }),
    ).toBeNull()
    expect(
      salaryExclusion(job.salary, {
        keyword: '运营',
        city: '',
        platforms: ['shixiseng'],
        salaryMin: 1000,
      }),
    ).toBe('day')
    expect(shixisengAdapter.canonicalJob(new URL(job.url + '?pcm=tracking'))?.externalId).toBe(
      item.uuid,
    )
    expect(
      shixisengAdapter.canonicalJob(new URL('https://www.shixiseng.com/com/com_123')),
    ).toBeNull()
  })
  it('decodes only verified font mappings and never saves private-use garbage', () => {
    const encoded = { ...item, name: '实习&#xf100', minsal: '&#xe001;50', maxsal: '&#xe002;00' }
    expect(
      shixisengResponse(result([encoded]), 1, '', { '\uf100': '生', '\ue001': '1', '\ue002': '2' })
        .jobs[0],
    ).toMatchObject({ title: '实习生', salary: '150-200/天' })
    expect(() => shixisengResponse(result([encoded]), 1, '')).toThrow('response_contract_changed')
  })
  it('distinguishes empty, malformed, ads, login and challenge responses', () => {
    expect(shixisengResponse(result([], 0), 1, '')).toMatchObject({ jobs: [], hasMore: false })
    expect(shixisengResponse(result([item, { uuid: 123, title: '广告' }]), 1, '')).toMatchObject({
      rawCount: 2,
      rejectedCount: 1,
    })
    for (const value of [
      { code: 100, msg: {} },
      { code: 100, msg: { data: [], total: '0', pageNumber: 20 } },
    ])
      expect(() => shixisengResponse(value, 1, '')).toThrow()
    expect(() => shixisengResponse({ code: 101 }, 1, '')).toThrow('login_required')
    expect(() => shixisengResponse({ code: 403 }, 1, '')).toThrow('challenge')
  })
  it('advances pages only after committing the returned batch and retains pending data', async () => {
    let reads = 0
    const click = vi.fn(async () => {}),
      load = vi.fn(async () => {})
    const transport: SearchTransport = {
      load,
      click,
      fill: async () => {},
      guard: async () => {},
      evaluate: async () => {
        throw new Error('unexpected font read')
      },
      until: async () => {
        throw new Error('unexpected wait')
      },
      enter: () => {},
      response: async (reader, action, signal) => {
        await action()
        signal.throwIfAborted()
        reads++
        expect(reader.request(request({ page: String(reads) }))).toBe(true)
        return reader.response(result())
      },
    }
    const search = new ShixisengSearch(transport, { keyword: '运营', city: '' })
    const signal = new AbortController().signal
    for (let p = 1; p <= 3; p++) {
      const batch = await search.read(signal)
      expect(batch.page).toBe(p)
      expect(await search.read(signal)).toBe(batch)
      expect(() => search.commit({ ...batch } as SourceBatch)).toThrow()
      search.commit(batch)
    }
    expect(load).toHaveBeenCalledOnce()
    expect(reads).toBe(3)
    expect(click.mock.calls).toHaveLength(3)
  })
  it('requires an official personal identity; network failures are not logout', async () => {
    const transport = (value: unknown) => ({
      json: async <T>(_url: string, parse: (v: unknown) => T) => parse(value),
    })
    expect(
      await shixisengAccount(transport({ code: 100, msg: { uuid: 'user_test', flag: 'student' } })),
    ).toBe(true)
    for (const value of [
      { code: 101 },
      { code: 100, msg: {} },
      { code: 100, msg: { uuid: 'company_test', flag: 'company' } },
    ])
      expect(await shixisengAccount(transport(value))).toBe(false)
    await expect(shixisengAccount(transport({ code: 100, msg: { name: '昵称' } }))).rejects.toThrow(
      'account_contract_changed',
    )
    await expect(
      shixisengAccount({
        json: async () => {
          throw new Error('network')
        },
      }),
    ).rejects.toThrow('network')
  })
  it('rejects invalid fonts without running their content', async () => {
    await expect(shixisengFont(new ArrayBuffer(50))).rejects.toThrow('font_contract_changed')
  })
  it.each([4, 12])(
    'decodes a compressed WOFF with cmap format %s and rejects inflated length mismatches',
    async (format) => {
      // Synthetic public character mapping: the site rotates code points, so no captured map is used.
      const post = Buffer.alloc(50)
      post.writeUInt32BE(0x00020000, 0)
      post.writeUInt16BE(2, 32)
      post.writeUInt16BE(258, 36)
      post[38] = 5
      post.write('uni31', 39)
      const cmap = Buffer.alloc(44)
      cmap.writeUInt16BE(1, 2)
      cmap.writeUInt16BE(3, 4)
      cmap.writeUInt16BE(format === 4 ? 1 : 10, 6)
      cmap.writeUInt32BE(12, 8)
      cmap.writeUInt16BE(format, 12)
      if (format === 4) {
        cmap.writeUInt16BE(32, 14)
        cmap.writeUInt16BE(4, 18)
        cmap.writeUInt16BE(0xe101, 26)
        cmap.writeUInt16BE(0xffff, 28)
        cmap.writeUInt16BE(0xe101, 32)
        cmap.writeUInt16BE(0xffff, 34)
        cmap.writeUInt16BE((1 - 0xe101) & 0xffff, 36)
        cmap.writeUInt16BE(1, 38)
      } else {
        cmap.writeUInt32BE(28, 16)
        cmap.writeUInt32BE(1, 24)
        cmap.writeUInt32BE(0xe101, 28)
        cmap.writeUInt32BE(0xe101, 32)
        cmap.writeUInt32BE(1, 36)
      }
      const compressed = [deflateSync(cmap), deflateSync(post)]
      const file = Buffer.alloc(84 + compressed[0].length + compressed[1].length)
      file.writeUInt32BE(0x774f4646, 0)
      file.writeUInt16BE(2, 12)
      let offset = 84
      for (const [i, name] of ['cmap', 'post'].entries()) {
        file.write(name, 44 + i * 20)
        file.writeUInt32BE(offset, 48 + i * 20)
        file.writeUInt32BE(compressed[i].length, 52 + i * 20)
        file.writeUInt32BE(i === 0 ? cmap.length : post.length, 56 + i * 20)
        compressed[i].copy(file, offset)
        offset += compressed[i].length
      }
      const buffer = () => Uint8Array.from(file).buffer
      expect(await shixisengFont(buffer())).toEqual({ '\ue101': '1' })
      file.writeUInt32BE(1, 76)
      await expect(shixisengFont(buffer())).rejects.toThrow('font_contract_changed')
    },
  )
})

it.each([
  [
    '三沙',
    ['三沙', '三沙市', '三沙·西沙区', '北京、三沙'],
    ['北京', '上海', '海南省', '三沙路', ''],
  ],
  [
    '北京',
    ['北京', '北京市·海淀区', '北京-朝阳区', '上海、北京', '上海，北京市', '上海/北京', ' 北京市 '],
    ['上海', '北京路', '河北省', '全国', '远程', ''],
  ],
  ['吉林', ['吉林市·船营区', '吉林'], ['吉林省', '长春', '吉林路']],
  ['杭州', ['杭州', '杭州市'], ['杭州湾新区', '杭州路', '上海']],
  ['海南藏族自治州', ['海南藏族自治州·共和县', '海南'], ['海南省', '海口']],
])(
  'filters Shixiseng locations for %s before admission, without losing source identities',
  (city, accepted, excluded) => {
    const locations = [...accepted, ...excluded]
    const source = locations.map((location, index) => ({
      ...item,
      uuid: `inn_city${index}`,
      city: location,
    }))
    const parsed = shixisengResponse(result(source), 1, city)
    expect(parsed.jobs.map((job) => job.city)).toEqual(accepted.map((city) => city.trim()))
    expect(parsed.jobs.every((job) => job.title === item.name)).toBe(true)
    expect(parsed.sourceIds).toHaveLength(locations.length)
    expect(parsed.rawCount).toBe(locations.length)
    expect(parsed.rejectedCount).toBe(0)
    expect(parsed.hasMore).toBe(true)
  },
)

it('keeps unselected-city results and multi-city source text, and checks decoded locations', () => {
  const source = ['上海', '', '全国', '远程', '北京、上海'].map((city, index) => ({
    ...item,
    uuid: `inn_any${index}`,
    city,
  }))
  expect(shixisengResponse(result(source), 1, '').jobs.map((job) => job.city)).toEqual(
    source.map((job) => job.city),
  )
  expect(shixisengResponse(result(), 1, '北京').jobs[0].city).toBe('北京、上海')
  const encoded = [
    { ...item, city: '&#xe001;京' },
    { ...item, uuid: 'inn_foreign', city: '上海' },
  ]
  expect(
    shixisengResponse(result(encoded), 1, '北京', { '\ue001': '北' }).jobs.map((job) => job.city),
  ).toEqual(['北京'])
})

it('distinguishes a fully filtered batch from invalid data or an unsupported city', () => {
  const source = result([{ ...item, city: '上海' }])
  expect(shixisengResponse(source, 1, '三沙')).toMatchObject({
    jobs: [],
    rawCount: 1,
    rejectedCount: 0,
    hasMore: true,
  })
  expect(shixisengResponse(source, 3, '三沙')).toMatchObject({ jobs: [], hasMore: false })
  expect(shixisengResponse(result([], 0), 1, '三沙')).toMatchObject({
    jobs: [],
    sourceIds: [],
    hasMore: false,
  })
  expect(() => shixisengResponse(source, 1, '不存在的城市')).toThrow('unsupported_city')
  expect(() => shixisengResponse(result([{ uuid: 'bad' }]), 1, '三沙')).toThrow(
    'response_contract_changed',
  )
})
