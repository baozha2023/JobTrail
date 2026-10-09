import type { JobPlatform } from '../../shared/job-discovery'
import { platformAdapter } from './adapter-registry'
import { allowedUrl, canonicalUrl, identityFor } from './identity'

export function allowedPage(platform: JobPlatform, value: string): boolean {
  return allowedUrl(platformAdapter(platform).domains, value)
}
export function canonicalJob(platform: JobPlatform, value: string) {
  return canonicalUrl(platformAdapter(platform), value)
}
export function jobIdentity(platform: JobPlatform, url: string, externalId?: string) {
  return identityFor(platformAdapter(platform), url, externalId)
}
