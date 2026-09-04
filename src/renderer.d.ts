import type { JobTrailApi, VelopackApi, WindowControlsApi } from './shared/types'

declare global {
  interface Window {
    jobTrailApi: JobTrailApi
    velopackApi: VelopackApi
    windowControlsApi: WindowControlsApi
  }
}

export {}
