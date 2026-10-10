import { z } from 'zod'
import {
  startSearchSchema,
  jobDetailSchema,
  saveJobSchema,
  sourceVerificationSchema,
  platformNames,
  type DiscoveryApi,
  type DiscoveredJob,
} from '../../shared/job-discovery'
import { DiscoveryRepository } from './repository'
import type { UnitOfWork } from '../services/unit-of-work'
import type { CompanyService } from '../services/company-service'
import type { OpportunityService } from '../services/opportunity-service'
import { AppServiceError } from '../services/errors'
import { platformAdapter } from './adapter-registry'

export type DiscoveryLive = Pick<
  DiscoveryApi,
  | 'status'
  | 'start'
  | 'continue'
  | 'cancel'
  | 'detail'
  | 'browser'
  | 'region'
  | 'qrLogin'
  | 'verification'
>
export class JobDiscoveryService implements DiscoveryApi {
  live?: DiscoveryLive
  constructor(
    readonly repository: DiscoveryRepository,
    readonly work: UnitOfWork,
    private companies: CompanyService,
    private opportunities: OpportunityService,
  ) {}
  private runtime() {
    if (!this.live)
      throw new AppServiceError('DISCOVERY_UNAVAILABLE', 'Desktop discovery runtime is unavailable')
    return this.live
  }
  async status(check = false) {
    z.boolean().parse(check)
    return check ? this.runtime().status(true) : this.repository.status()
  }
  async start(input: z.input<typeof startSearchSchema>) {
    const parsed = startSearchSchema.parse(input)
    const { city, platforms } = parsed.query
    if (city) {
      const cities = platforms.map((platform) => platformAdapter(platform).cities.find(city))
      const first = cities[0]
      if (!first || cities.some((item) => !item || item.name !== first.name))
        throw new AppServiceError(
          'DISCOVERY_UNSUPPORTED_CITY',
          'City is not shared by selected platforms',
          {
            city,
            platforms,
          },
        )
    }
    return this.runtime().start(parsed)
  }
  async run(id: string) {
    return this.repository.run(id)
  }
  async list(input: Parameters<DiscoveryApi['list']>[0]) {
    return this.work.run(() => this.repository.list(input))
  }
  async continue(id: string) {
    z.string().uuid().parse(id)
    return this.runtime().continue(id)
  }
  async cancel(id: string) {
    z.string().uuid().parse(id)
    return this.runtime().cancel(id)
  }
  async detail(input: Parameters<DiscoveryApi['detail']>[0]) {
    const args = jobDetailSchema.parse(input)
    if (args.mode === 'refresh') return this.runtime().detail(args)
    const snapshot = this.repository.get(args.jobId, args.runId, args.observationId, args.viewId)
    if (args.mode === 'snapshot') return snapshot
    const current = this.repository.get(args.jobId)
    if (current.detailReadAt !== null && Date.now() - current.detailReadAt < 1800000)
      return this.work.run(() => {
        if (args.runId)
          this.repository.reuseObservation(args.runId, args.jobId, current.observationId)
        return {
          ...current,
          removedFromCurrentSearch:
            !!args.runId && !this.repository.contains(args.runId, args.jobId),
        }
      })
    return this.runtime().detail(args)
  }
  async history(page: number) {
    return this.repository.history(page)
  }
  async removeHistory(ids: string[]) {
    this.work.run(() => this.repository.remove(ids))
  }
  async qrLogin(input: Parameters<DiscoveryApi['qrLogin']>[0]) {
    return this.runtime().qrLogin(input)
  }
  async verification(input: Parameters<DiscoveryApi['verification']>[0]) {
    return this.runtime().verification(sourceVerificationSchema.parse(input))
  }
  async browser(input: Parameters<DiscoveryApi['browser']>[0]) {
    return this.runtime().browser(input)
  }
  async region(input: Parameters<DiscoveryApi['region']>[0]) {
    return this.runtime().region(input)
  }
  async save(input: z.input<typeof saveJobSchema>) {
    return this.saveSync(input)
  }
  savePreview(input: z.input<typeof saveJobSchema>) {
    const args = saveJobSchema.parse(input)
    return {
      entityType: 'opportunity',
      before: {
        job: this.repository.get(args.jobId, undefined, args.observationId),
        company: args.companyId ? this.companies.get(args.companyId) : null,
      },
      after: args,
    }
  }
  saveSync(input: z.input<typeof saveJobSchema>) {
    const args = saveJobSchema.parse(input)
    return this.work.run(() => {
      const existing = this.repository.saved(args.jobId)
      if (existing) return { opportunityId: existing, alreadySaved: true }
      const job: DiscoveredJob = this.repository.get(args.jobId, undefined, args.observationId)
      const companyId =
        args.companyId ??
        this.companies.create({ name: args.newCompanyName!, industryIds: [], locations: [] }).id
      const opportunity = this.opportunities.create({
        companyId,
        title: job.title,
        department: null,
        location: job.city || null,
        source: platformNames[job.platform],
        jobUrl: job.url,
        description: job.jd || null,
        statusId: args.statusId,
        resumeVersionId: args.resumeVersionId ?? null,
        discoveredAt: job.readAt,
        appliedAt: null,
        deadlineAt: null,
        notes: null,
      })
      this.repository.link(job, opportunity.id)
      return { opportunityId: opportunity.id, alreadySaved: false }
    })
  }
}
