import { createPinia } from 'pinia'
import { afterEach, expect, it, vi } from 'vitest'
import type { CompanySummary } from '../src/shared/types'
import { useCompaniesStore } from '../src/renderer/stores/companies'

afterEach(() => vi.unstubAllGlobals())

function company(id: number): CompanySummary {
  return {
    id,
    name: `自定义公司 ${id}`,
    aliases: [],
    companyNature: null,
    industryIds: [],
    industryName: null,
    careerUrl: null,
    lastReadAt: null,
    isBuiltin: false,
    isFavorite: false,
    createdAt: 1,
    updatedAt: 1,
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

it('ignores an older company snapshot after a newer refresh completes', async () => {
  const old = deferred<CompanySummary[]>()
  const list = vi
    .fn()
    .mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce([company(2)])
  vi.stubGlobal('window', { zhijiApi: { companies: { list, listNatures: async () => [] } } })
  const store = useCompaniesStore(createPinia())
  const first = store.load()
  await store.load()
  old.resolve([company(1)])
  await first
  expect(store.items).toEqual([company(2)])
})

it('preserves a newly created summary when its refresh fails and an older read returns late', async () => {
  const old = deferred<CompanySummary[]>()
  const failure = new Error('刷新失败')
  const list = vi.fn().mockReturnValueOnce(old.promise).mockRejectedValueOnce(failure)
  vi.stubGlobal('window', { zhijiApi: { companies: { list, listNatures: async () => [] } } })
  const store = useCompaniesStore(createPinia())
  const first = store.load()
  store.items.push(company(9))
  await expect(store.load()).rejects.toBe(failure)
  old.resolve([])
  await first
  expect(store.items).toEqual([company(9)])
})
