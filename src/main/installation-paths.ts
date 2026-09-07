import path from 'node:path'

export const APP_ID = 'zhiji'
export const ROOT_LAUNCHER = 'JobTrail.exe'
export const ROOT_UNINSTALLER = 'JobTrail-Uninstall.exe'

export function resolveStorageRoot(executable: string): string {
  const directory = path.dirname(executable)
  const runtime = path.dirname(directory)
  return path.basename(directory).toLowerCase() === 'current' &&
    path.basename(runtime).toLowerCase() === '.runtime'
    ? path.dirname(runtime)
    : directory
}
