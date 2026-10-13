import type { CookiesSetDetails } from 'electron'

export class LoginError extends Error {
  constructor(
    readonly reason: 'network' | 'protocol' | 'verification',
    options?: ErrorOptions,
  ) {
    super(reason, options)
  }
}
export type QrRequestOptions = {
  headers?: Record<string, string>
  timeoutMs?: number
} & (
  | { jsonBody: true; data?: Record<string, string | null> }
  | { jsonBody?: false; data?: Record<string, string> }
)
export interface QrTransport {
  cookie(url: string, name: string): Promise<string | null>
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
  poll(): Promise<
    | 'waiting'
    | 'scanned'
    | 'authenticated'
    | 'expired'
    | { state: 'waiting' | 'scanned'; image: string; expiresInMs: number }
  >
}

export function qrImage(value: unknown, base: string): string {
  if (typeof value !== 'string' || !value) throw new LoginError('protocol')
  try {
    return new URL(value, base).href
  } catch {
    throw new LoginError('protocol')
  }
}
