import { describe, expect, it } from 'vitest'
import type { UpdateInfo, VelopackAsset } from 'velopack'
import { DesktopUpdateService, type UpdateBackend } from '../src/main/update-service'

const update = { TargetFullRelease: { Version: '0.3.1' } } as UpdateInfo
function backend(): UpdateBackend {
  return {
    checkForUpdatesAsync: async () => update,
    downloadUpdateAsync: async () => {},
    getUpdatePendingRestart: () => ({ Version: '0.3.1' }) as VelopackAsset,
    waitExitThenApplyUpdate: () => {},
  }
}
describe('desktop update transaction', () => {
  it('rejects apply before a checked update has downloaded', async () => {
    const service = new DesktopUpdateService(backend())
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
    const service = new DesktopUpdateService(implementation)
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
    const service = new DesktopUpdateService(implementation)
    await service.check()
    await expect(service.download()).rejects.toThrow('更新包校验未完成')
    await expect(service.apply()).rejects.toThrow('请先完成更新下载')
  })
})
