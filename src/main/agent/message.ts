import { HumanMessage } from '@langchain/core/messages'
import { z } from 'zod'
import type { AgentDraftPart, AgentReference } from '../../shared/types'
import type { Services } from '../service-container'
import { AppServiceError } from '../services/errors'

const AgentPartSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string() }),
  z.object({ kind: z.literal('resume'), id: z.number().int().positive(), name: z.string() }),
  z.object({ kind: z.literal('opportunity'), id: z.number().int().positive(), name: z.string() }),
  z.object({ kind: z.literal('company'), id: z.number().int().positive(), name: z.string() }),
  z.object({ kind: z.literal('industry'), id: z.number().int().positive(), name: z.string() }),
  z.object({ kind: z.literal('skill'), name: z.literal('resume-match') }),
  z.object({ kind: z.literal('command'), name: z.literal('compact') }),
])

type DataReference = Extract<AgentReference, { id: number }>

const referenceTags: Record<DataReference['kind'], string> = {
  resume: 'Resume',
  opportunity: 'Opportunity',
  company: 'Company',
  industry: 'Industry',
}

function resolveReference(part: DataReference, services: Services): DataReference {
  switch (part.kind) {
    case 'resume':
      return { kind: part.kind, id: part.id, name: services.resumes.get(part.id).name }
    case 'opportunity': {
      const record = services.opportunities.get(part.id)
      return { kind: part.kind, id: part.id, name: `${record.companyName} · ${record.title}` }
    }
    case 'company':
      return { kind: part.kind, id: part.id, name: services.companies.get(part.id).name }
    case 'industry':
      return { kind: part.kind, id: part.id, name: services.industries.get(part.id).name }
  }
}

export function prepareUserMessage(
  inputParts: AgentDraftPart[],
  attachmentIds: string[],
  services: Services,
  mcpEnabled: boolean,
): { message: HumanMessage; title: string } {
  const parsed = z.array(AgentPartSchema).max(100).safeParse(inputParts)
  if (!parsed.success) throw new AppServiceError('VALIDATION_ERROR', '消息内容格式无效')
  const parsedAttachments = z.array(z.string().uuid()).max(5).safeParse(attachmentIds)
  if (
    !parsedAttachments.success ||
    new Set(parsedAttachments.data).size !== parsedAttachments.data.length
  )
    throw new AppServiceError('VALIDATION_ERROR', '消息附件格式无效')
  const attachments = parsedAttachments.data
  if (parsed.data.some((part) => part.kind === 'command'))
    throw new AppServiceError('VALIDATION_ERROR', '压缩指令须单独执行')
  const parts: AgentDraftPart[] = parsed.data.map((part) => {
    if ('id' in part) {
      if (!mcpEnabled) throw new AppServiceError('VALIDATION_ERROR', 'MCP 连接已关闭')
      return resolveReference(part, services)
    }
    if (part.kind === 'skill' && !mcpEnabled)
      throw new AppServiceError('VALIDATION_ERROR', 'MCP 连接已关闭')
    return part
  })
  const visibleText = parts
    .map((part) =>
      part.kind === 'text' ? part.text : part.kind === 'skill' ? '/resume-match' : `@${part.name}`,
    )
    .join('')
  const prompt = parts
    .map((part) => {
      if (part.kind === 'text') return part.text
      if (part.kind === 'skill') return '[Skill: resume-match]'
      if (part.kind === 'command')
        throw new AppServiceError('VALIDATION_ERROR', '压缩指令须单独执行')
      return `[${referenceTags[part.kind]} reference: ID ${part.id}; name ${part.name}]`
    })
    .join('')
  if ((!visibleText.trim() && !attachments.length) || prompt.length > 30_000)
    throw new AppServiceError('VALIDATION_ERROR', '消息内容或附件数量无效')
  const content = [prompt.trim(), ...attachments.map((attachmentId) => `[附件:${attachmentId}]`)]
    .filter(Boolean)
    .join('\n')
  return {
    title: visibleText.trim().slice(0, 40) || '附件对话',
    message: new HumanMessage({ content, additional_kwargs: { jobtrailParts: parts } }),
  }
}
