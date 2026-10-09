import { expect, it } from 'vitest'
import { statusFromPage } from '../src/main/discovery/platform-status'
import type { PlatformStatus } from '../src/shared/job-discovery'

const previous: PlatformStatus = {
  platform: 'boss',
  state: 'authenticated',
  checkedAt: 1234,
  generation: 2,
  evidence: 'official_qr_login_confirmed',
  limitations: ['session_recheck_required'],
  capabilities: { cities: [], remoteFilters: [], qr: 'website' },
}
it('preserves confirmed evidence and its timestamp on an inconclusive page', () => {
  const result = statusFromPage(
    previous,
    { challenge: false, authenticated: false, login: false },
    5678,
  )
  expect(result).toMatchObject({
    state: 'authenticated',
    checkedAt: 1234,
    evidence: previous.evidence,
  })
  expect(result.limitations).toContain('session_recheck_required')
  expect(result.limitations).toContain('authentication_check_inconclusive')
  expect(statusFromPage(result, { challenge: false, authenticated: false, login: false })).toEqual(
    result,
  )
})
it('only refreshes the confirmation time after positive account evidence', () => {
  expect(
    statusFromPage(previous, { challenge: false, authenticated: true, login: false }, 5678),
  ).toMatchObject({
    state: 'authenticated',
    checkedAt: 5678,
    limitations: [],
    evidence: 'visible_account_controls',
  })
})
it('reports explicit logout and verification evidence without pretending the cached login is live', () => {
  expect(
    statusFromPage(previous, { challenge: false, authenticated: false, login: true }),
  ).toMatchObject({ state: 'session_expired', limitations: ['session_expired'] })
  expect(
    statusFromPage(previous, { challenge: true, authenticated: false, login: false }),
  ).toMatchObject({ state: 'challenge', limitations: ['challenge'] })
})
it('does not invent authentication for an unchecked platform', () => {
  expect(
    statusFromPage(
      { ...previous, state: 'unknown', checkedAt: null, evidence: '' },
      { challenge: false, authenticated: false, login: false },
    ),
  ).toMatchObject({ state: 'unknown', checkedAt: null, evidence: '' })
})
