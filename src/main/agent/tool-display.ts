export function toolDisplayArgs(name: string, args: unknown): string {
  if (
    name === 'append_exam_question' &&
    args !== null &&
    typeof args === 'object' &&
    !Array.isArray(args)
  ) {
    const input = args as Record<string, unknown>
    const question = input.question
    if (question !== null && typeof question === 'object' && !Array.isArray(question)) {
      // The model/checkpoint keeps the original call for execution and retries;
      // display history and live events must never expose the stored answer.
      const { defaultAnswer: _defaultAnswer, ...content } = question as Record<string, unknown>
      return JSON.stringify({ ...input, question: content })
    }
  }
  return JSON.stringify(args ?? {})
}
