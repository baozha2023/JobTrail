import { net } from 'electron'
import type { CompanyCatalogFetcher } from './company-catalog-updater'

const ALLOWED_HOSTS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
])
const MAX_REDIRECTS = 10

function validateUrl(value: string): void {
  const url = new URL(value)
  if (
    url.protocol !== 'https:' ||
    !ALLOWED_HOSTS.has(url.hostname) ||
    url.port ||
    url.username ||
    url.password
  )
    throw new Error('Invalid company catalog download URL')
}

// Electron net.fetch does not provide a reliable Response.url. Validate each
// destination before following it, using Chromium's system proxy support.
export const fetchCompanyCatalog: CompanyCatalogFetcher = async (url, { signal }) => {
  signal.throwIfAborted()
  validateUrl(url)
  return new Promise<Response>((resolve, reject) => {
    const request = net.request({ url, redirect: 'manual', credentials: 'omit' })
    let redirects = 0
    let completed = false
    let body: ReadableStreamDefaultController<Uint8Array> | undefined
    const fail = (error: Error) => {
      if (completed) return
      completed = true
      signal.removeEventListener('abort', abort)
      reject(error)
      body?.error(error)
      request.abort()
    }
    const abort = () => fail(new Error('Company catalog download aborted'))
    signal.addEventListener('abort', abort, { once: true })
    // The request's writable side can emit close before response headers arrive.
    // Completion is determined by response end/error/aborted or the shared timeout.
    request.on('error', fail)
    request.on('abort', abort)
    request.on('redirect', (_status, _method, destination) => {
      try {
        if (++redirects > MAX_REDIRECTS) throw new Error('Too many company catalog redirects')
        validateUrl(destination)
        request.followRedirect()
      } catch (error) {
        fail(error as Error)
      }
    })
    request.on('response', (response) => {
      response.on('error', fail)
      response.on('aborted', abort)
      if (response.statusCode !== 200) {
        completed = true
        signal.removeEventListener('abort', abort)
        resolve(new Response(null, { status: response.statusCode }))
        request.abort()
        return
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          body = controller
          response.on('end', () => {
            if (completed) return
            completed = true
            signal.removeEventListener('abort', abort)
            controller.close()
          })
          response.on('data', (chunk) => {
            if (!completed) controller.enqueue(chunk)
          })
        },
        cancel() {
          completed = true
          signal.removeEventListener('abort', abort)
          request.abort()
        },
      })
      resolve(new Response(stream))
    })
    request.end()
  })
}
