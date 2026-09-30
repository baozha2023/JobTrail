const examToolNames = [
  'create_exam_paper',
  'update_exam_paper',
  'append_exam_question',
  'get_exam_paper',
  'complete_exam_paper',
] as const

export type ExamToolName = (typeof examToolNames)[number]

export function isExamTool(name: string | undefined): name is ExamToolName {
  return examToolNames.some((tool) => tool === name)
}
