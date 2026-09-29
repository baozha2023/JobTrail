import { ipcMain, type BrowserWindow, type WebContents } from 'electron'

import type {
  AppEventChannel,
  AppEventMap,
  IpcArgs,
  IpcChannel,
  IpcResponse,
  IpcResult,
} from '../../shared/ipc'
import { AppServiceError, errorShape } from '../services/errors'
import { logFault, reportFault } from '../diagnostics'
import { validateFaultInput } from '../../shared/diagnostics'

let trustedContents: WebContents | undefined
let diagnosticWindowStart = 0
let diagnosticCount = 0
export function trustWindow(window: BrowserWindow): void {
  trustedContents = window.webContents
}

export function registerDiagnosticIpc(): void {
  ipcMain.on('diagnostics:report', (event, payload: unknown) => {
    if (event.sender !== trustedContents || event.senderFrame !== event.sender.mainFrame) return
    const now = Date.now()
    if (now - diagnosticWindowStart > 60_000) {
      diagnosticWindowStart = now
      diagnosticCount = 0
    }
    if (++diagnosticCount > 30) return
    const input = validateFaultInput(payload)
    if (input) reportFault(input, event.sender.getOSProcessId())
  })
}

export function sendToTrustedWindow<K extends AppEventChannel>(
  channel: K,
  payload: AppEventMap[K],
): void {
  if (!trustedContents || trustedContents.isDestroyed()) return
  try {
    trustedContents.send(channel, payload)
  } catch (error) {
    logFault('ipc.send-event', error)
  }
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
        const operation =
          channel === 'velopack:check-for-update'
            ? 'update.check'
            : channel === 'velopack:download-update'
              ? 'update.download'
              : channel === 'velopack:apply-update'
                ? 'update.apply'
                : `ipc.${channel.replace(':', '.')}`
        logFault(operation, error)
        return { ok: false, error: errorShape(error) }
      }
    },
  )
}
