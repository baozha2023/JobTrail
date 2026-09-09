import type { DatabaseManager } from './database'

const DEFAULT_INTERVAL_MS = 1_000

export class ExternalDataMonitor {
  private timer: NodeJS.Timeout | undefined
  private version: number

  constructor(
    private readonly database: DatabaseManager,
    private readonly onChange: () => void,
    private readonly intervalMs = DEFAULT_INTERVAL_MS,
  ) {
    this.version = database.dataVersion()
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.checkNow(), this.intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = undefined
  }

  checkNow(): boolean {
    const next = this.database.dataVersion()
    if (next === this.version) return false
    this.version = next
    this.onChange()
    return true
  }
}
