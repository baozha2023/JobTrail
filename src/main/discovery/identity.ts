import { createHash } from 'node:crypto'
import type { JobIdentityPolicy } from './adapter'

export function allowedUrl(domains: readonly string[], value: string): boolean {
  try {
    const u = new URL(value)
    return (
      u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      (!u.port || u.port === '443') &&
      domains.some((domain) => u.hostname === domain || u.hostname.endsWith('.' + domain))
    )
  } catch {
    return false
  }
}

export function canonicalUrl(policy: JobIdentityPolicy, value: string) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol === 'http:' && (!url.port || url.port === '80')) {
    url.protocol = 'https:'
    url.port = ''
  }
  if (!allowedUrl(policy.domains, url.href)) return null
  const job = policy.canonicalJob(url)
  if (!job || !allowedUrl(policy.domains, job.url) || job.externalId === '') return null
  return job
}

export function identityFor(policy: JobIdentityPolicy, url: string, externalId?: string) {
  const canonical = canonicalUrl(policy, url)
  if (!canonical) throw new Error('Invalid platform job URL')
  if (externalId && canonical.externalId && externalId !== canonical.externalId)
    throw new Error('Platform job ID does not match URL')
  const identity = externalId || canonical.externalId || canonical.url
  return {
    id: createHash('sha256')
      .update(policy.id + ':' + identity)
      .digest('hex'),
    identity,
    url: canonical.url,
  }
}
