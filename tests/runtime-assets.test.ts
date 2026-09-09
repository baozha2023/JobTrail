import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveDesktopAssets } from '../src/main/runtime-assets'

describe('desktop runtime assets', () => {
  it('resolves preload and renderer from the app root instead of a dynamic chunk', () => {
    const root = path.resolve('virtual-app-root')
    expect(resolveDesktopAssets(root)).toEqual({
      preload: path.join(root, 'out', 'preload', 'index.js'),
      renderer: path.join(root, 'out', 'renderer', 'index.html'),
    })
  })
})
