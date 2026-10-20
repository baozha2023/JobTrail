import { afterEach, describe, expect, it, vi } from 'vitest'
import { detectInitialLocale } from '../src/main/system-locale'
import * as diagnostics from '../src/main/diagnostics'

afterEach(() => vi.restoreAllMocks())

describe('initial system language', () => {
  it.each(['en', 'en-US', 'en-GB', 'en-AU', 'en-IN', 'EN-us'])(
    'uses English for the primary system language %s',
    (language) => {
      expect(detectInitialLocale(() => [language])).toBe('en-US')
    },
  )

  it.each(
    [[], ['zh-CN'], ['zh-TW'], ['zh-HK'], ['de-DE'], ['fr-FR', 'en-US'], [''], ['english']].map(
      (languages) => ({ languages }),
    ),
  )(
    'defaults to Chinese for missing, Chinese or unsupported primary languages: $languages',
    ({ languages }) => {
      expect(detectInitialLocale(() => languages)).toBe('zh-CN')
    },
  )

  it('falls back to Chinese and records a failed system language lookup', () => {
    const diagnostic = vi.spyOn(diagnostics, 'captureError').mockReturnValue({
      eventId: 'synthetic-event',
      traceId: 'synthetic-trace',
      spanId: 'synthetic-span',
    })
    const error = new Error('System language lookup failed')
    expect(
      detectInitialLocale(() => {
        throw error
      }),
    ).toBe('zh-CN')
    expect(diagnostic).toHaveBeenCalledWith(error, { operation: 'config.detect-locale' })
  })

  it('uses Chinese when Electron desktop APIs are unavailable in a headless process', () => {
    expect(detectInitialLocale()).toBe('zh-CN')
  })
})
