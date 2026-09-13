import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  createRollbackPoint,
  preserveRollbackPackage,
  sha256File,
} from '../src/main/update-rollback'

const temporaryRoots: string[] = []
afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    const target = path.resolve(root)
    if (
      path.dirname(target) !== path.resolve(os.tmpdir()) ||
      !path.basename(target).startsWith('jobtrail-rollback-test-')
    )
      throw new Error('Unexpected rollback test directory')
    await fs.rm(target, { recursive: true, force: true })
  }
})

async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jobtrail-rollback-test-'))
  temporaryRoots.push(root)
  await fs.mkdir(path.join(root, '.runtime', 'packages'), { recursive: true })
  await fs.mkdir(path.join(root, 'data'), { recursive: true })
  await fs.writeFile(path.join(root, '.runtime', 'packages', 'zhiji-0.4.0-full.nupkg'), 'old-full')
  await fs.writeFile(path.join(root, 'config.json'), '{"configVersion":1}')
  await fs.writeFile(path.join(root, 'data', 'zhiji.db'), 'live-database')
  await fs.writeFile(path.join(root, 'data', 'notes.txt'), 'other-data')
  return root
}

describe('update rollback point', () => {
  it('preserves the exact old Full and a consistent database image before applying', async () => {
    const root = await fixture()
    const versions = { dataRoot: root, sourceVersion: '0.4.0', targetVersion: '0.5.0' }
    await preserveRollbackPackage(versions)
    await createRollbackPoint({
      ...versions,
      snapshotDatabase: async (destination) => fs.writeFile(destination, 'sqlite-online-backup'),
    })
    const rollback = path.join(root, '.runtime', 'rollback')
    const state = JSON.parse(await fs.readFile(path.join(rollback, 'rollback-state.json'), 'utf8'))
    expect(state.format).toBe('jobtrail-rollback-state')
    expect(state.packageSha256).toBe(await sha256File(path.join(rollback, state.packageFile)))
    expect(await fs.readFile(path.join(rollback, 'config.json'), 'utf8')).toBe(
      '{"configVersion":1}',
    )
    expect(await fs.readFile(path.join(rollback, 'data', 'zhiji.db'), 'utf8')).toBe(
      'sqlite-online-backup',
    )
    expect(await fs.readFile(path.join(rollback, 'data', 'notes.txt'), 'utf8')).toBe('other-data')
    await expect(fs.stat(path.join(root, '.runtime', 'rollback-package'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('does not publish a rollback point when the database snapshot fails', async () => {
    const root = await fixture()
    const versions = { dataRoot: root, sourceVersion: '0.4.0', targetVersion: '0.5.0' }
    await preserveRollbackPackage(versions)
    await expect(
      createRollbackPoint({
        ...versions,
        snapshotDatabase: async () => {
          throw new Error('snapshot failed')
        },
      }),
    ).rejects.toThrow('snapshot failed')
    await expect(fs.stat(path.join(root, '.runtime', 'rollback'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(await fs.readFile(path.join(root, 'data', 'zhiji.db'), 'utf8')).toBe('live-database')
  })
})
