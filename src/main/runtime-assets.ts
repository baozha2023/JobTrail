import path from 'node:path'

export function resolveDesktopAssets(appPath: string): {
  preload: string
  renderer: string
} {
  return {
    preload: path.join(appPath, 'out', 'preload', 'index.js'),
    renderer: path.join(appPath, 'out', 'renderer', 'index.html'),
  }
}
