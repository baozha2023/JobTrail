import {
  AIMessage,
  ToolMessage,
  type BaseMessage,
  type MessageContent,
} from '@langchain/core/messages'
import { Tiktoken, getEncodingNameForModel, type TiktokenModel } from 'js-tiktoken/lite'
import gpt2 from 'js-tiktoken/ranks/gpt2'
import cl100k from 'js-tiktoken/ranks/cl100k_base'
import o200k from 'js-tiktoken/ranks/o200k_base'

const ranks = { gpt2, cl100k_base: cl100k, o200k_base: o200k }
const encodings = new Map<string, Tiktoken>()

export function countTextTokens(model: string, content: MessageContent): number {
  let name: keyof typeof ranks = 'gpt2'
  try {
    const known = getEncodingNameForModel(model as TiktokenModel)
    if (known === 'cl100k_base' || known === 'o200k_base') name = known
  } catch {
    // Custom model IDs have no known tokenizer. Their counts remain local estimates.
  }
  let encoding = encodings.get(name)
  if (!encoding) {
    encoding = new Tiktoken(ranks[name])
    encodings.set(name, encoding)
  }
  const text =
    typeof content === 'string'
      ? content
      : content
          .map((part) =>
            typeof part === 'string'
              ? part
              : part.type === 'text' && 'text' in part
                ? part.text
                : '',
          )
          .join('')
  // Literal special-token markers in user content are ordinary text, not control tokens.
  return encoding.encode(text, [], []).length
}

// Only fields sent to the model affect counts and baseline identity. Archive IDs,
// usage, artifacts and other local metadata must not invalidate an unchanged prefix.
export function contextMessage(message: BaseMessage) {
  const type = message.getType()
  return {
    role: type === 'human' ? 'user' : type === 'ai' ? 'assistant' : type,
    content: message.content,
    name: message.name,
    tool_calls:
      message instanceof AIMessage && message.tool_calls?.length
        ? message.tool_calls.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          }))
        : undefined,
    tool_call_id: message instanceof ToolMessage ? message.tool_call_id : undefined,
    function_call: message.additional_kwargs.function_call,
  }
}

export function countMessageTokens(model: string, messages: BaseMessage[]) {
  const count = (text: MessageContent) => countTextTokens(model, text)
  const countPerMessage = messages.map((message) => {
    const wire = contextMessage(message)
    let tokens =
      count(message.content) + count(wire.role) + (model === 'gpt-3.5-turbo-0301' ? 4 : 3)
    if (wire.name) tokens += count(wire.name) + (model === 'gpt-3.5-turbo-0301' ? -1 : 1)
    if (wire.tool_calls) tokens += count(JSON.stringify(wire.tool_calls))
    if (wire.tool_call_id) tokens += count(wire.tool_call_id)
    if (wire.function_call) tokens += count(JSON.stringify(wire.function_call))
    if (Array.isArray(message.content))
      tokens +=
        message.content.filter((part) => typeof part === 'object' && part.type === 'image_url')
          .length * 2048
    return tokens
  })
  return {
    totalCount: 3 + countPerMessage.reduce((total, count) => total + count, 0),
    countPerMessage,
  }
}
