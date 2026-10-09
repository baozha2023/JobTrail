import type { CookiesSetDetails } from 'electron'

export class LoginError extends Error {
  constructor(
    readonly reason: 'network' | 'protocol' | 'verification',
    options?: ErrorOptions,
  ) {
    super(reason, options)
  }
}
export interface QrRequestOptions {
  data?: Record<string, string>
  jsonBody?: boolean
  timeoutMs?: number
}
export interface QrTransport {
  text(url: string, options?: QrRequestOptions): Promise<string>
  json<T>(
    url: string,
    parse: (value: unknown) => T,
    options?: QrRequestOptions,
    decode?: (text: string) => unknown,
  ): Promise<T>
  setCookie(cookie: CookiesSetDetails): Promise<void>
  scanned(): void
}
export interface QrProtocol {
  initialize(): Promise<{ image: string; expiresInMs: number }>
  poll(): Promise<'waiting' | 'scanned' | 'authenticated' | 'expired'>
}

export function qrImage(value: unknown, base: string): string {
  if (typeof value !== 'string' || !value) throw new LoginError('protocol')
  try {
    return new URL(value, base).href
  } catch {
    throw new LoginError('protocol')
  }
}
