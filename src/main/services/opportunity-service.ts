import type {
  CreateOpportunityInput,
  Opportunity,
  OpportunityQuery,
  OpportunityStatusFlow,
  UpdateOpportunityInput,
} from '../../shared/types'
import { CompanyRepository } from '../repositories/company-repository'
import { OpportunityRepository } from '../repositories/opportunity-repository'
import { OpportunityStatusEventRepository } from '../repositories/opportunity-status-event-repository'
import { ResumeRepository } from '../repositories/resume-repository'
import { StatusRepository } from '../repositories/status-repository'
import {
  AppServiceError,
  assertFiniteInteger,
  assertNonEmptyUpdate,
  assertPositiveId,
  nullableText,
} from './errors'
import type { UnitOfWork } from './unit-of-work'

type CompleteOpportunityInput = CreateOpportunityInput

export class OpportunityService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly repository: OpportunityRepository,
    private readonly statusEvents: OpportunityStatusEventRepository,
    private readonly companies: CompanyRepository,
    private readonly statuses: StatusRepository,
    private readonly resumes: ResumeRepository,
  ) {}
  list(query: OpportunityQuery): Opportunity[] {
    if (query.statusId !== null && query.statusId !== undefined)
      assertPositiveId(query.statusId, '状态 ID')
    if (query.companyId !== null && query.companyId !== undefined)
      assertPositiveId(query.companyId, '公司 ID')
    return this.repository
      .list({ ...query, search: query.search?.trim() })
      .map((row) => this.repository.map(row))
  }
  get(id: number): Opportunity {
    assertPositiveId(id, '求职记录 ID')
    const row = this.repository.get(id)
    if (!row) throw new AppServiceError('NOT_FOUND', '求职记录不存在')
    return this.repository.map(row)
  }
  statusFlow(id: number): OpportunityStatusFlow {
    const opportunity = this.get(id)
    return { opportunity, events: this.statusEvents.list(id) }
  }
  create(input: CreateOpportunityInput): Opportunity {
    return this.unitOfWork.run(() => {
      const normalized = this.normalize(input)
      const statusLabel = this.validate(normalized)
      const timestamp = Date.now()
      const id = this.repository.create(normalized, timestamp)
      this.statusEvents.create(id, normalized.statusId, statusLabel, timestamp, 'created')
      return this.get(id)
    })
  }
  update(id: number, input: UpdateOpportunityInput): Opportunity {
    return this.unitOfWork.run(() => {
      assertNonEmptyUpdate(input, '求职记录')
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
        resumeVersionId:
          input.resumeVersionId === undefined ? current.resumeVersionId : input.resumeVersionId,
        discoveredAt: input.discoveredAt === undefined ? current.discoveredAt : input.discoveredAt,
        appliedAt: input.appliedAt === undefined ? current.appliedAt : input.appliedAt,
        deadlineAt: input.deadlineAt === undefined ? current.deadlineAt : input.deadlineAt,
        notes: input.notes === undefined ? current.notes : input.notes,
      })
      const statusLabel = this.validate(normalized)
      const timestamp = Date.now()
      this.repository.update(id, normalized, timestamp)
      if (normalized.statusId !== current.statusId)
        this.statusEvents.create(id, normalized.statusId, statusLabel, timestamp, 'changed')
      return this.get(id)
    })
  }
  changeStatus(id: number, statusId: number): Opportunity {
    return this.unitOfWork.run(() => {
      const current = this.get(id)
      const statusLabel = this.requireStatus(statusId)
      if (current.statusId === statusId) return current
      const timestamp = Date.now()
      this.repository.changeStatus(id, statusId, timestamp)
      this.statusEvents.create(id, statusId, statusLabel, timestamp, 'changed')
      return this.get(id)
    })
  }
  delete(id: number): void {
    this.unitOfWork.run(() => {
      this.get(id)
      if (this.repository.delete(id, Date.now()) === 0)
        throw new AppServiceError('NOT_FOUND', '求职记录不存在')
      this.statusEvents.deleteForOpportunity(id)
    })
  }
  private normalize(input: CompleteOpportunityInput): CompleteOpportunityInput {
    return {
      ...input,
      title: input.title.trim(),
      department: nullableText(input.department),
      location: nullableText(input.location),
      source: nullableText(input.source),
      jobUrl: nullableText(input.jobUrl),
      description: nullableText(input.description),
      notes: nullableText(input.notes),
    }
  }
  private validate(input: CompleteOpportunityInput): string {
    assertPositiveId(input.companyId, '公司 ID')
    if (!input.title) throw new AppServiceError('VALIDATION_ERROR', '岗位名称不能为空')
    if (!this.companies.get(input.companyId))
      throw new AppServiceError('VALIDATION_ERROR', '公司不存在')
    const statusLabel = this.requireStatus(input.statusId)
    if (input.resumeVersionId !== null && input.resumeVersionId !== undefined) {
      assertPositiveId(input.resumeVersionId, '简历版本 ID')
      if (!this.resumes.get(input.resumeVersionId))
        throw new AppServiceError('VALIDATION_ERROR', '简历版本不存在')
    }
    for (const [value, field] of [
      [input.discoveredAt, '发现时间'],
      [input.appliedAt, '投递时间'],
      [input.deadlineAt, '截止时间'],
    ] as const) {
      if (value !== null && value !== undefined) assertFiniteInteger(value, field)
    }
    return statusLabel
  }
  private requireStatus(id: number): string {
    assertPositiveId(id, '状态 ID')
    const status = this.statuses.get(id)
    if (!status) throw new AppServiceError('VALIDATION_ERROR', '状态不存在')
    return status.label
  }
}
