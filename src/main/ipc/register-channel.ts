import { ipcMain, type BrowserWindow, type WebContents } from 'electron'

import type { IpcArgs, IpcChannel, IpcResponse, IpcResult } from '../../shared/ipc'
import { AppServiceError, errorShape } from '../services/errors'

let trustedContents: WebContents | undefined
export function trustWindow(window: BrowserWindow): void {
  trustedContents = window.webContents
}

type Handler<K extends IpcChannel> = (...args: IpcArgs<K>) => IpcResult<K> | Promise<IpcResult<K>>

export function registerChannel<K extends IpcChannel>(channel: K, handler: Handler<K>): void {
  ipcMain.removeHandler(channel)
  ipcMain.handle(
    channel,
    async (event, ...args: IpcArgs<K>): Promise<IpcResponse<IpcResult<K>>> => {
      try {
        if (
          event.sender !== trustedContents ||
          !event.senderFrame ||
          event.senderFrame !== event.sender.mainFrame
        ) {
          throw new AppServiceError('VALIDATION_ERROR', '不允许从子框架调用应用接口')
        }
        return { ok: true, data: await handler(...args) }
      } catch (error) {
        return { ok: false, error: errorShape(error) }
      }
    },
  )
}
