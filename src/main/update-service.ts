import type { UpdateInfo, VelopackAsset } from 'velopack'
import { AppServiceError } from './services/errors'

export interface UpdateBackend {
  checkForUpdatesAsync(): Promise<UpdateInfo | null>
  downloadUpdateAsync(update: UpdateInfo): Promise<void>
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
      this.pending = await this.backend.checkForUpdatesAsync()
      return this.pending
    })
  }
  download(): Promise<boolean> {
    return this.exclusive(async () => {
      const update = this.requirePending()
      this.downloaded = false
      await this.rollback.preserve(update.TargetFullRelease.Version)
      await this.backend.downloadUpdateAsync(update)
      if (this.backend.getUpdatePendingRestart()?.Version !== update.TargetFullRelease.Version) {
        throw new AppServiceError('VALIDATION_ERROR', '更新包校验未完成，请重新下载')
      }
      this.downloaded = true
      return true
    })
  }
  apply(): Promise<boolean> {
    return this.exclusive(async () => {
      const update = this.requirePending()
      const asset = this.backend.getUpdatePendingRestart()
      if (!this.downloaded || !asset || asset.Version !== update.TargetFullRelease.Version) {
        throw new AppServiceError('VALIDATION_ERROR', '请先完成更新下载')
      }
      await this.rollback.prepare(asset.Version)
      this.backend.waitExitThenApplyUpdate(asset, false, true, ['--handoff-root'])
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
