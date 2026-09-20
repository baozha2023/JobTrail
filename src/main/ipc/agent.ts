import { dialog } from 'electron'
import type { AgentService } from '../agent/service'
import { registerChannel } from './register-channel'

export function registerAgentIpc(agent: AgentService): void {
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
  registerChannel('agent:remove-upload', (id, attachmentId) => agent.removeUpload(id, attachmentId))
  registerChannel('agent:send', (id, parts, attachmentIds) => agent.send(id, parts, attachmentIds))
  registerChannel('agent:compact', (id) => agent.compact(id))
  registerChannel('agent:resume', (id, answer) => agent.resume(id, answer))
  registerChannel('agent:cancel', (id) => agent.cancel(id))
  registerChannel('agent:save-settings', (ai) => agent.saveSettings(ai))
}
