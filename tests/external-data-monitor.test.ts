import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AppPaths } from '../src/main/config'
import { ExternalDataMonitor } from '../src/main/external-data-monitor'
import { createServiceContainer } from '../src/main/service-container'

describe('external data monitor', () => {
  it('detects commits from the MCP database connection without reacting to its own connection', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtrail-monitor-'))
    const paths: AppPaths = {
      root,
      config: path.join(root, 'config.json'),
      data: path.join(root, 'data'),
      database: path.join(root, 'data', 'zhiji.db'),
      resumes: path.join(root, 'resumes'),
    }
    const desktop = createServiceContainer(paths, false)
    const mcp = createServiceContainer(paths, false)
    const onChange = vi.fn()
    const monitor = new ExternalDataMonitor(desktop.database, onChange)
    try {
      expect(monitor.checkNow()).toBe(false)
      desktop.services.statuses.create({ label: '桌面本地写入' })
      expect(monitor.checkNow()).toBe(false)
      mcp.services.statuses.create({ label: 'MCP 外部写入' })
      expect(monitor.checkNow()).toBe(true)
      expect(onChange).toHaveBeenCalledOnce()
      expect(desktop.services.statuses.list().some((item) => item.label === 'MCP 外部写入')).toBe(
        true,
      )
    } finally {
      mcp.database.close()
      desktop.database.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
