import { dialog, shell } from 'electron'
import type { Services } from '../service-container'
import { AppServiceError } from '../services/errors'
import { registerChannel } from './register-channel'
import { ids, numberValue, parseResumeUpdate } from './validators'

export function registerResumeIpc(services: Services): void {
  registerChannel('resumes:list', () => services.resumes.list())
  registerChannel('resumes:get', (id) => services.resumes.get(numberValue(id, '简历版本 ID') as number))
  registerChannel('resumes:import', async () => {
    const selected = await dialog.showOpenDialog({ title: '导入简历', properties: ['openFile'], filters: [{ name: '简历文件', extensions: ['pdf', 'doc', 'docx'] }] })
    if (selected.canceled || selected.filePaths.length === 0) return null
    return services.resumes.importFromPath(selected.filePaths[0])
  })
  registerChannel('resumes:open', async (id) => {
    const result = await shell.openPath(services.resumes.getPath(numberValue(id, '简历版本 ID') as number))
    if (result) throw new AppServiceError('FILE_OPEN_FAILED', result)
  })
  registerChannel('resumes:update', (id, input) => services.resumes.update(numberValue(id, '简历版本 ID') as number, parseResumeUpdate(input)))
  registerChannel('resumes:reorder', (order) => services.resumes.reorder(ids(order, '简历版本顺序')))
  registerChannel('resumes:delete', (id) => services.resumes.delete(numberValue(id, '简历版本 ID') as number))
}
