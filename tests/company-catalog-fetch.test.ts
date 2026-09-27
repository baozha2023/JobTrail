import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { createRequest } = vi.hoisted(() => ({ createRequest: vi.fn() }))
vi.mock('electron', () => ({ net: { request: createRequest } }))
import { fetchCompanyCatalog } from '../src/main/company-catalog-fetch'

class Request extends EventEmitter {
  end = vi.fn()
  followRedirect = vi.fn()
  abort = vi.fn(() => {
    this.emit('abort')
    this.emit('close')
  })
}

const url = 'https://github.com/baozha2023/JobTrail/releases/latest/download/catalog.json'
let request: Request
let controller: AbortController

beforeEach(() => {
  request = new Request()
  controller = new AbortController()
  createRequest.mockReset().mockReturnValue(request)
})

function respond(statusCode = 200) {
  const incoming = Object.assign(new EventEmitter(), { statusCode })
  request.emit('response', incoming)
  return incoming
}

describe('company catalog Chromium download', () => {
  it('follows validated GitHub redirects and streams bytes without Response.url', async () => {
    const result = fetchCompanyCatalog(url, { signal: controller.signal })
    expect(createRequest).toHaveBeenCalledWith({ url, redirect: 'manual', credentials: 'omit' })
    // Electron can close the request's writable side before receiving headers.
    request.emit('close')
    request.emit('redirect', 302, 'GET', 'https://github.com/release/catalog.json')
    request.emit('redirect', 302, 'GET', 'https://release-assets.githubusercontent.com/catalog')
    expect(request.followRedirect).toHaveBeenCalledTimes(2)
    const incoming = respond()
    const response = await result
    expect(response.url).toBe('')
    const bytes = response.text()
    incoming.emit('data', Buffer.from('first'))
    incoming.emit('data', Buffer.from('second'))
    incoming.emit('end')
    request.emit('close')
    await expect(bytes).resolves.toBe('firstsecond')
    controller.abort()
    expect(request.abort).not.toHaveBeenCalled()
  })

  it.each([
    'http://github.com/file',
    'https://github.com.attacker.example/file',
    'https://example.com/file',
    'file:///C:/secret',
    'https://user:secret@github.com/file',
    'https://github.com:8443/file',
  ])('blocks unsafe initial and redirect URLs: %s', async (destination) => {
    await expect(fetchCompanyCatalog(destination, { signal: controller.signal })).rejects.toThrow()
    expect(createRequest).not.toHaveBeenCalled()
    const result = fetchCompanyCatalog(url, { signal: controller.signal })
    request.emit('redirect', 302, 'GET', destination)
    await expect(result).rejects.toThrow()
    expect(request.followRedirect).not.toHaveBeenCalled()
    expect(request.abort).toHaveBeenCalledOnce()
  })

  it('limits redirect loops', async () => {
    const result = fetchCompanyCatalog(url, { signal: controller.signal })
    for (let i = 0; i < 11; i++) request.emit('redirect', 302, 'GET', url)
    await expect(result).rejects.toThrow('Too many')
    expect(request.followRedirect).toHaveBeenCalledTimes(10)
  })

  it.each([404, 503])('preserves HTTP %i and stops reading its body', async (status) => {
    const result = fetchCompanyCatalog(url, { signal: controller.signal })
    respond(status)
    expect((await result).status).toBe(status)
    expect(request.abort).toHaveBeenCalledOnce()
  })

  it('rejects cancellation before starting and while waiting for headers', async () => {
    controller.abort()
    await expect(fetchCompanyCatalog(url, { signal: controller.signal })).rejects.toThrow()
    expect(createRequest).not.toHaveBeenCalled()
    controller = new AbortController()
    const result = fetchCompanyCatalog(url, { signal: controller.signal })
    controller.abort()
    await expect(result).rejects.toThrow('aborted')
    expect(request.abort).toHaveBeenCalledOnce()
  })

  it.each(['abort', 'error', 'aborted'])(
    'rejects interrupted response bodies: %s',
    async (event) => {
      const result = fetchCompanyCatalog(url, { signal: controller.signal })
      const incoming = respond()
      const body = (await result).text()
      incoming.emit('data', Buffer.from('incomplete'))
      if (event === 'abort') controller.abort()
      else if (event === 'error') incoming.emit('error', new Error('connection lost'))
      else incoming.emit('aborted')
      await expect(body).rejects.toThrow()
      incoming.emit('end')
    },
  )

  it('aborts the native request when the body reader cancels after exceeding its limit', async () => {
    const result = fetchCompanyCatalog(url, { signal: controller.signal })
    const incoming = respond()
    const reader = (await result).body!.getReader()
    incoming.emit('data', Buffer.from('oversized'))
    await reader.read()
    await reader.cancel()
    expect(request.abort).toHaveBeenCalledOnce()
    incoming.emit('data', Buffer.from('ignored'))
    incoming.emit('end')
  })
})
