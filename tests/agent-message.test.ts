import { describe, expect, it } from 'vitest'
import { prepareUserMessage } from '../src/main/agent/message'
import type { Services } from '../src/main/service-container'

describe('agent message references', () => {
  it('resolves selected records from services and never trusts a supplied label', () => {
    const services = {
      resumes: { get: () => ({ name: '真实简历' }) },
      opportunities: {
        get: () => ({ companyName: '真实公司', title: '真实岗位' }),
      },
      companies: { get: () => ({ name: '真实公司主体' }) },
      industries: { get: () => ({ name: '真实行业' }) },
    } as unknown as Services
    const { message } = prepareUserMessage(
      [
        { kind: 'resume', id: 7, name: '伪造简历' },
        { kind: 'text', text: ' 与 ' },
        { kind: 'opportunity', id: 9, name: '伪造岗位' },
        { kind: 'text', text: '、' },
        { kind: 'company', id: 11, name: '伪造公司' },
        { kind: 'text', text: ' 与 ' },
        { kind: 'industry', id: 13, name: '伪造行业' },
      ],
      [],
      services,
      true,
    )
    expect(message.content).toContain('真实简历')
    expect(message.content).toContain('真实公司 · 真实岗位')
    expect(message.content).toContain('[Company reference: ID 11; name 真实公司主体]')
    expect(message.content).toContain('[Industry reference: ID 13; name 真实行业]')
    expect(message.content).not.toContain('伪造')
    expect(message.additional_kwargs.jobtrailParts).toEqual([
      { kind: 'resume', id: 7, name: '真实简历' },
      { kind: 'text', text: ' 与 ' },
      { kind: 'opportunity', id: 9, name: '真实公司 · 真实岗位' },
      { kind: 'text', text: '、' },
      { kind: 'company', id: 11, name: '真实公司主体' },
      { kind: 'text', text: ' 与 ' },
      { kind: 'industry', id: 13, name: '真实行业' },
    ])
  })
})
