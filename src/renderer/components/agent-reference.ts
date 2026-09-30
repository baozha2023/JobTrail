import type { AgentDraftPart, AgentReference } from '../../shared/types'

type Translate = (key: string) => string

export function agentReferenceLabel(reference: AgentReference, t: Translate): string {
  if (reference.kind === 'skill' || reference.kind === 'command') return reference.name
  const keys = {
    resume: 'agent.mentionResume',
    opportunity: 'agent.mentionOpportunity',
    company: 'agent.mentionCompany',
    industry: 'agent.mentionIndustry',
  } as const
  return `@${t(keys[reference.kind])} / ${reference.name}`
}

export function agentPartLabel(part: AgentDraftPart, t: Translate): string {
  return part.kind === 'text' ? part.text : agentReferenceLabel(part, t)
}
