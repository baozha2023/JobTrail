import type { PlatformStatus } from '../../shared/job-discovery'
import type { PageSnapshot } from './extraction'

// Failure to find account controls (loading, changed markup, or a public page)
// cannot invalidate a previously confirmed login or refresh its evidence time.
export function statusFromPage(
  previous: PlatformStatus,
  page: Pick<PageSnapshot, 'challenge' | 'authenticated' | 'login'>,
  now = Date.now(),
): PlatformStatus {
  if (!page.challenge && !page.authenticated && !page.login)
    return {
      ...previous,
      limitations: [
        ...new Set([
          ...previous.limitations,
          'authentication_check_inconclusive',
          ...(previous.state === 'authenticated' ? ['session_recheck_required'] : []),
        ]),
      ],
    }
  const state = page.challenge
    ? 'challenge'
    : page.authenticated
      ? 'authenticated'
      : ['authenticated', 'session_expired'].includes(previous.state)
        ? 'session_expired'
        : 'login_required'
  return {
    ...previous,
    state,
    checkedAt: now,
    evidence: page.challenge
      ? 'visible_challenge'
      : page.authenticated
        ? 'visible_account_controls'
        : 'official_login_form',
    limitations: state === 'authenticated' ? [] : [state],
  }
}
