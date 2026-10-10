export interface DiscoveryCity {
  name: string
  province: string
  initial: string
}
export interface PlatformCity extends DiscoveryCity {
  code: string
  platformName: string
  parentCode?: string
  aliases?: readonly string[]
}
export interface CityCatalog {
  verifiedAt: string
  sources: readonly string[]
  cities: readonly PlatformCity[]
}
export interface CityLookup {
  readonly all: readonly PlatformCity[]
  find(name: string): PlatformCity | undefined
  code(name: string): string | undefined
  name(code: string): string
}

const priority = ['北京', '上海', '天津', '重庆']
const collator = new Intl.Collator('zh-CN')
function compare(a: DiscoveryCity, b: DiscoveryCity): number {
  const rank = (city: DiscoveryCity) => {
    const index = priority.indexOf(city.name)
    return index < 0 ? priority.length : index
  }
  return (
    rank(a) - rank(b) ||
    a.initial.localeCompare(b.initial) ||
    collator.compare(a.name, b.name) ||
    collator.compare(a.province, b.province)
  )
}

/** Pure catalog operations: no platform registry or website-specific behavior. */
export function createCityLookup(catalog: CityCatalog): CityLookup {
  const all = [...catalog.cities].sort(compare)
  const names = new Map<string, PlatformCity | undefined>()
  const codes = new Map(all.map((city) => [city.code, city]))
  for (const city of all) {
    // Explicit source aliases support historical queries, never the intersection.
    for (const alias of [city.name, ...(city.aliases ?? [])]) {
      if (!names.has(alias)) names.set(alias, city)
      else if (names.get(alias) !== city) names.set(alias, undefined)
    }
  }
  const find = (name: string) => names.get(name.trim())
  return {
    all,
    find,
    code: (name) => find(name)?.code,
    name: (code) => codes.get(code)?.name ?? code,
  }
}

/** Names are already unified in source data; intersection is exact string equality. */
export function intersectCityCatalogs(
  catalogs: readonly (readonly DiscoveryCity[])[],
): DiscoveryCity[] {
  const [first, ...rest] = catalogs
  if (!first) return []
  const sets = rest.map((cities) => new Set(cities.map((city) => city.name)))
  return [...new Map(first.map((city) => [city.name, city])).values()]
    .filter((city) => sets.every((set) => set.has(city.name)))
    .map(({ name, province, initial }) => ({ name, province, initial }))
    .sort(compare)
}
