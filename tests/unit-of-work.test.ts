import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppPaths } from '../src/main/config'
import { createServiceContainer } from '../src/main/service-container'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrail-unit-of-work-'))
  roots.push(root)
  const paths: AppPaths = {
    root,
    config: path.join(root, 'config.json'),
    data: path.join(root, 'data'),
    database: path.join(root, 'data', 'zhiji.db'),
    resumes: path.join(root, 'resumes'),
  }
  return { root, paths, container: createServiceContainer(paths, false) }
}

describe('service unit of work', () => {
  it('rolls back service writes when an outer operation fails', () => {
    const { container } = fixture()
    try {
      expect(() =>
        container.unitOfWork.run(() => {
          container.services.statuses.create({ label: '不应提交' })
          throw new Error('取消整个工作单元')
        }),
      ).toThrow('取消整个工作单元')
      expect(container.services.statuses.list().some((item) => item.label === '不应提交')).toBe(
        false,
      )
    } finally {
      container.database.close()
    }
  })

  it('holds the write lock before executing validation and mutation code', () => {
    const { paths, container } = fixture()
    const secondary = createServiceContainer(paths, false)
    secondary.database.db.pragma('busy_timeout = 0')
    try {
      container.unitOfWork.run(() => {
        expect(() => secondary.services.statuses.create({ label: '并发写入' })).toThrow(/locked/i)
      })
      expect(secondary.services.statuses.create({ label: '锁释放后写入' }).label).toBe(
        '锁释放后写入',
      )
    } finally {
      secondary.database.close()
      container.database.close()
    }
  })

  it('isolates a failed nested operation when its caller continues', () => {
    const { container } = fixture()
    const lifecycleEvents: string[] = []
    try {
      container.unitOfWork.run(() => {
        try {
          container.unitOfWork.run((lifecycle) => {
            lifecycle.afterCommit(() => lifecycleEvents.push('commit'))
            lifecycle.afterRollback(() => lifecycleEvents.push('rollback'))
            container.services.statuses.create({ label: '嵌套回滚' })
            throw new Error('嵌套操作失败')
          })
        } catch {
          container.services.statuses.create({ label: '外层继续' })
        }
      })
      expect(container.services.statuses.list().some((item) => item.label === '嵌套回滚')).toBe(
        false,
      )
      expect(container.services.statuses.list().some((item) => item.label === '外层继续')).toBe(
        true,
      )
      expect(lifecycleEvents).toEqual(['rollback'])
    } finally {
      container.database.close()
    }
  })

  it('rejects asynchronous callbacks before committing their writes', () => {
    const { container } = fixture()
    try {
      expect(() =>
        container.unitOfWork.run(() => {
          container.services.statuses.create({ label: '异步回滚' })
          return Promise.resolve()
        }),
      ).toThrow('只允许同步操作')
      expect(container.services.statuses.list().some((item) => item.label === '异步回滚')).toBe(
        false,
      )
    } finally {
      container.database.close()
    }
  })

  it('removes an imported resume file when the outer transaction rolls back', () => {
    const { root, paths, container } = fixture()
    const source = path.join(root, 'resume.pdf')
    fs.writeFileSync(source, 'resume')
    try {
      expect(() =>
        container.unitOfWork.run(() => {
          container.services.resumes.importFromPath(source)
          throw new Error('回滚导入')
        }),
      ).toThrow('回滚导入')
      expect(container.services.resumes.list()).toEqual([])
      expect(fs.readdirSync(paths.resumes)).toEqual([])
    } finally {
      container.database.close()
    }
  })

  it('restores a staged resume file when the outer transaction rolls back', () => {
    const { root, container } = fixture()
    const source = path.join(root, 'resume.pdf')
    fs.writeFileSync(source, 'resume')
    try {
      const resume = container.services.resumes.importFromPath(source)
      const managedPath = container.services.resumes.getPath(resume.id)
      expect(() =>
        container.unitOfWork.run(() => {
          container.services.resumes.delete(resume.id)
          expect(fs.existsSync(managedPath)).toBe(false)
          throw new Error('回滚删除')
        }),
      ).toThrow('回滚删除')
      expect(container.services.resumes.get(resume.id).id).toBe(resume.id)
      expect(fs.readFileSync(managedPath, 'utf8')).toBe('resume')
    } finally {
      container.database.close()
    }
  })
})
