import type { ExamService } from '../services/exam-service'
import type { ExamGrader } from '../agent/exam-grader'
import { registerChannel, sendToTrustedWindow } from './register-channel'
import type { ExamPdfExporter } from '../exam-pdf-exporter'
export function registerExamIpc(
  exams: ExamService,
  grader: ExamGrader,
  exporter: ExamPdfExporter,
): void {
  registerChannel('exams:export-pdf', (input) => exporter.export(input))
  registerChannel('exams:get', (input) => exams.get(input))
  registerChannel('exams:save', (input) => {
    const paper = exams.save(input)
    grader.cancelInvalid()
    sendToTrustedWindow('exams:changed', input)
    return paper
  })
  registerChannel('exams:submit', (input) => {
    const paper = exams.submit(input)
    sendToTrustedWindow('exams:changed', input)
    return paper
  })
  registerChannel('exams:reset', (input) => {
    const paper = exams.reset(input)
    grader.cancelInvalid()
    sendToTrustedWindow('exams:changed', input)
    return paper
  })
  registerChannel('exams:grade', (input) => grader.submit(input))
}
