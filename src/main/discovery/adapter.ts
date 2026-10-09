import type {
  JobPlatform,
  JobQuery,
  RawJob,
  SourceState,
  QrScanHint,
} from '../../shared/job-discovery'
import type { QrProtocol, QrTransport } from './qr-protocol'

export interface JobIdentityPolicy {
  readonly id: JobPlatform
  readonly domains: readonly string[]
  /** A validated job URL is the identity when the site provides no stable job ID. */
  canonicalJob(url: URL): { url: string; externalId: string | null } | null
}

export type VerificationPage = 'not_found' | 'challenge' | 'blank' | 'loading'
export interface VerificationPolicy {
  acceptsUrl(value: string | null): string | null
  allowsNavigation(url: string): boolean
  readonly referrer: string
  pageScript(): string
}

/** Site rules are owned by one adapter. Infrastructure owns all resource lifetimes. */
export interface PlatformAdapter extends JobIdentityPolicy {
  readonly accountCheckUrl: string
  readonly contractVersion: number
  readonly remoteFilters: readonly string[]
  pageScript(detail: boolean): string
  createSearch(page: SearchTransport, query: NativeQuery): PlatformSearch
  readonly verification?: VerificationPolicy
  readonly qr: {
    readonly scanHint: QrScanHint
    create(transport: QrTransport): QrProtocol
    headers?(url: string): Record<string, string>
    /** null means no challenge; a missing URL still represents an explicit block. */
    challenge?(response: Response): { url: string | null } | null
  }
}

export class SourceError extends Error {
  constructor(
    readonly state: SourceState,
    message: string = state,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}
export type NativeQuery = Pick<JobQuery, 'keyword' | 'city'>
export interface ParsedBatch {
  jobs: RawJob[]
  /** Valid source identities before adapter admission, for budgets and no-growth detection. */
  sourceIds: string[]
  page: number
  rawCount: number
  duplicateCount: number
  rejectedCount: number
  hasMore: boolean | null
  evidence: 'search_response' | 'search_initial_state' | 'search_dom'
}
export interface SourceBatch extends ParsedBatch {
  submitted: { keyword: string; cityCode: string }
}
export interface PlatformSearch {
  read(signal: AbortSignal): Promise<SourceBatch>
  commit(batch: SourceBatch): void
}
export interface SearchRequest {
  url: string
  method: string
  body: string
}
export interface ResponseReader<T> {
  // null: another endpoint; false: this endpoint with another query/page.
  request(request: SearchRequest): boolean | null
  response(body: unknown): T
  parseBody?(text: string): unknown
}

/** The adapter controls site interactions but cannot own native windows or sessions. */
export interface SearchTransport {
  evaluate<T>(script: string, signal: AbortSignal): Promise<T>
  load(url: string, signal: AbortSignal): Promise<void>
  until<T>(read: () => Promise<T | null | false>, signal: AbortSignal, failure?: string): Promise<T>
  guard(signal: AbortSignal): Promise<void>
  fill(selector: string, value: string, signal: AbortSignal): Promise<void>
  click(selector: string, label: string | null, signal: AbortSignal): Promise<void>
  enter(): void
  response<T>(
    reader: ResponseReader<T>,
    action: () => Promise<void>,
    signal: AbortSignal,
    initial?: () => Promise<T | null>,
  ): Promise<T>
}
