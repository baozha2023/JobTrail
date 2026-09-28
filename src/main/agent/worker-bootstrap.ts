import { DOMMatrix, ImageData, Path2D } from '@napi-rs/canvas'

// pdf-parse evaluates PDF.js during module loading. Utility processes do not
// inherit the DOM geometry globals available in Electron's main process.
Object.assign(globalThis, { DOMMatrix, ImageData, Path2D })

void import('./worker').catch((error: unknown) => {
  console.error('智能体执行进程无法启动', error)
  process.exit(1)
})
