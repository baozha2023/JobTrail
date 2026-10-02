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
import {
  captureError,
  acceptDiagnosticInput,
  withDiagnosticContext,
  runOperation,
} from '../diagnostics'
import {
  validateDiagnosticInput,
  validDiagnosticContext,
  newDiagnosticContext,
  type DiagnosticContext,
} from '../../shared/diagnostics'

let trustedContents: WebContents | undefined
export function trustWindow(window: BrowserWindow): void {
  trustedContents = window.webContents
}

export function registerDiagnosticIpc(): void {
  ipcMain.removeHandler('diagnostics:report')
  ipcMain.handle('diagnostics:report', (event, payload: unknown) => {
    if (event.sender !== trustedContents || event.senderFrame !== event.sender.mainFrame)
      return { status: 'unavailable' }
    const input = validateDiagnosticInput(payload)
    if (!input || (input.source !== 'renderer' && input.source !== 'preload')) {
      captureError(
        { code: 'DIAGNOSTICS_TRANSPORT_FAILED', message: 'Invalid diagnostic IPC payload' },
        { operation: 'diagnostics.ipc' },
      )
      return { status: 'unavailable' }
    }
    return acceptDiagnosticInput(input, event.sender.getOSProcessId())
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
    captureError(error, { operation: 'ipc.send-event' })
  }
}

type Handler<K extends IpcChannel> = (...args: IpcArgs<K>) => IpcResult<K> | Promise<IpcResult<K>>

export function registerChannel<K extends IpcChannel>(channel: K, handler: Handler<K>): void {
  ipcMain.removeHandler(channel)
  ipcMain.handle(
    channel,
    async (
      event,
      envelope: { context?: DiagnosticContext; args?: IpcArgs<K> },
    ): Promise<IpcResponse<IpcResult<K>>> => {
      const operation = `ipc.${channel.replace(':', '.')}`
      const context = validDiagnosticContext(envelope?.context)
        ? envelope.context
        : newDiagnosticContext()
      return withDiagnosticContext(context, async () => {
        try {
          if (
            event.sender !== trustedContents ||
            !event.senderFrame ||
            event.senderFrame !== event.sender.mainFrame
          )
            throw new AppServiceError('VALIDATION_ERROR', '不允许从子框架调用应用接口')
          if (!validDiagnosticContext(envelope?.context) || !Array.isArray(envelope.args))
            throw new AppServiceError('VALIDATION_ERROR', '无效的请求信封')
          const execute = () => handler(...envelope.args!)
          const keyOperation = /^(backup:|velopack:|diagnostics:export)/.test(channel)
          const data = keyOperation ? await runOperation({ operation }, execute) : await execute()
          return { ok: true, data }
        } catch (error) {
          const diagnostic = captureError(error, { operation })
          return { ok: false, error: { ...errorShape(error), diagnostic } }
        }
      })
    },
  )
}
