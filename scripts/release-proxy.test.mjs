import assert from 'node:assert/strict'
import test from 'node:test'
import { parseReleaseProxy } from './release-proxy.mjs'

test('uses the Windows HTTPS proxy when protocols have separate entries', () => {
  assert.equal(
    parseReleaseProxy('http=127.0.0.1:8000;https=127.0.0.1:7897'),
    'http://127.0.0.1:7897/',
  )
})

test('uses a single Windows proxy for HTTPS release downloads', () => {
  assert.equal(parseReleaseProxy('127.0.0.1:7897'), 'http://127.0.0.1:7897/')
  assert.equal(parseReleaseProxy('https://proxy.example:443'), 'https://proxy.example/')
})

test('rejects unsupported proxy protocols', () => {
  assert.throws(() => parseReleaseProxy('socks5://127.0.0.1:7897'), /unsupported_release_proxy/)
})
