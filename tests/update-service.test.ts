import { describe, expect, it } from 'vitest'
import type { UpdateInfo, VelopackAsset } from 'velopack'
import type { AppUpdateProgress } from '../src/shared/types'
import {
  DesktopUpdateService,
  type UpdateBackend,
  type UpdateRollback,
} from '../src/main/update-service'

const update = { TargetFullRelease: { Version: '0.3.1' } } as UpdateInfo
function backend(): UpdateBackend {
  return {
    checkForUpdatesAsync: async () => update,
    downloadUpdateAsync: async () => {},
    getUpdatePendingRestart: () => ({ Version: '0.3.1' }) as VelopackAsset,
    waitExitThenApplyUpdate: () => {},
  }
}
const rollback: UpdateRollback = {
  preserve: async () => {},
  prepare: async () => {},
  cancelPrepare: async () => {},
}
describe('desktop update transaction', () => {
  it('rejects apply before a checked update has downloaded', async () => {
    const service = new DesktopUpdateService(backend(), rollback)
    await expect(service.apply()).rejects.toThrow('请先检查更新')
    await service.check()
    await expect(service.apply()).rejects.toThrow('请先完成更新下载')
    await service.download()
    await expect(service.apply()).resolves.toBe(true)
  })
  it('rejects concurrent checks while downloading', async () => {
    let complete!: () => void
    const implementation = backend()
    implementation.downloadUpdateAsync = () =>
      new Promise<void>((resolve) => {
        complete = resolve
      })
    const service = new DesktopUpdateService(implementation, rollback)
    await service.check()
    const download = service.download()
    await expect(service.check()).rejects.toThrow('更新操作正在进行中')
    complete()
    await download
    expect(service.isBusy()).toBe(false)
  })
  it('does not mark a missing or mismatched package ready', async () => {
    const implementation = backend()
    implementation.getUpdatePendingRestart = () => null
    const service = new DesktopUpdateService(implementation, rollback)
    await service.check()
    await expect(service.download()).rejects.toThrow('更新包校验未完成')
    await expect(service.apply()).rejects.toThrow('请先完成更新下载')
  })
  it('prepares rollback before applying the verified downloaded asset', async () => {
    const calls: string[] = []
    const implementation = backend()
    implementation.downloadUpdateAsync = async () => {
      calls.push('download')
    }
    implementation.waitExitThenApplyUpdate = (asset) => {
      expect(asset.Version).toBe('0.3.1')
      calls.push('apply')
    }
    const service = new DesktopUpdateService(implementation, {
      preserve: async () => {
        calls.push('preserve')
      },
      prepare: async () => {
        calls.push('prepare')
      },
      cancelPrepare: async () => {
        calls.push('cancel')
      },
    })
    await service.check()
    await service.download()
    await service.apply()
    expect(calls).toEqual(['preserve', 'download', 'prepare', 'apply'])
  })
  it('releases the update freeze when applying the package fails', async () => {
    const calls: string[] = []
    const implementation = backend()
    implementation.waitExitThenApplyUpdate = () => {
      throw new Error('apply failed')
    }
    const service = new DesktopUpdateService(implementation, {
      preserve: async () => {},
      prepare: async () => {
        calls.push('prepare')
      },
      cancelPrepare: async () => {
        calls.push('cancel')
      },
    })
    await service.check()
    await service.download()
    await expect(service.apply()).rejects.toThrow('apply failed')
    expect(calls).toEqual(['prepare', 'cancel'])
  })
  it('reports actual Full download progress and the surrounding update stages', async () => {
    const progress: Omit<AppUpdateProgress, 'attemptId'>[] = []
    const implementation = backend()
    implementation.downloadUpdateAsync = async (_update, report) => {
      report?.(0)
      report?.(42)
      report?.(100)
    }
    const service = new DesktopUpdateService(implementation, rollback)
    await service.check()
    await service.download((event) => progress.push(event))
    await service.apply((event) => progress.push(event))
    expect(progress).toEqual([
      { stage: 'preserve' },
      { stage: 'transfer', mode: 'full', percentage: 0 },
      { stage: 'transfer', mode: 'full', percentage: 0 },
      { stage: 'transfer', mode: 'full', percentage: 42 },
      { stage: 'verify' },
      { stage: 'backup' },
      { stage: 'handoff' },
    ])
  })
  it('reports Delta milestones and a Full fallback without changing the update transaction', async () => {
    const progress: Omit<AppUpdateProgress, 'attemptId'>[] = []
    const implementation = backend()
    implementation.checkForUpdatesAsync = async () =>
      ({
        TargetFullRelease: { Version: '0.3.1' },
        BaseRelease: { Version: '0.3.0' },
        DeltasToTarget: [{ Version: '0.3.1' }, { Version: '0.3.1' }],
      }) as UpdateInfo
    implementation.downloadUpdateAsync = async (_update, report) => {
      for (const value of [0, 35, 70, 0, 50, 100]) report?.(value)
    }
    const service = new DesktopUpdateService(implementation, rollback)
    await service.check()
    await service.download((event) => progress.push(event))
    expect(progress.filter((event) => event.stage === 'transfer')).toEqual([
      { stage: 'transfer', mode: 'delta', percentage: 0 },
      { stage: 'transfer', mode: 'delta', percentage: 35 },
      { stage: 'transfer', mode: 'delta', percentage: 70 },
      { stage: 'transfer', mode: 'delta', percentage: 70 },
      { stage: 'transfer', mode: 'full', percentage: 0 },
      { stage: 'transfer', mode: 'full', percentage: 50 },
    ])
  })
})
