import catalog from './discovery-cities.json'
import type { JobPlatform } from './job-discovery'

export interface PlatformCity {
  code: string
  name: string
  parentCode?: string
}
export interface DiscoveryCity {
  name: string
  province: string
  initial: string
  platforms: Record<JobPlatform, PlatformCity>
}

export const discoveryCities: readonly DiscoveryCity[] = catalog
export const discoveryCityNames: readonly string[] = discoveryCities.map((city) => city.name)
const byName = new Map(discoveryCities.map((city) => [city.name, city]))
// A municipal suffix is optional; autonomous prefectures keep their full identity.
for (const city of discoveryCities) {
  if (city.name.endsWith('市')) byName.set(city.name.slice(0, -1), city)
  else if (!city.name.endsWith('州') && !city.name.endsWith('盟') && !city.name.endsWith('县'))
    byName.set(city.name + '市', city)
}

export function discoveryCity(name: string): DiscoveryCity | undefined {
  return byName.get(name.trim())
}
export function platformCity(platform: JobPlatform, name: string): PlatformCity | undefined {
  return discoveryCity(name)?.platforms[platform]
}

export function cityCode(platform: JobPlatform, city: string): string | undefined {
  return platformCity(platform, city)?.code
}
export function cityName(platform: JobPlatform, code: string): string {
  return discoveryCities.find((city) => city.platforms[platform]?.code === code)?.name ?? code
}
