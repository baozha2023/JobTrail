import { createApp, nextTick, shallowRef } from 'vue'
import ExamPrintDocument from './components/ExamPrintDocument.vue'
import type { ExamPrintDocument as PrintDocument } from '../shared/exams'

const documentData = shallowRef<PrintDocument>()
const application = createApp(ExamPrintDocument, { documentData })
application.config.errorHandler = () => {
  void window.examPrintApi.complete(false).catch(() => {})
}
application.mount('#app')
window.examPrintApi.onDocument(async (data) => {
  try {
    document.documentElement.lang = data.locale
    document.title = data.paper.title
    documentData.value = data
    await nextTick()
    await document.fonts.ready
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    )
    await window.examPrintApi.complete(true)
  } catch {
    await window.examPrintApi.complete(false).catch(() => {})
  }
})
void window.examPrintApi.ready().catch(() => window.examPrintApi.complete(false).catch(() => {}))
