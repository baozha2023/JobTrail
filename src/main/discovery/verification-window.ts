import { BrowserWindow, type Session, type WebContents, type WebPreferences } from 'electron'
import { platformNames, type JobPlatform } from '../../shared/job-discovery'
import { allowedPage } from './platforms'

export function websiteUserAgent(value: string): string {
  return value.replace(/(?:^|\s)(?:职迹|JobTrail|zhiji)\/\S+/gi, '').trim()
}

export function platformPreferences(session: Session): WebPreferences {
  return {
    session,
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    backgroundThrottling: false,
    spellcheck: false,
  }
}

export function protectPlatformPage(wc: WebContents, platform: JobPlatform) {
  wc.setUserAgent(websiteUserAgent(wc.getUserAgent()))
  wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
  const navigation = (event: Electron.Event, url: string) => {
    if (!allowedPage(platform, url)) event.preventDefault()
  }
  wc.on('will-navigate', navigation)
  wc.on('will-redirect', navigation)
  wc.on('will-attach-webview', (event) => event.preventDefault())
}

export interface VerificationWindowHandle {
  window: BrowserWindow
  close(): void
}

// One native window owner for QR and search verification. Business code decides
// whether verification succeeded; this class only owns isolation and lifetime.
export class VerificationWindow {
  private current?: VerificationWindowHandle
  constructor(private parent: () => BrowserWindow | undefined) {}

  open(input: {
    platform: JobPlatform
    session: Session
    signal: AbortSignal
    // Only a page created and protected by DiscoveryRuntime may be adopted.
    existing?: BrowserWindow
    onClosed(userClosed: boolean): void
  }): VerificationWindowHandle {
    input.signal.throwIfAborted()
    this.current?.close()
    const win =
      input.existing ??
      new BrowserWindow({
        parent: this.parent(),
        width: 960,
        height: 760,
        minWidth: 600,
        minHeight: 500,
        show: false,
        autoHideMenuBar: true,
        title: platformNames[input.platform],
        webPreferences: platformPreferences(input.session),
      })
    if (input.existing) {
      win.setParentWindow(this.parent() ?? null)
      win.setSkipTaskbar(false)
      win.setTitle(platformNames[input.platform])
    } else protectPlatformPage(win.webContents, input.platform)
    win.setMenu(null)
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    let closed = false
    const dispose = (userClosed: boolean) => {
      if (closed) return
      closed = true
      if (this.current === handle) this.current = undefined
      input.signal.removeEventListener('abort', abort)
      if (!win.isDestroyed()) win.destroy()
      input.onClosed(userClosed)
    }
    const abort = () => dispose(false)
    const handle: VerificationWindowHandle = { window: win, close: abort }
    this.current = handle
    input.signal.addEventListener('abort', abort, { once: true })
    win.on('closed', () => dispose(true))
    return handle
  }
}
