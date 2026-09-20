import type { AgentDraftPart, AgentReference } from '../../shared/types'

type Translate = (key: string) => string

export function agentReferenceLabel(reference: AgentReference, t: Translate): string {
  if (reference.kind === 'skill') return `/${t('agent.skillMatch')}`
  if (reference.kind === 'command') return '/compact'
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
