import type { CreateOpportunityInput, Opportunity, OpportunityQuery, UpdateOpportunityInput } from '../../shared/types'
import { CompanyRepository } from '../repositories/company-repository'
import { OpportunityRepository } from '../repositories/opportunity-repository'
import { ResumeRepository } from '../repositories/resume-repository'
import { StatusRepository } from '../repositories/status-repository'
import { AppServiceError, assertFiniteInteger, assertPositiveId, nullableText } from './errors'

type CompleteOpportunityInput = CreateOpportunityInput

export class OpportunityService {
  constructor(
    private readonly repository: OpportunityRepository,
    private readonly companies: CompanyRepository,
    private readonly statuses: StatusRepository,
    private readonly resumes: ResumeRepository,
  ) {}
  list(query: OpportunityQuery): Opportunity[] { return this.repository.list({ ...query, search: query.search?.trim() }).map((row) => this.repository.map(row)) }
  get(id: number): Opportunity {
    assertPositiveId(id, '求职记录 ID')
    const row = this.repository.get(id)
    if (!row) throw new AppServiceError('NOT_FOUND', '求职记录不存在')
    return this.repository.map(row)
  }
  create(input: CreateOpportunityInput): Opportunity {
    const normalized = this.normalize(input)
    this.validate(normalized)
    return this.get(this.repository.create(normalized, Date.now()))
  }
  update(id: number, input: UpdateOpportunityInput): Opportunity {
    const current = this.get(id)
    const normalized = this.normalize({
      companyId: input.companyId ?? current.companyId,
      title: input.title ?? current.title,
      department: input.department === undefined ? current.department : input.department,
      location: input.location === undefined ? current.location : input.location,
      source: input.source === undefined ? current.source : input.source,
      jobUrl: input.jobUrl === undefined ? current.jobUrl : input.jobUrl,
      description: input.description === undefined ? current.description : input.description,
      statusId: input.statusId ?? current.statusId,
      resumeVersionId: input.resumeVersionId === undefined ? current.resumeVersionId : input.resumeVersionId,
      discoveredAt: input.discoveredAt === undefined ? current.discoveredAt : input.discoveredAt,
      appliedAt: input.appliedAt === undefined ? current.appliedAt : input.appliedAt,
      deadlineAt: input.deadlineAt === undefined ? current.deadlineAt : input.deadlineAt,
      notes: input.notes === undefined ? current.notes : input.notes,
    })
    this.validate(normalized)
    this.repository.update(id, normalized, Date.now())
    return this.get(id)
  }
  changeStatus(id: number, statusId: number): Opportunity {
    this.get(id)
    this.requireStatus(statusId)
    this.repository.changeStatus(id, statusId, Date.now())
    return this.get(id)
  }
  delete(id: number): void {
    this.get(id)
    if (this.repository.delete(id) === 0) throw new AppServiceError('NOT_FOUND', '求职记录不存在')
  }
  private normalize(input: CompleteOpportunityInput): CompleteOpportunityInput {
    return {
      ...input,
      title: input.title.trim(),
      department: nullableText(input.department), location: nullableText(input.location), source: nullableText(input.source),
      jobUrl: nullableText(input.jobUrl), description: nullableText(input.description), notes: nullableText(input.notes),
    }
  }
  private validate(input: CompleteOpportunityInput): void {
    assertPositiveId(input.companyId, '公司 ID')
    if (!input.title) throw new AppServiceError('VALIDATION_ERROR', '岗位名称不能为空')
    if (!this.companies.get(input.companyId)) throw new AppServiceError('VALIDATION_ERROR', '公司不存在')
    this.requireStatus(input.statusId)
    if (input.resumeVersionId !== null && input.resumeVersionId !== undefined) {
      assertPositiveId(input.resumeVersionId, '简历版本 ID')
      if (!this.resumes.get(input.resumeVersionId)) throw new AppServiceError('VALIDATION_ERROR', '简历版本不存在')
    }
    for (const [value, field] of [[input.discoveredAt, '发现时间'], [input.appliedAt, '投递时间'], [input.deadlineAt, '截止时间']] as const) {
      if (value !== null && value !== undefined) assertFiniteInteger(value, field)
    }
  }
  private requireStatus(id: number): void {
    assertPositiveId(id, '状态 ID')
    if (!this.statuses.get(id)) throw new AppServiceError('VALIDATION_ERROR', '状态不存在')
  }
}

