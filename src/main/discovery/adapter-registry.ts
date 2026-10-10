import type { JobPlatform } from '../../shared/job-discovery'
import type { PlatformAdapter } from './adapter'
import { bossAdapter } from './adapters/boss'
import { liepinAdapter } from './adapters/liepin'
import { zhilianAdapter } from './adapters/zhilian'
import { wuyouAdapter } from './adapters/wuyou'
import { iguopinAdapter } from './adapters/iguopin'
import { shixisengAdapter } from './adapters/shixiseng'

const adapters = {
  boss: bossAdapter,
  liepin: liepinAdapter,
  zhilian: zhilianAdapter,
  wuyou: wuyouAdapter,
  iguopin: iguopinAdapter,
  shixiseng: shixisengAdapter,
} satisfies Record<JobPlatform, PlatformAdapter>

export function platformAdapter(platform: JobPlatform): PlatformAdapter {
  return adapters[platform]
}
