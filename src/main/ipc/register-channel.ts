import { ipcMain } from 'electron'
import type { IpcArgs, IpcChannel, IpcResponse, IpcResult } from '../../shared/ipc'
import { errorShape } from '../services/errors'

type Handler<K extends IpcChannel> = (...args: IpcArgs<K>) => IpcResult<K> | Promise<IpcResult<K>>

export function registerChannel<K extends IpcChannel>(channel: K, handler: Handler<K>): void {
  ipcMain.removeHandler(channel)
  ipcMain.handle(channel, async (_event, ...args: IpcArgs<K>): Promise<IpcResponse<IpcResult<K>>> => {
    try {
      return { ok: true, data: await handler(...args) }
    } catch (error) {
      return { ok: false, error: errorShape(error) }
    }
  })
}
