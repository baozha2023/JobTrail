import type { UpdateInfo, VelopackAsset } from 'velopack'
import type { AppUpdateProgress } from '../shared/types'
import { AppServiceError } from './services/errors'
import { logFault, reportFault } from './diagnostics'

export type UpdateProgressReporter = (progress: Omit<AppUpdateProgress, 'attemptId'>) => void

export interface UpdateBackend {
  checkForUpdatesAsync(): Promise<UpdateInfo | null>
  downloadUpdateAsync(update: UpdateInfo, progress?: (percentage: number) => void): Promise<void>
  getUpdatePendingRestart(): VelopackAsset | null
  waitExitThenApplyUpdate(
    update: VelopackAsset,
    silent: boolean,
    restart: boolean,
    args: string[],
  ): void
}

export interface UpdateRollback {
  preserve(targetVersion: string): Promise<void>
  prepare(targetVersion: string): Promise<void>
  cancelPrepare(): Promise<void>
}

export class DesktopUpdateService {
  private busy = false
  private closing = false
  private pending: UpdateInfo | null = null
  private downloaded = false
  constructor(
    private readonly backend: UpdateBackend,
    private readonly rollback: UpdateRollback,
  ) {}

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.isBusy()) throw new AppServiceError('VALIDATION_ERROR', '更新操作正在进行中')
    this.busy = true
    try {
      return await operation()
    } finally {
      this.busy = false
    }
  }
  check(): Promise<UpdateInfo | null> {
    return this.exclusive(async () => {
      this.pending = null
      this.downloaded = false
      try {
        this.pending = await this.backend.checkForUpdatesAsync()
      } catch (error) {
        logFault('update.check', error)
        throw error
      }
      return this.pending
    })
  }
  download(report?: UpdateProgressReporter): Promise<boolean> {
    return this.exclusive(async () => {
      const update = this.requirePending()
      this.downloaded = false
      report?.({ stage: 'preserve' })
      try {
        await this.rollback.preserve(update.TargetFullRelease.Version)
      } catch (error) {
        logFault('update.rollback-preserve', error)
        throw error
      }
      const deltas = update.BaseRelease ? update.DeltasToTarget : []
      const deltaMilestones = new Map(
        deltas.map((_delta, index) => [
          Math.trunc((index / deltas.length) * 70),
          Math.trunc(((index + 1) / deltas.length) * 70),
        ]),
      )
      deltaMilestones.set(70, 70).set(100, 100)
      let mode: 'delta' | 'full' = deltas.length > 0 ? 'delta' : 'full'
      let lastPercentage = 0
      let verifying = false
      report?.({ stage: 'transfer', mode, percentage: 0 })
      try {
        await this.backend.downloadUpdateAsync(update, (percentage) => {
          if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) return
          const current = Math.trunc(percentage)
          if (current === 100) {
            verifying = true
            report?.({ stage: 'verify' })
            return
          }
          // Velopack reports completed Delta milestones, then patching progress.
          // A fallback to Full restarts its callback at zero and then reports bytes.
          if (mode === 'delta' && (current < lastPercentage || !deltaMilestones.has(current)))
            mode = 'full'
          lastPercentage = current
          report?.({
            stage: 'transfer',
            mode,
            percentage: mode === 'delta' ? deltaMilestones.get(current) : current,
          })
        })
      } catch (error) {
        logFault('update.download', error)
        throw error
      }
      if (!verifying) report?.({ stage: 'verify' })
      if (this.backend.getUpdatePendingRestart()?.Version !== update.TargetFullRelease.Version) {
        reportFault({ source: 'main', operation: 'update.verify', code: 'UPDATE_VERIFY_FAILED' })
        throw new AppServiceError('VALIDATION_ERROR', '更新包校验未完成，请重新下载')
      }
      this.downloaded = true
      return true
    })
  }
  apply(report?: UpdateProgressReporter): Promise<boolean> {
    return this.exclusive(async () => {
      const update = this.requirePending()
      const asset = this.backend.getUpdatePendingRestart()
      if (!this.downloaded || !asset || asset.Version !== update.TargetFullRelease.Version) {
        throw new AppServiceError('VALIDATION_ERROR', '请先完成更新下载')
      }
      report?.({ stage: 'backup' })
      try {
        await this.rollback.prepare(asset.Version)
      } catch (error) {
        logFault('update.prepare', error)
        throw error
      }
      try {
        report?.({ stage: 'handoff' })
        this.backend.waitExitThenApplyUpdate(asset, false, true, ['--handoff-root'])
      } catch (error) {
        logFault('update.apply', error)
        try {
          await this.rollback.cancelPrepare()
        } catch (rollbackError) {
          logFault('update.rollback', rollbackError)
          throw rollbackError
        }
        throw error
      }
      this.closing = true
      return true
    })
  }
  isBusy(): boolean {
    return this.busy || this.closing
  }
  private requirePending(): UpdateInfo {
    if (!this.pending) throw new AppServiceError('VALIDATION_ERROR', '请先检查更新')
    return this.pending
  }
}
