import { SourceError, type ParsedBatch, type SourceBatch } from './adapter'

export const ROUND_BATCHES = 3
export const ROUND_JOBS = 200

/** More registered sites must not increase the number of concurrent browser collectors. */
export async function runSourceTasks<T>(
  sources: readonly T[],
  collect: (source: T) => Promise<void>,
) {
  let next = 0
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(4, sources.length) }, async () => {
      while (next < sources.length) {
        const source = sources[next++]
        await collect(source)
      }
    }),
  )
  const failure = results.find((result) => result.status === 'rejected')
  if (failure?.status === 'rejected') throw failure.reason
}

/** A prefix of committed whole batches, never a flattened tail of the last round. */
export class BatchCache {
  private entries = new Map<string, { at: number; batches: SourceBatch[] }>()
  read(key: string, now = Date.now()) {
    const entry = this.entries.get(key)
    if (!entry || now - entry.at >= 120000) return undefined
    return entry
  }
  append(key: string, batch: SourceBatch, now = Date.now()) {
    let entry = this.read(key, now)
    if (!entry) {
      if (batch.page !== 1) return
      entry = { at: now, batches: [] }
      this.entries.set(key, entry)
    }
    if (batch.page > entry.batches.length + 1) return
    // A replay may return a changed page. Later cached pages belong to the old
    // response sequence and cannot be combined with the new prefix.
    entry.batches.length = batch.page - 1
    entry.batches.push(batch)
    if (this.entries.size > 30) this.entries.delete(this.entries.keys().next().value!)
  }
  clear() {
    this.entries.clear()
  }
}

/** Source page advancement belongs after the caller's durable transaction. */
export class RoundBudget {
  batches = 0
  jobs = 0
  constructor(public noGrowth = 0) {}
  get exhausted() {
    return this.batches >= ROUND_BATCHES || this.jobs >= ROUND_JOBS
  }
  saved(batch: ParsedBatch, added: number, recovering: boolean) {
    if (batch.rawCount !== batch.sourceIds.length + batch.duplicateCount + batch.rejectedCount)
      throw new SourceError('network_error', 'batch_accounting_mismatch')
    this.batches++
    this.jobs += batch.sourceIds.length
    this.noGrowth = added || recovering ? 0 : this.noGrowth + 1
    return batch.hasMore === false ? 'completed' : this.noGrowth >= 2 ? 'no_growth' : 'more'
  }
}
