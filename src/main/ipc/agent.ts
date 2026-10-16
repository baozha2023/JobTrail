import { dialog, shell } from 'electron'
import { z } from 'zod'
import type { AgentCoordinator } from '../agent/coordinator'
import { AppServiceError } from '../services/errors'
import { registerChannel } from './register-channel'

export function registerAgentIpc(agent: AgentCoordinator): void {
  registerChannel('agent:list', () => agent.list())
  registerChannel('agent:create', () => agent.create())
  registerChannel('agent:history', (id) => agent.history(id))
  registerChannel('agent:rename', (id, title) => agent.rename(id, title))
  registerChannel('agent:delete', (id) => agent.delete(id))
  registerChannel('agent:upload', async (id) => {
    const selected = await dialog.showOpenDialog({
      title: '上传聊天附件',
      properties: ['openFile'],
      filters: [
        {
          name: '文档与图片',
          extensions: ['pdf', 'doc', 'docx', 'txt', 'md', 'png', 'jpg', 'jpeg', 'webp'],
        },
      ],
    })
    if (selected.canceled || !selected.filePaths[0]) return null
    return agent.upload(id, selected.filePaths[0])
  })
  registerChannel('agent:upload-bytes', (id, name, mimeType, bytes) =>
    agent.uploadBytes(id, name, mimeType, bytes),
  )
  registerChannel('agent:preview', (id, attachmentId) => agent.preview(id, attachmentId))
  registerChannel('agent:open-attachment', async (id, attachmentId) => {
    const result = await shell.openPath(agent.getAttachmentPath(id, attachmentId))
    if (result) throw new AppServiceError('FILE_OPEN_FAILED', '聊天附件打开失败')
  })
  registerChannel('agent:remove-upload', (id, attachmentId) => agent.removeUpload(id, attachmentId))
  registerChannel('agent:send', (id, parts, attachmentIds, jobId) =>
    agent.send(id, parts, attachmentIds, jobId),
  )
  registerChannel('agent:compact', (id, jobId) => agent.compact(id, jobId))
  registerChannel('agent:resume', (id, answer, jobId) => agent.resume(id, answer, jobId))
  registerChannel('agent:cancel', (id, jobId) => {
    z.string().uuid().parse(id)
    if (jobId !== undefined) z.string().uuid().parse(jobId)
    agent.cancel(id, jobId)
  })
  registerChannel('agent:queue-edit', (id, edit) => {
    z.string().uuid().parse(id)
    return agent.editQueue(id, edit)
  })
  registerChannel('agent:queue-release-edits', () => agent.releaseQueueEdits())
  registerChannel('agent:queue-reconcile', (id) => {
    z.string().uuid().parse(id)
    return agent.reconcileQueue(id)
  })
  registerChannel('agent:submission', (id, jobId) => agent.submission(id, jobId))
  registerChannel('agent:notify-discovery', (id, target, jobId) =>
    agent.notifyDiscovery(id, target, jobId),
  )
  registerChannel('agent:save-settings', (ai) => agent.saveSettings(ai))
}
