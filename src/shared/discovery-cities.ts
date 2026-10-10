import boss from './discovery-cities/boss.json'
import liepin from './discovery-cities/liepin.json'
import zhilian from './discovery-cities/zhilian.json'
import wuyou from './discovery-cities/wuyou.json'
import iguopin from './discovery-cities/iguopin.json'
import shixiseng from './discovery-cities/shixiseng.json'
import type { JobPlatform } from './job-discovery'
import { createCityLookup, intersectCityCatalogs, type CityCatalog } from './discovery-city-catalog'

// Renderer-facing metadata registry. Main obtains capabilities from each adapter.
export const cityCatalogs: Readonly<Record<JobPlatform, CityCatalog>> = {
  boss,
  liepin,
  zhilian,
  wuyou,
  iguopin,
  shixiseng,
}
const indexes = new Map(
  (Object.keys(cityCatalogs) as JobPlatform[]).map((p) => [p, createCityLookup(cityCatalogs[p])]),
)

export function platformCities(platform: JobPlatform) {
  return indexes.get(platform)!.all
}
export function commonCities(platforms: readonly JobPlatform[]) {
  return intersectCityCatalogs([...new Set(platforms)].map(platformCities))
}
export function platformCity(platform: JobPlatform, name: string) {
  return indexes.get(platform)!.find(name)
}
export function cityCode(platform: JobPlatform, city: string): string | undefined {
  return platformCity(platform, city)?.code
}
export function cityName(platform: JobPlatform, code: string): string {
  return indexes.get(platform)!.name(code)
}
