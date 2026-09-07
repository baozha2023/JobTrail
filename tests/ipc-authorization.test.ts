import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from 'electron'
const mocks = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: mocks }))
import { registerChannel, trustWindow } from '../src/main/ipc/register-channel'
describe('IPC sender authorization', () => {
  it('accepts only the registered main window and its main frame', async () => {
    const frame = {}
    const contents = { mainFrame: frame } as WebContents
    trustWindow({ webContents: contents } as BrowserWindow)
    const handler = vi.fn(() => false)
    registerChannel('system:is-development', handler)
    const invoke = mocks.handle.mock.calls[0][1] as (
      event: Partial<IpcMainInvokeEvent>,
    ) => Promise<{ ok: boolean }>
    expect(
      (await invoke({ sender: contents, senderFrame: frame as Electron.WebFrameMain })).ok,
    ).toBe(true)
    expect((await invoke({ sender: contents, senderFrame: {} as Electron.WebFrameMain })).ok).toBe(
      false,
    )
    expect(
      (
        await invoke({
          sender: { mainFrame: frame } as WebContents,
          senderFrame: frame as Electron.WebFrameMain,
        })
      ).ok,
    ).toBe(false)
    expect(handler).toHaveBeenCalledOnce()
  })
})
