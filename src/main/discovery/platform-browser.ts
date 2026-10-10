import {
  BrowserWindow,
  WebContentsView,
  type Session,
  type WebContents,
  type WebPreferences,
} from 'electron'
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
  const navigation = (event: Electron.Event, url: string) => {
    if (!allowedPage(platform, url)) event.preventDefault()
  }
  wc.on('will-navigate', navigation)
  wc.on('will-redirect', navigation)
  wc.on('will-attach-webview', (event) => event.preventDefault())
}

export interface VerificationWindowHandle {
  window: BrowserWindow
  page: WebContentsView
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
    onClosed(userClosed: boolean): void
  }): VerificationWindowHandle {
    input.signal.throwIfAborted()
    this.current?.close()
    const page = new WebContentsView({ webPreferences: platformPreferences(input.session) })
    // WebContentsView.webContents becomes unavailable after a website closes it.
    // Keep the contents handle so later host disposal can safely test its lifetime.
    const wc = page.webContents
    protectPlatformPage(wc, input.platform)
    // Keep the native window separate from the website's window.close(). The
    // website renders in a real WebContentsView: BrowserWindow.contentView is
    // only a layout container and moving it would produce an empty window.
    // No preload or page-level close override is injected.
    const win = new BrowserWindow({
      parent: this.parent(),
      width: 960,
      height: 760,
      minWidth: 600,
      minHeight: 500,
      show: false,
      autoHideMenuBar: true,
      title: platformNames[input.platform],
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    })
    win.contentView.addChildView(page)
    const resize = () => {
      const [width, height] = win.getContentSize()
      page.setBounds({ x: 0, y: 0, width, height })
    }
    resize()
    win.on('resize', resize)
    win.setMenu(null)
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    const title = (_event: Electron.Event, value: string) => win.setTitle(value)
    wc.on('page-title-updated', title)
    let closed = false
    let userClosing = false
    wc.on('destroyed', () => {
      // Let page destruction callbacks settle before changing the host content.
      setImmediate(() => showClosedPage())
    })
    const showClosedPage = () => {
      if (closed || win.isDestroyed()) return
      page.setVisible(false)
      // This belongs to the local host, never to the official page or Session.
      void win.webContents
        .loadURL(
          'data:text/html;charset=utf-8,' +
            encodeURIComponent(
              '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><style>body{font:18px system-ui;padding:48px;line-height:1.8;color:#333;background:#fff}</style><p>网页已关闭，请手动关闭此窗口以继续检查。</p><p>The page has closed. Close this window to recheck.</p>',
            ),
        )
        .catch(() => {})
    }
    const dispose = (userClosed: boolean) => {
      if (closed) return
      closed = true
      if (this.current === handle) this.current = undefined
      input.signal.removeEventListener('abort', abort)
      if (!wc.isDestroyed()) wc.close()
      if (!win.isDestroyed()) win.destroy()
      input.onClosed(userClosed)
    }
    const abort = () => dispose(false)
    const handle: VerificationWindowHandle = { window: win, page, close: abort }
    this.current = handle
    input.signal.addEventListener('abort', abort, { once: true })
    win.on('close', () => {
      userClosing = true
    })
    win.on('closed', () => dispose(userClosing))
    return handle
  }
}
